import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { generateJobPosting, generateScoutText } from "./openai.js";
import { sanitizeJobPosting } from "./sanitize.js";
import { normalizeRawText, hasFixedOvertimeKeywords, mergeBlockquoteSections } from "./extract.js";
import { renderJobDocx, resolveTemplatePath, getTemplateStat } from "./word.js";
import { JobPosting } from "./schema.js";
import {
  faithfulnessCheck,
  requiredFieldsCheck,
  optionalFieldWarnings,
  toFaithfulnessErrors,
  type RequiredFieldsResult,
  type FaithfulnessResult,
  type FaithfulnessMissing,
} from "./validate.js";
import {
  normalizeCompanyName,
  resolveCompanyKey,
  resolveCompanyKeyWithHints,
  resolveDisplayName,
  getDisplayCompanyName,
  mergeCompanyStatic,
  applyCompanyDefaults,
  loadFieldAliases,
  type MergeResult,
  type DefaultsResult,
} from "./company.js";

const ENABLE_COMPANY_STATIC = process.env.ENABLE_COMPANY_STATIC === "true" || process.env.ENABLE_COMPANY_STATIC === "1";

/**
 * STRICT_NO_PARAPHRASE: true → 言い換え検出があれば即停止（厳格モード）
 *                        false (デフォルト) → 警告のみで処理続行
 */
const STRICT_NO_PARAPHRASE = process.env.STRICT_NO_PARAPHRASE === "true" || process.env.STRICT_NO_PARAPHRASE === "1";

const log = (tag: string, msg: string, data?: Record<string, unknown>) => {
  console.log(`[${tag}] ${msg}`, data ?? "");
};

// ---------------------------------------------------------------------------
// ネストされたオブジェクトの値取得/設定 (dot-path: "work.location" 等)
// ---------------------------------------------------------------------------
const getNestedValue = (obj: Record<string, unknown>, dotPath: string): unknown => {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const setNestedValue = (obj: Record<string, unknown>, dotPath: string, value: unknown): void => {
  const parts = dotPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
};

// ---------------------------------------------------------------------------
// evidence 検証: rawText 内に evidence が含まれていなければ項目を無効化
// ---------------------------------------------------------------------------
const normalizeForEvidence = (s: string): string =>
  s.replace(/[\r\n\t\u3000]/g, " ")
   .replace(/\s+/g, " ")
   .replace(/：/g, ":")
   .replace(/（/g, "(")
   .replace(/）/g, ")")
   .trim();

type EvidenceSpec = {
  fieldLabel: string;
  evidence: string | undefined;
  getValue: () => string;
  clearValue: () => void;
};

const validateEvidence = (
  job: JobPosting,
  normalizedText: string,
  skipFields?: Set<string>,
  sections?: Array<{ label: string; value: string }>
): { warnings: string[] } => {
  const warnings: string[] = [];
  const rawNorm = normalizeForEvidence(normalizedText);

  const specs: EvidenceSpec[] = [
    {
      fieldLabel: "company.name",
      evidence: job.company.nameEvidence,
      getValue: () => job.company.name,
      clearValue: () => { job.company.name = ""; },
    },
    {
      fieldLabel: "position.title",
      evidence: job.position.titleEvidence,
      getValue: () => job.position.title,
      clearValue: () => {
        // evidenceがrawTextに見つからない場合は無条件でクリアする
        // titleEvidenceが存在しても、rawTextに存在しない値は信頼しない
        log("evidence", "position.title: evidence not found in rawText, clearing title");
        job.position.title = "";
      },
    },
    {
      fieldLabel: "position.employmentType",
      evidence: job.position.employmentTypeEvidence,
      getValue: () => job.position.employmentType ?? "",
      clearValue: () => { job.position.employmentType = ""; },
    },
    {
      fieldLabel: "position.contractTerm",
      evidence: job.position.contractTermEvidence,
      getValue: () => job.position.contractTerm ?? "",
      clearValue: () => { job.position.contractTerm = ""; },
    },
    {
      fieldLabel: "work.location",
      evidence: job.work.locationEvidence,
      getValue: () => job.work.location ?? "",
      clearValue: () => { job.work.location = ""; },
    },
    {
      fieldLabel: "salary.summary",
      evidence: job.salary.summaryEvidence,
      getValue: () => job.salary.summary,
      clearValue: () => { job.salary.summary = ""; },
    },
  ];

  for (const spec of specs) {
    if (skipFields?.has(spec.fieldLabel)) continue; // DOM sections 優先取得済み → スキップ

    const value = spec.getValue();
    if (!value?.trim()) continue; // 値が空またはundefinedならチェック不要

    const ev = (spec.evidence ?? "").trim();
    if (!ev) {
      // evidence 未提供なのに値がある → 信頼できない
      log("evidence", `EVIDENCE_MISSING: ${spec.fieldLabel} (no evidence provided)`);
      warnings.push(`EVIDENCE_MISSING: ${spec.fieldLabel}`);
      spec.clearValue();
      continue;
    }

    const evNorm = normalizeForEvidence(ev);

    // rawText に存在すれば OK
    if (rawNorm.includes(evNorm)) continue;

    // sections（DOM由来）にも問い合わせ（HRMOS 等の DOM 優先抽出対応）
    if (sections && sections.length > 0) {
      const inSections = sections.some((s) => {
        const secNorm = normalizeForEvidence(s.value);
        return secNorm.includes(evNorm);
      });
      if (inSections) {
        log("evidence", `${spec.fieldLabel}: evidence found in DOM sections (not in rawText)`, { evidence: ev });
        continue; // sections で見つかったので OK
      }
    }

    // evidence が rawText にも sections にも存在しない → ハルシネーションの疑い
    log("evidence", `EVIDENCE_MISSING: ${spec.fieldLabel} (evidence not found in rawText or sections)`, { evidence: ev });
    warnings.push(`EVIDENCE_MISSING: ${spec.fieldLabel}`);
    spec.clearValue();
  }

  return { warnings };
};

// ---------------------------------------------------------------------------
// A) 企業名の辞書正規化（evidence検証後に適用）
// ---------------------------------------------------------------------------
const applyCompanyNameNormalization = (job: JobPosting): void => {
  if (job.company.name) {
    const before = job.company.name;
    job.company.name = normalizeCompanyName(before);
    if (before !== job.company.name) {
      log("company", `企業名を辞書正規化: "${before}" → "${job.company.name}"`);
    }
  }
};

// ---------------------------------------------------------------------------
// B-2) position.title 正規化: 装飾マーカー除去 + 安全ガード
// ---------------------------------------------------------------------------
const normalizePositionTitle = (job: JobPosting): void => {
  if (!job.position.title?.trim()) return;

  let title = job.position.title;
  const original = title;

  // ◆急募◆ 等の装飾マーカーを除去
  title = title.replace(/◆[^◆]*◆/g, "").trim();

  // _求人No.XXXXX を除去（HRMOS等）
  title = title.replace(/_求人No\.\d+$/, "").trim();

  // 先頭の【xxx】を繰り返し除去（後ろに非括弧テキストが続く場合のみ）
  title = title.replace(/^(【[^】]*】\s*)+(?=\S)/, "").trim();

  // 前後を囲む【】を除去（中身は保持）— 上記で処理されなかった単一ラップの場合
  const bracketMatch = /^【(.+)】$/.exec(title);
  if (bracketMatch) {
    title = bracketMatch[1].trim();
  }

  // 除去後に空になった場合は元の値を保持（空にしない）
  if (!title) return;

  // 除去後の文字列が雇用形態と「完全一致」する場合のみ空にする
  // （タイトル全体が雇用形態ではない限り保持）
  const empType = job.position.employmentType?.trim();
  if (empType && title === empType) {
    log("title-normalize", `title が employmentType と完全一致のためクリア: "${title}"`);
    job.position.title = "";
    return;
  }

  if (title !== original) {
    log("title-normalize", `title 正規化: "${original}" → "${title}"`);
    job.position.title = title;
  }
};

// ---------------------------------------------------------------------------
// B-3) 郵便番号の補完: rawText に郵便番号があり work.location に無い場合に付与
// ---------------------------------------------------------------------------
const recoverPostalCode = (job: JobPosting, rawText: string): void => {
  const location = job.work.location ?? "";
  if (!location.trim()) return;

  // work.location に既に郵便番号（〒 or NNN-NNNN）があれば何もしない
  if (/\d{3}-\d{4}/.test(location)) return;

  // rawText に郵便番号が一切無ければ何もしない
  if (!/\d{3}-\d{4}/.test(rawText)) return;

  // location の先頭テキスト（都道府県+市区町村レベル）で rawText 内を検索
  const searchKey = location.replace(/[\r\n]/g, " ").trim().slice(0, 30);
  if (searchKey.length < 3) return;

  const escaped = searchKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const locIndex = rawText.search(new RegExp(escaped));
  if (locIndex < 0) return;

  // 検索キーの前方 100 文字以内に郵便番号があれば補完
  const beforeText = rawText.slice(Math.max(0, locIndex - 100), locIndex);
  const postalMatch = beforeText.match(/〒?(\d{3}-\d{4})/);
  if (postalMatch) {
    const code = `〒${postalMatch[1]}`;
    job.work.location = `${code}\n${location}`;
    log("postal-code", `郵便番号を補完: ${code}`, { location: location.slice(0, 50) });
  }
};

// ---------------------------------------------------------------------------
// C) 【歓迎】マーカーチェック: rawText に歓迎マーカーが無ければ want を空にする
// ---------------------------------------------------------------------------
const WANT_MARKERS = ["【歓迎】", "歓迎スキル", "歓迎条件", "あると望ましい", "尚可"];

const stripUnfoundedWant = (job: JobPosting, rawText: string, warnings: string[]): void => {
  if (job.requirements.want.length === 0) return;
  const hasWant = WANT_MARKERS.some((m) => rawText.includes(m));
  if (!hasWant) {
    log("want-check", "原文に歓迎マーカーが無いため want を除去", { wantCount: job.requirements.want.length });
    warnings.push("WANT_REMOVED_NO_MARKER");
    job.requirements.want = [];
  }
};

// ---------------------------------------------------------------------------
// D) 必須不足レポート保存 + ログ出力
// ---------------------------------------------------------------------------
type MissingRequiredReport = {
  code: string;
  message: string;
  missingKeys: string[];
  details: RequiredFieldsResult["details"];
  evidenceWarnings: string[];
  timestamp: string;
  artifactDir: string;
};

const saveMissingRequiredReport = (
  dir: string,
  reqResult: RequiredFieldsResult,
  evidenceWarnings: string[],
  extraMessage?: string
): MissingRequiredReport => {
  const report: MissingRequiredReport = {
    code: "REQUIRED_FIELD_MISSING",
    message: extraMessage ?? "必須項目が取得できません",
    missingKeys: reqResult.missingKeys,
    details: reqResult.details,
    evidenceWarnings,
    timestamp: new Date().toISOString(),
    artifactDir: dir,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "missing_required.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error(`[missing_required] 保存失敗 (target: ${path.join(dir, "missing_required.json")}):`, e);
  }

  // D) コンソールログ: ユーザーがコピペ可能な形式
  console.error([
    "========================================",
    "FAILED: missing required",
    `missing_required: ${JSON.stringify(reqResult.missingKeys)}`,
    `details: ${JSON.stringify(reqResult.details, null, 2)}`,
    `evidence_warnings: ${JSON.stringify(evidenceWarnings)}`,
    `report: ${path.join(dir, "missing_required.json")}`,
    "========================================",
  ].join("\n"));

  return report;
};

// ---------------------------------------------------------------------------
// 言い換え検出レポート保存（paraphrase_report.json）
// ---------------------------------------------------------------------------

type ParaphraseReportItem = {
  field: string;
  generatedValue: string;
  rule: string;
};

type ParaphraseReport = {
  count: number;
  strictMode: boolean;
  items: ParaphraseReportItem[];
  timestamp: string;
  artifactDir: string;
};

const saveParaphraseReport = (
  dir: string,
  faithResult: FaithfulnessResult
): ParaphraseReport => {
  const items: ParaphraseReportItem[] = faithResult.missing.map((m: FaithfulnessMissing) => ({
    field: m.path,
    generatedValue: m.value,
    rule: "原文の正規化テキストに部分一致で見つからない（言い換え・要約の疑い）",
  }));

  const report: ParaphraseReport = {
    count: faithResult.missing.length,
    strictMode: STRICT_NO_PARAPHRASE,
    items,
    timestamp: new Date().toISOString(),
    artifactDir: dir,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "paraphrase_report.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error(`[paraphrase] レポート保存失敗 (target: ${path.join(dir, "paraphrase_report.json")}):`, e);
  }

  log("paraphrase", `言い換え検出レポート保存: ${report.count}件`, { dir });
  return report;
};

/**
 * B) 中間成果物の早期保存（バリデーション前に呼ぶ）
 */
const saveIntermediateArtifacts = (
  dir: string,
  sanitized: JobPosting,
  normalizedText: string,
  rawHtml?: string,
): void => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    // job.json
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(sanitized, null, 2), "utf8");
    // job_structured.md
    const md = buildStructuredMarkdown(sanitized, normalizedText);
    fs.writeFileSync(path.join(dir, "job_structured.md"), md, "utf8");
    // job_raw.md（まだ無い場合のみ）
    const rawMdPath = path.join(dir, "job_raw.md");
    if (!fs.existsSync(rawMdPath)) {
      fs.writeFileSync(rawMdPath, normalizedText, "utf8");
    }
    // rawHtml
    if (rawHtml && typeof rawHtml === "string") {
      const htmlPath = path.join(dir, "job_raw.html");
      if (!fs.existsSync(htmlPath)) {
        fs.writeFileSync(htmlPath, rawHtml, "utf8");
      }
    }
  } catch (e) {
    console.error(`[intermediate] 中間成果物保存失敗 (target: ${dir}):`, e);
  }
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const MIN_EXTRACTED_CHARS = Number(process.env.MIN_EXTRACTED_CHARS || 300);

// ---------------------------------------------------------------------------
// OUTPUT_DIR: ユーザー指定の出力先（B案: 環境変数）
//   設定時: 全成果物を OUTPUT_DIR 直下に出力（日付/ハッシュサブフォルダなし）
//   未設定: 従来通り DATA_DIR/YYYY-MM-DD/{company}_{position}_{hash}/
// ---------------------------------------------------------------------------
const OUTPUT_DIR: string | null = (() => {
  const env = process.env.OUTPUT_DIR?.trim();
  if (!env) return null;
  const resolved = path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return resolved;
})();

/** OUTPUT_DIR 使用時の特殊 runId マーカー */
const CUSTOM_OUTPUT_RUN_ID = "__custom_output__";

// ===========================================================================
// ユーティリティ
// ===========================================================================

const sanitizePathSegment = (s: string, maxLen = 50): string => {
  return s
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen) || "unknown";
};

const sanitizeFilename = (s: string, maxLen = 80): string => {
  const t = s
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return t || "求人情報";
};

const buildSuggestedFilename = (_pageTitle: string | undefined, positionTitle: string, companyName?: string): string => {
  // 常に "求人票_企業名_ポジション名.docx" 形式。欠落時は "不明"（推測禁止）
  const company = (companyName && sanitizeFilename(companyName, 30)) || "不明";
  const position = (positionTitle && sanitizeFilename(positionTitle)) || "不明";
  return `求人票_${company}_${position}.docx`;
};

const listToMd = (items: string[] | undefined): string => {
  const list = (items ?? []).filter((x) => typeof x === "string" && x.trim() !== "");
  if (list.length === 0) return "（記載なし）";
  return list.map((x) => `- ${x}`).join("\n");
};

const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

const makeHash = (seed: string): string => {
  return crypto.createHash("sha256").update(seed + String(Date.now())).digest("hex").slice(0, 8);
};

const dateStr = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// runId ↔ artifactDir の解決
//   OUTPUT_DIR 使用時: CUSTOM_OUTPUT_RUN_ID → OUTPUT_DIR
//   通常時: data/YYYY-MM-DD/{...} → 相対パス runId
// ---------------------------------------------------------------------------
const toRunId = (artifactDir: string): string => {
  if (OUTPUT_DIR && artifactDir === OUTPUT_DIR) {
    return CUSTOM_OUTPUT_RUN_ID;
  }
  return path.relative(DATA_DIR, artifactDir);
};

const resolveRunDir = (runId: string): string | null => {
  // OUTPUT_DIR 使用時の特殊マーカー
  if (runId === CUSTOM_OUTPUT_RUN_ID && OUTPUT_DIR) {
    try {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      return OUTPUT_DIR;
    } catch {
      return null;
    }
  }
  if (!runId || runId.includes("..") || path.isAbsolute(runId)) return null;
  const resolved = path.resolve(DATA_DIR, runId);
  if (!resolved.startsWith(DATA_DIR)) return null;
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
};

// ---------------------------------------------------------------------------
// storage.json — 保存先フォルダ設定（サーバー側で完結）
//   環境変数 STORAGE_CONFIG_PATH で差し替え可能
// ---------------------------------------------------------------------------
const STORAGE_CONFIG_PATH: string = (() => {
  const env = process.env.STORAGE_CONFIG_PATH?.trim();
  if (env) return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return path.resolve(process.cwd(), "config", "storage.json");
})();

interface StorageConfig {
  jobDocxDir: string;
  scoutTextDir: string;
}

const loadStorageConfig = (): StorageConfig => {
  try {
    const raw = fs.readFileSync(STORAGE_CONFIG_PATH, "utf8");
    const data = JSON.parse(raw);
    return {
      jobDocxDir: data.jobDocxDir || "",
      scoutTextDir: data.scoutTextDir || "",
    };
  } catch {
    // 初回: デフォルト値で storage.json を生成
    const defaults: StorageConfig = {
      jobDocxDir: path.resolve(process.cwd(), "data", "output", "docx"),
      scoutTextDir: path.resolve(process.cwd(), "data", "output", "text"),
    };
    try {
      fs.mkdirSync(path.dirname(STORAGE_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(STORAGE_CONFIG_PATH, JSON.stringify(defaults, null, 2), "utf8");
      log("storage", `storage.json を初期生成: ${STORAGE_CONFIG_PATH}`, defaults as unknown as Record<string, unknown>);
    } catch { /* ignore */ }
    return defaults;
  }
};

/** 起動時にディレクトリを自動作成 */
const ensureStorageDirs = (): void => {
  const cfg = loadStorageConfig();
  if (cfg.jobDocxDir) {
    fs.mkdirSync(cfg.jobDocxDir, { recursive: true });
    log("storage", `jobDocxDir 確認/作成: ${cfg.jobDocxDir}`);
  }
  if (cfg.scoutTextDir) {
    fs.mkdirSync(cfg.scoutTextDir, { recursive: true });
    log("storage", `scoutTextDir 確認/作成: ${cfg.scoutTextDir}`);
  }
};

// ---------------------------------------------------------------------------
// ファイル保存（render 完了後に呼び出し）
//   server 側で直接書き込み — chrome.downloads は使わない
// ---------------------------------------------------------------------------
interface SaveResult {
  savedFiles: string[];
  errors: string[];
}

const saveToOutputDirs = (
  artifactDir: string,
  companyName: string,
  positionTitle: string,
  scoutText: string | null,
): SaveResult => {
  const cfg = loadStorageConfig();
  const savedFiles: string[] = [];
  const errors: string[] = [];

  if (!cfg.jobDocxDir) return { savedFiles, errors };

  const company = sanitizePathSegment(companyName || "不明", 30);
  const position = sanitizePathSegment(positionTitle || "不明", 50);
  const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
  const subDir = `${company}_${position}_${yyyymm}`;
  const outputDir = path.join(cfg.jobDocxDir, subDir);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    errors.push(`フォルダ作成失敗: ${e instanceof Error ? e.message : String(e)}`);
    return { savedFiles, errors };
  }

  log("save", `出力フォルダ: ${outputDir}`);

  // --- Word (docx) → 求人票.docx ---
  const srcDocx = path.join(artifactDir, "output.docx");
  if (fs.existsSync(srcDocx)) {
    try {
      const dest = path.join(outputDir, "求人票.docx");
      fs.copyFileSync(srcDocx, dest);
      savedFiles.push(dest);
      log("save", `Word保存: ${dest}`);
    } catch (e) {
      errors.push(`Word保存失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- スカウト文 → スカウト文.txt (UTF-8 without BOM) ---
  if (scoutText) {
    try {
      const dest = path.join(outputDir, "スカウト文.txt");
      fs.writeFileSync(dest, scoutText, "utf8");
      savedFiles.push(dest);
      log("save", `スカウト文保存: ${dest}`);
    } catch (e) {
      errors.push(`スカウト文保存失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- テキスト系 (json, md) → 同フォルダ ---
  try {
    const baseName = `${company}_${position}`;
    const textFiles: Array<{ src: string; destName: string }> = [
      { src: "job.json", destName: `${baseName}.json` },
      { src: "job_structured.md", destName: `${baseName}_structured.md` },
      { src: "job_raw.md", destName: `${baseName}_raw.md` },
    ];
    for (const { src, destName } of textFiles) {
      const srcPath = path.join(artifactDir, src);
      if (fs.existsSync(srcPath)) {
        const destPath = path.join(outputDir, destName);
        fs.copyFileSync(srcPath, destPath);
        savedFiles.push(destPath);
        log("save", `テキスト保存: ${destPath}`);
      }
    }
  } catch (e) {
    errors.push(`テキスト保存失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { savedFiles, errors };
};

// ---------------------------------------------------------------------------
// プレビュー警告
// ---------------------------------------------------------------------------
const buildWarnings = (job: JobPosting): string[] => {
  const w: string[] = [];
  // 社会保険・福利厚生は optionalFieldWarnings で処理するため、ここでは時間外労働のみ
  if (!job.work.overtime || (!job.work.overtime.details?.trim() && job.work.overtime.exists === false)) {
    w.push("OVERTIME_MISSING: 時間外労働の情報が取得できませんでした。");
  }
  return w;
};

// ---------------------------------------------------------------------------
// buildStructuredMarkdown — Canonical Key 使用
// ---------------------------------------------------------------------------
const buildStructuredMarkdown = (job: JobPosting, rawText?: string): string => {
  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? `時間外労働: ${job.work.overtime.details}`
      : job.work.overtime.exists
        ? "時間外労働あり"
        : ""
    : "";

  const showFO = rawText
    ? hasFixedOvertimeKeywords(rawText)
    : Boolean(
        job.salary.fixedOvertime &&
        ((job.salary.fixedOvertime.amount ?? "").trim() ||
         (job.salary.fixedOvertime.includedHours ?? "").trim() ||
         (job.salary.fixedOvertime.excessPayment ?? "").trim())
      );

  const foLines: string[] = [];
  if (showFO && job.salary.fixedOvertime) {
    const fo = job.salary.fixedOvertime;
    if (fo.amount?.trim()) foLines.push(`- 固定残業代（金額）: ${fo.amount}`);
    if (fo.includedHours?.trim()) foLines.push(`- 固定残業代（時間数）: ${fo.includedHours}`);
    if (fo.excessPayment?.trim()) foLines.push(`- 超過分の扱い: ${fo.excessPayment}`);
  }

  const lines = [
    `# 求人票（構造化）`,
    ``,
    `## 企業`,
    `- 企業名: ${(job.company.displayName ?? job.company.name) || "（不明）"}`,
    job.company.summary?.trim() ? `- 企業概要: ${job.company.summary}` : ``,
    ``,
    `## 採用ポジション`,
    `- タイトル: ${job.position.title || "（不明）"}`,
    job.position.employmentType?.trim() ? `- 雇用形態: ${job.position.employmentType}` : ``,
    job.position.contractTerm?.trim() ? `- 契約期間: ${job.position.contractTerm}` : ``,
    job.position.probation?.trim() ? `- 試用期間: ${job.position.probation}` : ``,
    ``,
    `## 業務内容（原文そのまま）`,
    listToMd(job.job.responsibilities),
    job.job.notes?.trim() ? `\n補足:\n${job.job.notes}` : ``,
    ``,
    `## 求める経験・スキル（原文そのまま）`,
    `### 必須`,
    listToMd(job.requirements.must),
    // 歓迎が空なら非表示（推測禁止）
    ...(job.requirements.want.filter((x) => typeof x === "string" && x.trim()).length > 0
      ? [`### 歓迎`, listToMd(job.requirements.want)]
      : []),
    ``,
    `## 勤務条件`,
    `- 就業場所: ${job.work.location || "（記載なし）"}`,
    `- 就業時間: ${job.work.hours || "（記載なし）"}`,
    job.work.breakTime?.trim() ? `- 休憩時間: ${job.work.breakTime}` : ``,
    `- 休日休暇（原文そのまま）: ${job.work.holidays || "（記載なし）"}`,
    overtimeText ? `- ${overtimeText}` : ``,
    ``,
    `## 賃金（原文そのまま）`,
    `- 賃金: ${job.salary.summary || "（必須）"}`,
    job.salary.details?.filter((x) => typeof x === "string" && x.trim()).length > 0 ? `\n${listToMd(job.salary.details)}` : ``,
    foLines.length > 0 ? `\n${foLines.join("\n")}` : ``,
    ``,
    // 福利厚生: 空なら非表示
    ...(job.benefits.items.filter((x) => typeof x === "string" && x.trim()).length > 0
      ? [`## 福利厚生（原文そのまま）`, listToMd(job.benefits.items), ``]
      : []),
    // 社会保険: 空なら非表示
    ...(job.insurance.socialInsurance?.trim()
      ? [`## 社会保険`, `- ${job.insurance.socialInsurance}`, ``]
      : []),
    // 選考プロセス: 空なら非表示
    ...(job.selection.process?.trim()
      ? [`## 選考プロセス`, `- ${job.selection.process}`, ``]
      : []),
    `---`,
    `source: ${job.source.url}`,
  ];

  return lines.filter((x) => x !== ``).join("\n");
};

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!allowedOrigin) return callback(null, true);
      if (!origin || origin === allowedOrigin) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "4mb" }));

// ===========================================================================
// POST /api/extract
//   入力: { rawText, rawHtml?, url?, title?, siteHint?, extractMeta?, runId? }
//   出力: { runId, extractedLength }
//   job_raw.md + extract_report.json を保存
// ===========================================================================
app.post("/api/extract", async (req, res) => {
  try {
    const { rawText, rawHtml, url, title, siteHint, extractMeta, extractedSections, extractionTrace, runId: inputRunId, jobTitle: extractJobTitle } = req.body ?? {};

    if (!rawText || String(rawText).trim() === "") {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "rawText is empty — ページ本文が取得できませんでした。" },
      });
    }

    const normalized = normalizeRawText(String(rawText));
    const extractedLength = normalized.length;
    log("extract", "抽出テキスト文字数", { extractedLength, min: MIN_EXTRACTED_CHARS });

    if (extractedLength === 0) {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "抽出テキストが0文字です。" },
      });
    }
    if (extractedLength < MIN_EXTRACTED_CHARS) {
      return res.status(400).json({
        error: {
          code: "TEXT_EXTRACTION_TOO_SHORT",
          message: `抽出テキストが短すぎます（${extractedLength}文字）。ログイン必須/本文未展開/抽出失敗の可能性があります。`,
        },
      });
    }

    // ディレクトリ決定: OUTPUT_DIR 指定時はそこへ直接出力
    const hash = makeHash(String(url ?? "") + normalized.slice(0, 200));
    let artifactDir: string;
    if (OUTPUT_DIR) {
      artifactDir = OUTPUT_DIR;
    } else if (inputRunId) {
      const existing = resolveRunDir(inputRunId);
      if (existing) {
        artifactDir = existing;
      } else {
        artifactDir = path.join(DATA_DIR, dateStr(), `_pending_${hash}`);
      }
    } else {
      artifactDir = path.join(DATA_DIR, dateStr(), `_pending_${hash}`);
    }
    ensureDir(artifactDir);
    log("extract", "出力先", { artifactDir });

    // job_raw.md
    fs.writeFileSync(path.join(artifactDir, "job_raw.md"), normalized, "utf8");

    // job_raw.html（Content Script から送られた HTML）
    if (rawHtml && typeof rawHtml === "string") {
      fs.writeFileSync(path.join(artifactDir, "job_raw.html"), rawHtml, "utf8");
    }

    // extracted_sections.json（DOM由来のセクション化データ）
    {
      const base = Array.isArray(extractedSections) ? extractedSections : [];
      // blockquote / >記号セクションをマージ（rawHtml がある場合）
      // base が空でも rawHtml があれば blockquote 抽出を実行する
      const mergedResult =
        rawHtml && typeof rawHtml === "string"
          ? mergeBlockquoteSections(base, rawHtml, extractionTrace?.strategy ?? "")
          : { sections: base, method: extractionTrace?.strategy ?? "" };

      if (mergedResult.sections.length > 0) {
        fs.writeFileSync(
          path.join(artifactDir, "extracted_sections.json"),
          JSON.stringify({ sections: mergedResult.sections, trace: extractionTrace ?? null }, null, 2),
          "utf8"
        );
        log("extract", `DOM sections saved: ${mergedResult.sections.length}件`, { method: mergedResult.method });
      }
    }

    // extract_report.json
    const report = {
      url: url || null,
      title: title || null,
      siteHint: siteHint || null,
      extractMeta: extractMeta ?? null,
      extractedLength,
      minExtractedChars: MIN_EXTRACTED_CHARS,
      extractionTrace: extractionTrace ?? null,
      sectionCount: Array.isArray(extractedSections) ? extractedSections.length : 0,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "extract_report.json"), JSON.stringify(report, null, 2), "utf8");

    // meta.json（初期）
    const meta = {
      schemaVersion: "museum_jobposting_v0.3",
      phase: "extracted",
      url: url || undefined,
      title: title || undefined,
      siteHint: siteHint || undefined,
      jobTitle: typeof extractJobTitle === "string" && extractJobTitle.trim() ? extractJobTitle.trim() : undefined,
      extractedLength,
      extractionStrategy: extractionTrace?.strategy,
      sectionCount: Array.isArray(extractedSections) ? extractedSections.length : 0,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

    const runId = toRunId(artifactDir);
    log("extract", "保存完了", { runId });

    return res.json({ runId, extractedLength });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
    });
  }
});

// ===========================================================================
// POST /api/structure
//   入力: { runId }
//   出力: { runId, structuredMd, job, suggestedFilename, meta }
//   OpenAI → sanitize → faithfulness → requiredFields → 保存
// ===========================================================================
app.post("/api/structure", async (req, res) => {
  try {
    const { runId } = req.body ?? {};

    if (!runId || typeof runId !== "string") {
      return res.status(400).json({
        error: { code: "RUN_ID_REQUIRED", message: "runId が必要です。先に /api/extract を呼んでください。" },
      });
    }

    const artifactDir = resolveRunDir(runId);
    if (!artifactDir) {
      return res.status(400).json({
        error: { code: "RUN_NOT_FOUND", message: `runId '${runId}' が見つかりません。` },
      });
    }

    // job_raw.md を読み込む
    const rawMdPath = path.join(artifactDir, "job_raw.md");
    if (!fs.existsSync(rawMdPath)) {
      return res.status(400).json({
        error: { code: "RAW_MD_NOT_FOUND", message: "job_raw.md が見つかりません。先に /api/extract を実行してください。" },
      });
    }
    let normalizedText = fs.readFileSync(rawMdPath, "utf8");

    // rawText が空の場合、extracted_sections.json からテキストを再構築
    if (!normalizedText.trim()) {
      try {
        const sectionsPath = path.join(artifactDir, "extracted_sections.json");
        if (fs.existsSync(sectionsPath)) {
          const secData = JSON.parse(fs.readFileSync(sectionsPath, "utf8"));
          const fallbackSections: Array<{ label: string; value: string }> = secData.sections ?? [];
          if (fallbackSections.length > 0) {
            normalizedText = fallbackSections.map((s) => `${s.label}\n${s.value}`).join("\n\n");
            log("structure", "job_raw.md が空のため extracted_sections.json からテキストを再構築", { length: normalizedText.length });
          }
        }
      } catch { /* フォールバック失敗時は空のまま続行 */ }
    }

    // meta.json から補足情報を取得
    let metaData: Record<string, unknown> = {};
    try {
      metaData = JSON.parse(fs.readFileSync(path.join(artifactDir, "meta.json"), "utf8"));
    } catch { /* 無くても続行 */ }

    const url = String(metaData.url ?? "");
    const title = String(metaData.title ?? "");
    const siteHint = String(metaData.siteHint ?? "unknown");
    const jobTitle = typeof metaData.jobTitle === "string" ? metaData.jobTitle : undefined;

    // (1) OpenAI 構造化
    log("structure", "OpenAI構造化開始");
    const job = await generateJobPosting({ url, title, rawText: normalizedText, siteHint });
    const jobWithCompliance: JobPosting = {
      ...job,
      compliance: job.compliance ?? { forbiddenDetected: [], warnings: [] },
    };

    // (2) sanitize（禁止転載除去）
    const { sanitized, forbiddenDetected } = sanitizeJobPosting(jobWithCompliance);
    sanitized.compliance.forbiddenDetected = Array.from(
      new Set([...sanitized.compliance.forbiddenDetected, ...forbiddenDetected])
    );

    // (2.4a) DOM sections から会社名を優先取得（rawText依存より信頼性が高い）
    const evidenceSkipFields = new Set<string>();
    let domSectionsForEvidence: Array<{ label: string; value: string }> = [];
    try {
      const sectionsPath = path.join(artifactDir, "extracted_sections.json");
      if (fs.existsSync(sectionsPath)) {
        const secData = JSON.parse(fs.readFileSync(sectionsPath, "utf8"));
        domSectionsForEvidence = secData.sections ?? [];
        const compSec = domSectionsForEvidence.find((s) => s.label === "会社名");
        const compSecVal = typeof compSec?.value === "string" ? compSec.value.trim() : "";
        if (compSecVal) {
          sanitized.company.name = compSecVal;
          evidenceSkipFields.add("company.name");
          log("field_source", `company.name source=sections (DOM優先)`, { value: compSecVal });
        }
      }
    } catch { /* sections 読み込み失敗時は OpenAI フォールバック */ }

    // (2.5) evidence 検証: rawText + DOM sections を証拠として使用
    const evidenceResult = validateEvidence(sanitized, normalizedText, evidenceSkipFields, domSectionsForEvidence);
    const warnings: string[] = [...evidenceResult.warnings];

    // (2.5b) DOM sections によるフィールド補完 + ソース追跡
    const fieldSourceLog: Array<{ field: string; source: string; label?: string; snippet?: string }> = [];
    try {
      const sectionsPath = path.join(artifactDir, "extracted_sections.json");
      if (fs.existsSync(sectionsPath)) {
        const sectionsData = JSON.parse(fs.readFileSync(sectionsPath, "utf8"));
        const domSections: Array<{ label: string; value: string; domTag?: string; snippet?: string }> = sectionsData.sections ?? [];
        if (domSections.length > 0) {
          const aliases = loadFieldAliases();
          for (const sec of domSections) {
            const canonicalField = aliases[sec.label] ?? null;
            if (!canonicalField) continue;

            // HRMOS: selection.process は DOM sections からのみ許可
            if (canonicalField === "selection.process" && siteHint === "HRMOS") {
              // DOM section にある場合のみ、値があれば設定
              const secVal = typeof sec.value === "string" ? sec.value.trim() : "";
              if (!sanitized.selection.process?.trim() && secVal) {
                sanitized.selection.process = secVal;
                fieldSourceLog.push({ field: "selection.process", source: "sections", label: sec.label, snippet: sec.value.slice(0, 120) });
                log("field_source", `selection.process source=sections label=${sec.label}`, { snippet: sec.value.slice(0, 120) });
              }
              continue;
            }

            // 汎用: OpenAI が抽出できなかったフィールドを sections で補完
            const current = getNestedValue(sanitized, canonicalField);
            const secValue = typeof sec.value === "string" ? sec.value.trim() : "";
            if (secValue && (!current || (typeof current === "string" && !current.trim()))) {
              setNestedValue(sanitized, canonicalField, secValue);
              fieldSourceLog.push({ field: canonicalField, source: "sections", label: sec.label, snippet: secValue.slice(0, 120) });
              log("field_source", `${canonicalField} source=sections label=${sec.label}`, { snippet: secValue.slice(0, 120) });
            } else {
              fieldSourceLog.push({ field: canonicalField, source: "openai", snippet: (typeof current === "string" ? current : "").slice(0, 120) });
            }
          }

          // HRMOS: selection.process が rawText 由来で誤抽出の可能性がある場合はクリア
          if (siteHint === "HRMOS" && sanitized.selection.process?.trim()) {
            const fromSections = fieldSourceLog.some((l) => l.field === "selection.process" && l.source === "sections");
            if (!fromSections) {
              log("field_source", "selection.process cleared (HRMOS: not from DOM sections)");
              sanitized.selection.process = "";
            }
          }
        }
      }
    } catch (e) {
      log("field_source", "extracted_sections.json の読み込みエラー（無視して続行）", { error: String(e) });
    }

    // (2.6) 企業名の正規化（トリムのみ。ハードコード辞書は廃止済み）
    applyCompanyNameNormalization(sanitized);

    // (2.6b) position.title 正規化（◆急募◆・【】除去 + 安全ガード）
    normalizePositionTitle(sanitized);

    // HRMOS: position.title を page title (jobTitle > title) で上書き確定
    // OpenAIの推測に依存せず、HRMOSのページタイトルを正とする
    if (siteHint === "HRMOS") {
      const hrmosTitle = (jobTitle?.trim()) ? jobTitle.trim() : (title?.trim() ?? "");
      if (hrmosTitle) {
        if (hrmosTitle !== sanitized.position.title) {
          log("title-override", `HRMOS: position.title 確定 "${sanitized.position.title}" → "${hrmosTitle}"`);
        }
        sanitized.position.title = hrmosTitle;
      }
    }

    // (2.6b2) position.title が空の場合、ページタイトルからフォールバック抽出
    if (!sanitized.position.title?.trim() && title?.trim()) {
      let fallbackTitle = title.replace(/\s*\|\s*[^|]+$/, "").trim();
      if (fallbackTitle) {
        sanitized.position.title = fallbackTitle;
        normalizePositionTitle(sanitized);
        if (sanitized.position.title?.trim()) {
          log("title-fallback", `ページタイトルからposition.title復元: "${title}" → "${sanitized.position.title}"`);
        }
      }
    }

    // (2.6c) 郵便番号の補完（rawText にあり work.location に無い場合）
    recoverPostalCode(sanitized, normalizedText);

    // (2.7) 【歓迎】マーカーチェック: 原文に無い歓迎スキルは除去
    stripUnfoundedWant(sanitized, normalizedText, warnings);

    // (2.8) company_key 解決（alias完全一致 → hints部分一致のフォールバック）
    let companyKey = resolveCompanyKey(sanitized.company.name);
    if (!companyKey) {
      companyKey = resolveCompanyKeyWithHints(sanitized.company.name);
    }
    if (companyKey) {
      log("company", `company_key 解決: "${sanitized.company.name}" → "${companyKey}"`);
    }

    // (2.9) 表示会社名の正規化（原文 company.name は変更しない）
    const displayName = resolveDisplayName(sanitized, companyKey);
    if (displayName && displayName !== sanitized.company.name) {
      log("company", `displayName 設定: "${displayName}"（原文: "${sanitized.company.name}"）`);
    }

    // D) company_profiles.json の定型差し込み（4項目のみ: hours/holidays/benefits/insurance）
    const defaultsResult = applyCompanyDefaults(sanitized, companyKey);
    if (defaultsResult.applied) {
      log("inject", `companyKey=${companyKey}, fields=${defaultsResult.appliedFields.join(",")}`, {
        sources: defaultsResult.sources,
      });
    }

    // 旧 company_static は下位互換として残す（profiles で埋まらなかった分を補完）
    const mergeResult = mergeCompanyStatic(sanitized, companyKey, ENABLE_COMPANY_STATIC);
    if (mergeResult.staticApplied) {
      log("company", "company_static 注入", { keys: mergeResult.staticAppliedKeys });
    }

    // 注入されたフィールドの一覧（faithfulness 除外用）
    const injectedFields = [
      ...defaultsResult.appliedFields,
      ...mergeResult.staticAppliedKeys,
    ];

    // 時間外労働: 情報が無い場合は項目自体を削除
    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    // (3) B) 中間成果物を先行保存（バリデーション失敗でも残す）
    saveIntermediateArtifacts(artifactDir, sanitized, normalizedText);

    // (4) 空の求人票ガード（企業名・ポジション名は停止条件）
    if (!sanitized.company?.name?.trim()) {
      const reqResult = requiredFieldsCheck(sanitized);
      saveMissingRequiredReport(artifactDir, reqResult, warnings, "構造化結果に企業名がありません。ページが求人情報ではない可能性があります。");
      return res.status(400).json({
        error: {
          code: "JOB_JSON_EMPTY_OR_INVALID",
          message: "構造化結果に企業名がありません。ページが求人情報ではない可能性があります。",
          missing: ["company.name", ...reqResult.missingKeys],
          details: reqResult.details,
          warnings,
        },
      });
    }
    if (!sanitized.position?.title?.trim()) {
      const reqResult = requiredFieldsCheck(sanitized);
      saveMissingRequiredReport(artifactDir, reqResult, warnings, "構造化結果にポジション名がありません。");
      return res.status(400).json({
        error: {
          code: "JOB_JSON_EMPTY_OR_INVALID",
          message: "構造化結果にポジション名がありません。",
          missing: ["position.title", ...reqResult.missingKeys],
          details: reqResult.details,
          warnings,
        },
      });
    }

    // (5) 真の必須欠落チェック（停止条件）— 業務内容/勤務地/賃金
    //     overrides / company_static 適用後に判定（埋まっていれば通過）
    const reqResult = requiredFieldsCheck(sanitized);
    if (!reqResult.ok) {
      saveMissingRequiredReport(artifactDir, reqResult, warnings);
      return res.status(400).json({
        error: {
          code: "REQUIRED_FIELD_MISSING",
          message: `必須項目が取得できません: ${reqResult.missingKeys.join(", ")}`,
          missing: reqResult.missingKeys,
          details: reqResult.details,
          warnings,
        },
      });
    }

    // (5.5) 任意項目の欠落警告（停止しない）
    const optResult = optionalFieldWarnings(sanitized);
    if (optResult.warnings.length > 0) {
      warnings.push(...optResult.warnings);
      log("structure", "任意項目欠落（停止なし）", { missing: optResult.warnings });
    }

    // (6) faithfulness チェック（常に警告のみ — 停止しない）
    //     overrides / company_static で注入したフィールドは除外
    const faithResult = faithfulnessCheck(sanitized, normalizedText, injectedFields);
    const faithErrors = toFaithfulnessErrors(faithResult);

    if (!faithResult.ok) {
      log("structure", "言い換え検出（警告）", { count: faithResult.missing.length });

      // paraphrase_report.json を必ず保存（根拠を残す）
      saveParaphraseReport(artifactDir, faithResult);

      // 警告として記録し処理続行（停止しない）
      warnings.push(`PARAPHRASE_WARNING: 原文と異なる表現の可能性（${faithResult.missing.length}件）。詳細は paraphrase_report.json を確認してください。`);
    }

    // (6.5) プレビュー警告
    warnings.push(...buildWarnings(sanitized));
    warnings.push(...sanitized.compliance.warnings);

    // 固定残業代表示フラグ
    const showFixedOvertime = hasFixedOvertimeKeywords(normalizedText);

    // (7) ディレクトリ名を正式名に更新（_pending_ → company_position_hash）
    //     OUTPUT_DIR 使用時はリネーム不要
    let finalDir = artifactDir;
    let finalRunId = runId;
    if (!OUTPUT_DIR) {
      const dirName = path.basename(artifactDir);
      if (dirName.startsWith("_pending_")) {
        const hash = dirName.replace("_pending_", "");
        const companyPart = sanitizePathSegment(sanitized.company.name);
        const positionPart = sanitizePathSegment(sanitized.position.title);
        const newDirName = `${companyPart}_${positionPart}_${hash}`;
        const newDir = path.join(path.dirname(artifactDir), newDirName);
        try {
          fs.renameSync(artifactDir, newDir);
          finalDir = newDir;
          finalRunId = toRunId(newDir);
          log("structure", "ディレクトリ名更新", { from: dirName, to: newDirName });
        } catch {
          // rename 失敗は無視（元のパスを使い続ける）
        }
      }
    }

    // (8) 成果物保存
    const structuredMd = buildStructuredMarkdown(sanitized, normalizedText);

    const jobWithMeta: Record<string, unknown> = { ...sanitized };
    if (mergeResult.staticApplied) {
      jobWithMeta.static_applied = true;
      jobWithMeta.static_applied_keys = mergeResult.staticAppliedKeys;
    }
    // 監査用: injected メタデータ
    if (defaultsResult.applied) {
      jobWithMeta.meta = {
        injected: {
          fields: defaultsResult.appliedFields,
          sources: defaultsResult.sources,
        },
      };
    }
    fs.writeFileSync(path.join(finalDir, "job.json"), JSON.stringify(jobWithMeta, null, 2), "utf8");
    fs.writeFileSync(path.join(finalDir, "job_structured.md"), structuredMd, "utf8");

    // meta.json 更新
    const updatedMeta = {
      ...metaData,
      schemaVersion: "museum_jobposting_v0.3",
      phase: "structured",
      warnings,
      faithViolations: faithErrors.length > 0 ? faithErrors : undefined,
      showFixedOvertime,
      companyName: sanitized.company.displayName ?? sanitized.company.name,
      companyNameOriginal: sanitized.company.name,
      companyKey: companyKey ?? undefined,
      provenance: Object.keys(mergeResult.provenance).length > 0 ? mergeResult.provenance : undefined,
      injected: defaultsResult.applied
        ? { fields: defaultsResult.appliedFields, sources: defaultsResult.sources, sourceUrl: defaultsResult.sourceUrl }
        : undefined,
      fieldSourceLog: fieldSourceLog.length > 0 ? fieldSourceLog : undefined,
      positionTitle: sanitized.position.title,
      jobTitle,
      structuredAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(finalDir, "meta.json"), JSON.stringify(updatedMeta, null, 2), "utf8");

    log("structure", "保存完了", { runId: finalRunId, outputDir: finalDir });

    return res.json({
      runId: finalRunId,
      structuredMd,
      job: sanitized,
      suggestedFilename: buildSuggestedFilename(jobTitle ?? title, sanitized.position.title, sanitized.company.displayName ?? sanitized.company.name),
      meta: {
        warnings,
        faithViolations: faithErrors.length > 0 ? faithErrors : undefined,
        showFixedOvertime,
      },
    });
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.status ?? (error as any)?.response?.status;
    let code = "INTERNAL_ERROR";
    let message = "不明なエラーが発生しました";
    if (status === 429 || detail.includes("429") || detail.includes("quota")) {
      code = "OPENAI_QUOTA_EXCEEDED";
      message = "OpenAI APIの利用上限に達しています。";
    } else if (detail.includes("LLM_INVALID_JSON")) {
      code = "LLM_INVALID_JSON";
      message = "AIの構造化結果が不正です。もう一度お試しください。";
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

// ===========================================================================
// GET /api/preview
//   入力: ?runId=...
//   出力: { runId, structuredMd, warnings, faithViolations }
//   render 前に必ず呼ぶ（確認用）
// ===========================================================================
app.get("/api/preview", (req, res) => {
  try {
    const runId = String(req.query.runId ?? "");
    if (!runId) {
      return res.status(400).json({
        error: { code: "RUN_ID_REQUIRED", message: "runId クエリパラメータが必要です。" },
      });
    }

    const artifactDir = resolveRunDir(runId);
    if (!artifactDir) {
      return res.status(400).json({
        error: { code: "RUN_NOT_FOUND", message: `runId '${runId}' が見つかりません。` },
      });
    }

    // job_structured.md
    const mdPath = path.join(artifactDir, "job_structured.md");
    if (!fs.existsSync(mdPath)) {
      return res.status(400).json({
        error: { code: "STRUCTURED_MD_NOT_FOUND", message: "job_structured.md がありません。先に /api/structure を実行してください。" },
      });
    }
    const structuredMd = fs.readFileSync(mdPath, "utf8");

    // meta.json
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(artifactDir, "meta.json"), "utf8"));
    } catch { /* ignore */ }

    // job.json
    let job: JobPosting | null = null;
    try {
      job = JSON.parse(fs.readFileSync(path.join(artifactDir, "job.json"), "utf8"));
    } catch { /* ignore */ }

    return res.json({
      runId,
      structuredMd,
      job,
      warnings: meta.warnings ?? [],
      faithViolations: meta.faithViolations ?? [],
      showFixedOvertime: meta.showFixedOvertime ?? true,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
    });
  }
});

// ===========================================================================
// GET /api/storage — 保存先フォルダ設定を返す（読み取り専用）
// ===========================================================================
app.get("/api/storage", (_req, res) => {
  try {
    const cfg = loadStorageConfig();
    return res.json(cfg);
  } catch (e) {
    return res.status(500).json({ error: { message: String(e) } });
  }
});

// ===========================================================================
// POST /api/render
//   入力: { runId, approve: true }
//   出力: { savedFiles, saveErrors, suggestedFilename, meta }
//   保存済み job.json → テンプレ差し込み → output.docx 保存 → 返却
// ===========================================================================
app.post("/api/render", async (req, res) => {
  try {
    const { runId, approve } = req.body ?? {};

    // runId はレガシーの sessionId も受け入れる
    const id = runId ?? (req.body as any)?.sessionId;

    if (!id || typeof id !== "string") {
      return res.status(400).json({
        error: { code: "RUN_ID_REQUIRED", message: "runId が必要です。" },
      });
    }
    if (approve !== true && approve !== undefined) {
      // approve が明示的に false ならブロック
      // undefined は互換（旧 /api/render は approve 無しで呼べた）
    }

    const artifactDir = resolveRunDir(id);
    if (!artifactDir) {
      return res.status(400).json({
        error: { code: "RUN_NOT_FOUND", message: `runId '${id}' が見つかりません。` },
      });
    }

    // job.json
    const jobJsonPath = path.join(artifactDir, "job.json");
    if (!fs.existsSync(jobJsonPath)) {
      return res.status(400).json({
        error: { code: "JOB_JSON_NOT_FOUND", message: "job.json が見つかりません。先に /api/structure を実行してください。" },
      });
    }
    const sanitized: JobPosting = JSON.parse(fs.readFileSync(jobJsonPath, "utf8"));

    // 必須項目チェック（render 前最終防衛）
    const reqResult = requiredFieldsCheck(sanitized);
    if (!reqResult.ok) {
      return res.status(400).json({
        error: {
          code: "REQUIRED_FIELD_MISSING",
          message: "必須項目が取得できません",
          missing: reqResult.missingKeys,
        },
      });
    }

    // faithfulness チェック（render 前最終防衛 — 常に警告のみ、停止しない）
    // overrides / company_static で注入したフィールドは除外
    let showFixedOvertime = true;
    try {
      const rawMd = fs.readFileSync(path.join(artifactDir, "job_raw.md"), "utf8");

      // meta.json から注入済みフィールドを取得（faithfulness 除外用）
      let renderInjectedFields: string[] = [];
      try {
        const metaForRender = JSON.parse(fs.readFileSync(path.join(artifactDir, "meta.json"), "utf8"));
        if (metaForRender.injected?.fields) {
          renderInjectedFields.push(...metaForRender.injected.fields);
        }
        if (metaForRender.provenance) {
          for (const [field, source] of Object.entries(metaForRender.provenance)) {
            if (source === "company_static" && !renderInjectedFields.includes(field)) {
              renderInjectedFields.push(field);
            }
          }
        }
      } catch { /* ignore */ }

      const faithResult = faithfulnessCheck(sanitized, rawMd, renderInjectedFields);
      if (!faithResult.ok) {
        saveParaphraseReport(artifactDir, faithResult);
        log("render", "言い換え検出（警告のみ）", { count: faithResult.missing.length });
      }
      showFixedOvertime = hasFixedOvertimeKeywords(rawMd);
    } catch { /* job_raw.md が無ければスキップ */ }

    // meta.json の showFixedOvertime を優先
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, "meta.json"), "utf8"));
      if (typeof meta.showFixedOvertime === "boolean") {
        showFixedOvertime = meta.showFixedOvertime;
      }
    } catch { /* ignore */ }

    // テンプレート解決
    let templatePath: string;
    try {
      templatePath = resolveTemplatePath();
    } catch (e) {
      return res.status(500).json({
        error: { code: "TEMPLATE_NOT_FOUND_OR_EMPTY", message: e instanceof Error ? e.message : String(e) },
      });
    }
    const tStat = getTemplateStat(templatePath);
    if (!tStat.exists || tStat.size === 0) {
      return res.status(500).json({
        error: { code: "TEMPLATE_NOT_FOUND_OR_EMPTY", message: `テンプレートが存在しないか0バイトです: ${templatePath}` },
      });
    }

    // Word 生成
    let docxBuffer: Buffer;
    try {
      log("render", "Word差し込み開始", { templatePath, showFixedOvertime });
      let jobTitle: string | undefined;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(artifactDir, "meta.json"), "utf8"));
        jobTitle = m.jobTitle;
      } catch { /* ignore */ }

      docxBuffer = await renderJobDocx(sanitized, templatePath, { jobTitle, showFixedOvertime });
      log("render", "Word差し込み完了", { outputSize: docxBuffer.length });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        error: { code: "DOCX_RENDER_FAIL", message: "Word生成に失敗しました", detail: error instanceof Error ? error.message : String(error) },
      });
    }

    // スカウト文生成
    const scoutText = await generateScoutText(sanitized);

    // output.docx 保存
    fs.writeFileSync(path.join(artifactDir, "output.docx"), docxBuffer);
    log("render", "output.docx 保存完了", { dir: artifactDir });

    // meta.json 更新
    try {
      const metaPath = path.join(artifactDir, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      meta.phase = "rendered";
      meta.renderedAt = new Date().toISOString();
      meta.templatePath = templatePath;
      meta.templateSize = tStat.size;
      meta.docxSize = docxBuffer.length;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch { /* ignore */ }

    const displayCompany = sanitized.company.displayName ?? sanitized.company.name;
    const suggestedFilename = buildSuggestedFilename(sanitized.position.title, sanitized.position.title, displayCompany);

    // storage.json の保存先へ書き出し
    const saveResult = saveToOutputDirs(artifactDir, displayCompany, sanitized.position.title, scoutText);

    return res.json({
      suggestedFilename,
      savedFiles: saveResult.savedFiles,
      saveErrors: saveResult.errors,
      meta: { warnings: sanitized.compliance?.warnings ?? [] },
    });
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    let code = "INTERNAL_ERROR";
    let message = "不明なエラーが発生しました";
    if (detail.includes("テンプレート")) {
      code = "TEMPLATE_NOT_FOUND_OR_EMPTY";
      message = detail;
    } else if (detail.includes("Word") || detail.includes("docx")) {
      code = "DOCX_RENDER_FAIL";
      message = detail;
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

// ===========================================================================
// POST /api/generate — 互換エンドポイント
//   内部で extract → structure を順に実行する。
//   拡張機能の GENERATE_JOB_PREVIEW で使用。
//   render はしない（プレビュー確認後に /api/render を呼ぶ）。
// ===========================================================================
app.post("/api/generate", async (req, res) => {
  try {
    const { url, title, rawText, rawHtml, siteHint, jobTitle, extractMeta, extractedSections: genSections, extractionTrace: genTrace } = req.body ?? {};

    // --- extract 相当 ---
    if (!rawText || String(rawText).trim() === "") {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "rawText is empty — ページ本文が取得できませんでした。" },
      });
    }

    const normalized = normalizeRawText(String(rawText));
    const extractedLength = normalized.length;
    log("generate", "抽出テキスト文字数", { extractedLength, min: MIN_EXTRACTED_CHARS });

    if (extractedLength === 0) {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "抽出テキストが0文字です。" },
      });
    }
    if (extractedLength < MIN_EXTRACTED_CHARS) {
      return res.status(400).json({
        error: {
          code: "TEXT_EXTRACTION_TOO_SHORT",
          message: `抽出テキストが短すぎます（${extractedLength}文字）。`,
        },
      });
    }

    // --- structure 相当 ---
    log("generate", "OpenAI構造化開始");
    const job = await generateJobPosting({
      url: String(url ?? ""),
      title: String(title ?? ""),
      rawText: normalized,
      siteHint: String(siteHint ?? "unknown"),
    });

    const jobWithCompliance: JobPosting = {
      ...job,
      compliance: job.compliance ?? { forbiddenDetected: [], warnings: [] },
    };

    const { sanitized, forbiddenDetected } = sanitizeJobPosting(jobWithCompliance);
    sanitized.compliance.forbiddenDetected = Array.from(
      new Set([...sanitized.compliance.forbiddenDetected, ...forbiddenDetected])
    );

    // blockquote / >記号セクションを genSections にマージ（rawHtml がある場合のみ）
    const mergedGenSections =
      Array.isArray(genSections) && rawHtml && typeof rawHtml === "string"
        ? mergeBlockquoteSections(genSections, rawHtml, genTrace?.strategy ?? "").sections
        : (genSections ?? []);

    // DOM sections から会社名を優先取得（rawText依存より信頼性が高い）
    const genEvidenceSkipFields = new Set<string>();
    if (Array.isArray(mergedGenSections)) {
      const compSec = mergedGenSections.find((s: { label: string; value?: string }) => s.label === "会社名");
      const genCompVal = typeof compSec?.value === "string" ? compSec.value.trim() : "";
      if (genCompVal) {
        sanitized.company.name = genCompVal;
        genEvidenceSkipFields.add("company.name");
        log("field_source", `company.name source=sections (DOM優先)`, { value: genCompVal });
      }
    }

    // evidence 検証: rawText + DOM sections を証拠として使用
    const evidenceResult = validateEvidence(
      sanitized,
      normalized,
      genEvidenceSkipFields,
      mergedGenSections as Array<{ label: string; value: string }>
    );
    const warnings: string[] = [...evidenceResult.warnings];

    // DOM sections によるフィールド補完（generate経路）
    const genFieldSourceLog: Array<{ field: string; source: string; label?: string; snippet?: string }> = [];
    const genSiteHint = String(siteHint ?? "unknown");
    if (mergedGenSections.length > 0) {
      const aliases = loadFieldAliases();
      for (const sec of mergedGenSections) {
        const canonicalField = aliases[sec.label] ?? null;
        if (!canonicalField) continue;
        if (canonicalField === "selection.process" && genSiteHint === "HRMOS") {
          const genSecVal = typeof sec.value === "string" ? sec.value.trim() : "";
          if (!sanitized.selection.process?.trim() && genSecVal) {
            sanitized.selection.process = genSecVal;
            genFieldSourceLog.push({ field: "selection.process", source: "sections", label: sec.label, snippet: genSecVal.slice(0, 120) });
          }
          continue;
        }
        const current = getNestedValue(sanitized as unknown as Record<string, unknown>, canonicalField);
        const genSecValue = typeof sec.value === "string" ? sec.value.trim() : "";
        if (genSecValue && (!current || (typeof current === "string" && !current.trim()))) {
          setNestedValue(sanitized as unknown as Record<string, unknown>, canonicalField, genSecValue);
          genFieldSourceLog.push({ field: canonicalField, source: "sections", label: sec.label, snippet: genSecValue.slice(0, 120) });
          log("field_source", `${canonicalField} source=sections label=${sec.label}`, { snippet: genSecValue.slice(0, 120) });
        }
      }
      if (genSiteHint === "HRMOS" && sanitized.selection.process?.trim()) {
        const fromSections = genFieldSourceLog.some((l) => l.field === "selection.process" && l.source === "sections");
        if (!fromSections) {
          sanitized.selection.process = "";
        }
      }
    }

    // 企業名の正規化（トリムのみ）
    applyCompanyNameNormalization(sanitized);

    // position.title 正規化（◆急募◆・【】除去 + 安全ガード）
    normalizePositionTitle(sanitized);

    // HRMOS: position.title を page title (jobTitle > title) で上書き確定
    // OpenAIの推測に依存せず、HRMOSのページタイトルを正とする
    if (String(siteHint ?? "") === "HRMOS") {
      const hrmosTitle = (typeof jobTitle === "string" && jobTitle.trim())
        ? jobTitle.trim()
        : (typeof title === "string" ? title.trim() : "");
      if (hrmosTitle) {
        if (hrmosTitle !== sanitized.position.title) {
          log("title-override", `HRMOS: position.title 確定 "${sanitized.position.title}" → "${hrmosTitle}"`);
        }
        sanitized.position.title = hrmosTitle;
      }
    }

    // position.title が空の場合、ページタイトルからフォールバック抽出
    if (!sanitized.position.title?.trim() && title?.trim()) {
      const genTitle = String(title);
      let fallbackTitle = genTitle.replace(/\s*\|\s*[^|]+$/, "").trim();
      if (fallbackTitle) {
        sanitized.position.title = fallbackTitle;
        normalizePositionTitle(sanitized);
        if (sanitized.position.title?.trim()) {
          log("title-fallback", `ページタイトルからposition.title復元: "${genTitle}" → "${sanitized.position.title}"`);
        }
      }
    }

    // 郵便番号の補完（rawText にあり work.location に無い場合）
    recoverPostalCode(sanitized, normalized);

    // 【歓迎】マーカーチェック
    stripUnfoundedWant(sanitized, normalized, warnings);

    // company_key 解決（alias完全一致 → hints部分一致のフォールバック）
    let companyKey = resolveCompanyKey(sanitized.company.name);
    if (!companyKey) {
      companyKey = resolveCompanyKeyWithHints(sanitized.company.name);
    }
    if (companyKey) {
      log("company", `company_key 解決: "${sanitized.company.name}" → "${companyKey}"`);
    }

    // 表示会社名の正規化（原文 company.name は変更しない）
    const displayName = resolveDisplayName(sanitized, companyKey);
    if (displayName && displayName !== sanitized.company.name) {
      log("company", `displayName 設定: "${displayName}"（原文: "${sanitized.company.name}"）`);
    }

    // D) company_profiles.json の定型差し込み（4項目のみ: hours/holidays/benefits/insurance）
    const defaultsResult = applyCompanyDefaults(sanitized, companyKey);
    if (defaultsResult.applied) {
      log("inject", `companyKey=${companyKey}, fields=${defaultsResult.appliedFields.join(",")}`, {
        sources: defaultsResult.sources,
      });
    }

    // 旧 company_static は下位互換として残す
    const mergeResult = mergeCompanyStatic(sanitized, companyKey, ENABLE_COMPANY_STATIC);
    if (mergeResult.staticApplied) {
      log("company", "company_static 注入", { keys: mergeResult.staticAppliedKeys });
    }

    // 注入されたフィールドの一覧（faithfulness 除外用）
    const injectedFields = [
      ...defaultsResult.appliedFields,
      ...mergeResult.staticAppliedKeys,
    ];

    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    // --- B) 中間成果物を先行保存（バリデーション失敗でも必ず残す）---
    let artifactDir: string;
    if (OUTPUT_DIR) {
      artifactDir = OUTPUT_DIR;
    } else {
      const hash = makeHash(String(url ?? "") + normalized.slice(0, 200));
      const companyPart = sanitizePathSegment(sanitized.company.name || "unknown");
      const positionPart = sanitizePathSegment(sanitized.position.title || "unknown");
      artifactDir = path.join(DATA_DIR, dateStr(), `${companyPart}_${positionPart}_${hash}`);
    }
    ensureDir(artifactDir);
    log("generate", "出力先", { artifactDir });

    if (rawHtml && typeof rawHtml === "string") {
      fs.writeFileSync(path.join(artifactDir, "job_raw.html"), rawHtml, "utf8");
    }
    fs.writeFileSync(path.join(artifactDir, "job_raw.md"), normalized, "utf8");

    const extractReport = {
      url: url || null,
      title: title || null,
      siteHint: siteHint || null,
      extractMeta: extractMeta ?? null,
      extractedLength,
      minExtractedChars: MIN_EXTRACTED_CHARS,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "extract_report.json"), JSON.stringify(extractReport, null, 2), "utf8");

    // 中間成果物保存（job.json + job_structured.md）
    saveIntermediateArtifacts(artifactDir, sanitized, normalized, typeof rawHtml === "string" ? rawHtml : undefined);

    // --- バリデーション ---
    if (!sanitized.company?.name?.trim()) {
      const reqResult = requiredFieldsCheck(sanitized);
      saveMissingRequiredReport(artifactDir, reqResult, warnings, "構造化結果に企業名がありません。");
      return res.status(400).json({
        error: {
          code: "JOB_JSON_EMPTY_OR_INVALID",
          message: "構造化結果に企業名がありません。",
          missing: ["company.name", ...reqResult.missingKeys],
          details: reqResult.details,
          warnings,
        },
      });
    }
    if (!sanitized.position?.title?.trim()) {
      const reqResult = requiredFieldsCheck(sanitized);
      saveMissingRequiredReport(artifactDir, reqResult, warnings, "構造化結果にポジション名がありません。");
      return res.status(400).json({
        error: {
          code: "JOB_JSON_EMPTY_OR_INVALID",
          message: "構造化結果にポジション名がありません。",
          missing: ["position.title", ...reqResult.missingKeys],
          details: reqResult.details,
          warnings,
        },
      });
    }

    // 真の必須欠落チェック — 業務内容/勤務地/賃金のみ停止
    //   overrides / company_static 適用後に判定（埋まっていれば通過）
    const reqResult = requiredFieldsCheck(sanitized);
    if (!reqResult.ok) {
      saveMissingRequiredReport(artifactDir, reqResult, warnings);
      return res.status(400).json({
        error: {
          code: "REQUIRED_FIELD_MISSING",
          message: `必須項目が取得できません: ${reqResult.missingKeys.join(", ")}`,
          missing: reqResult.missingKeys,
          details: reqResult.details,
          warnings,
        },
      });
    }

    // 任意項目の欠落警告（停止しない）
    const optResult = optionalFieldWarnings(sanitized);
    if (optResult.warnings.length > 0) {
      warnings.push(...optResult.warnings);
      log("generate", "任意項目欠落（停止なし）", { missing: optResult.warnings });
    }

    // faithfulness チェック（常に警告のみ — 停止しない）
    //   overrides / company_static で注入したフィールドは除外
    const faithResult = faithfulnessCheck(sanitized, normalized, injectedFields);
    const faithErrors = toFaithfulnessErrors(faithResult);

    if (!faithResult.ok) {
      log("generate", "言い換え検出（警告）", { count: faithResult.missing.length });

      // paraphrase_report.json を必ず保存
      saveParaphraseReport(artifactDir, faithResult);

      // 警告として記録し処理続行（停止しない）
      warnings.push(`PARAPHRASE_WARNING: 原文と異なる表現の可能性（${faithResult.missing.length}件）。詳細は paraphrase_report.json を確認してください。`);
    }

    warnings.push(...buildWarnings(sanitized));
    warnings.push(...sanitized.compliance.warnings);

    const showFixedOvertime = hasFixedOvertimeKeywords(normalized);

    // --- 最終成果物の上書き保存（バリデーション通過後）---
    const structuredMd = buildStructuredMarkdown(sanitized, normalized);
    fs.writeFileSync(path.join(artifactDir, "job_structured.md"), structuredMd, "utf8");

    const jobWithMeta: Record<string, unknown> = { ...sanitized };
    if (mergeResult.staticApplied) {
      jobWithMeta.static_applied = true;
      jobWithMeta.static_applied_keys = mergeResult.staticAppliedKeys;
    }
    // 監査用: injected メタデータ
    if (defaultsResult.applied) {
      jobWithMeta.meta = {
        injected: {
          fields: defaultsResult.appliedFields,
          sources: defaultsResult.sources,
        },
      };
    }
    fs.writeFileSync(path.join(artifactDir, "job.json"), JSON.stringify(jobWithMeta, null, 2), "utf8");

    const meta = {
      schemaVersion: "museum_jobposting_v0.3",
      phase: "structured",
      warnings,
      faithViolations: faithErrors.length > 0 ? faithErrors : undefined,
      showFixedOvertime,
      url: url || undefined,
      title: title || undefined,
      jobTitle: typeof jobTitle === "string" ? jobTitle : undefined,
      siteHint: siteHint || undefined,
      extractedLength,
      companyName: sanitized.company.displayName ?? sanitized.company.name,
      companyNameOriginal: sanitized.company.name,
      companyKey: companyKey ?? undefined,
      provenance: Object.keys(mergeResult.provenance).length > 0 ? mergeResult.provenance : undefined,
      injected: defaultsResult.applied
        ? { fields: defaultsResult.appliedFields, sources: defaultsResult.sources, sourceUrl: defaultsResult.sourceUrl }
        : undefined,
      positionTitle: sanitized.position.title,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

    const sessionId = toRunId(artifactDir);
    log("generate", "保存完了", { sessionId });

    // レスポンス（旧互換: sessionId も返す）
    return res.json({
      runId: sessionId,
      sessionId,
      job: sanitized,
      structuredMd,
      suggestedFilename: buildSuggestedFilename(
        typeof jobTitle === "string" ? jobTitle : typeof title === "string" ? title : undefined,
        sanitized.position.title,
        sanitized.company.displayName ?? sanitized.company.name
      ),
      meta: {
        warnings,
        faithViolations: faithErrors.length > 0 ? faithErrors : undefined,
        showFixedOvertime,
      },
    });
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.status ?? (error as any)?.response?.status;
    let code = "INTERNAL_ERROR";
    let message = "不明なエラーが発生しました";
    if (status === 429 || detail.includes("429") || detail.includes("quota")) {
      code = "OPENAI_QUOTA_EXCEEDED";
      message = "OpenAI APIの利用上限に達しています。";
    } else if (detail.includes("LLM_INVALID_JSON")) {
      code = "LLM_INVALID_JSON";
      message = "AIの構造化結果が不正です。もう一度お試しください。";
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

// 起動時に保存先ディレクトリを確認/作成
try {
  ensureStorageDirs();
} catch (e) {
  console.error("[storage] 保存先ディレクトリ作成失敗:", e);
}

app.listen(port, () => {
  const cfg = loadStorageConfig();
  console.log(`Museum JobTool Ver 0.3.6 — Server listening on port ${port}`);
  console.log(`  jobDocxDir:   ${cfg.jobDocxDir}`);
  console.log(`  scoutTextDir: ${cfg.scoutTextDir}`);
  if (OUTPUT_DIR) console.log(`  OUTPUT_DIR: ${OUTPUT_DIR}`);
  if (ENABLE_COMPANY_STATIC) console.log(`  ENABLE_COMPANY_STATIC: ON`);
  if (STRICT_NO_PARAPHRASE) console.log(`  STRICT_NO_PARAPHRASE: ON (言い換え検出で停止)`);
});
