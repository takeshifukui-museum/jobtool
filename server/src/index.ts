import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { generateJobPosting, generateScoutText } from "./openai.js";
import { sanitizeJobPosting } from "./sanitize.js";
import { normalizeRawText, hasFixedOvertimeKeywords } from "./extract.js";
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
  mergeCompanyStatic,
  type MergeResult,
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
// evidence 検証: rawText 内に evidence が含まれていなければ項目を無効化
// ---------------------------------------------------------------------------
const normalizeForEvidence = (s: string): string =>
  s.replace(/[\r\n\t\u3000]/g, " ").replace(/\s+/g, " ").trim();

type EvidenceSpec = {
  fieldLabel: string;
  evidence: string | undefined;
  getValue: () => string;
  clearValue: () => void;
};

const validateEvidence = (
  job: JobPosting,
  normalizedText: string
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
      clearValue: () => { job.position.title = ""; },
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
    const value = spec.getValue();
    if (!value.trim()) continue; // 値が空ならチェック不要

    const ev = (spec.evidence ?? "").trim();
    if (!ev) {
      // evidence 未提供なのに値がある → 信頼できない
      log("evidence", `EVIDENCE_MISSING: ${spec.fieldLabel} (no evidence provided)`);
      warnings.push(`EVIDENCE_MISSING: ${spec.fieldLabel}`);
      spec.clearValue();
      continue;
    }

    const evNorm = normalizeForEvidence(ev);
    if (!rawNorm.includes(evNorm)) {
      // evidence が rawText に存在しない → ハルシネーションの疑い
      log("evidence", `EVIDENCE_MISSING: ${spec.fieldLabel} (evidence not found in rawText)`, { evidence: ev });
      warnings.push(`EVIDENCE_MISSING: ${spec.fieldLabel}`);
      spec.clearValue();
    }
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

const buildSuggestedFilename = (pageTitle: string | undefined, positionTitle: string): string => {
  const raw = (pageTitle && pageTitle.trim()) || positionTitle || "";
  const title = sanitizeFilename(raw);
  return `求人票_${title || "求人情報"}.docx`;
};

const listToMd = (items: string[] | undefined): string => {
  const list = (items ?? []).filter((x) => x && x.trim() !== "");
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
    `- 企業名: ${job.company.name || "（不明）"}`,
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
    ...(job.requirements.want.filter((x) => x.trim()).length > 0
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
    job.salary.details?.filter((x) => x.trim()).length > 0 ? `\n${listToMd(job.salary.details)}` : ``,
    foLines.length > 0 ? `\n${foLines.join("\n")}` : ``,
    ``,
    // 福利厚生: 空なら非表示
    ...(job.benefits.items.filter((x) => x.trim()).length > 0
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
    const { rawText, rawHtml, url, title, siteHint, extractMeta, runId: inputRunId } = req.body ?? {};

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

    // extract_report.json
    const report = {
      url: url || null,
      title: title || null,
      siteHint: siteHint || null,
      extractMeta: extractMeta ?? null,
      extractedLength,
      minExtractedChars: MIN_EXTRACTED_CHARS,
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
      extractedLength,
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
    const normalizedText = fs.readFileSync(rawMdPath, "utf8");

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

    // (2.5) evidence 検証: rawText 内に根拠が無い項目を無効化
    const evidenceResult = validateEvidence(sanitized, normalizedText);
    const warnings: string[] = [...evidenceResult.warnings];

    // (2.6) 企業名の正規化（トリムのみ。ハードコード辞書は廃止済み）
    applyCompanyNameNormalization(sanitized);

    // (2.7) 【歓迎】マーカーチェック: 原文に無い歓迎スキルは除去
    stripUnfoundedWant(sanitized, normalizedText, warnings);

    // (2.8) company_key 解決 + 企業定型ブロックマージ
    const companyKey = resolveCompanyKey(sanitized.company.name);
    if (companyKey) {
      log("company", `company_key 解決: "${sanitized.company.name}" → "${companyKey}"`);
    }
    const mergeResult = mergeCompanyStatic(sanitized, companyKey, ENABLE_COMPANY_STATIC);
    if (mergeResult.staticApplied) {
      log("company", "company_static 注入", { keys: mergeResult.staticAppliedKeys });
    }

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

    // (6) faithfulness チェック（デフォルト: 警告のみ。STRICT_NO_PARAPHRASE=true で停止）
    const faithResult = faithfulnessCheck(sanitized, normalizedText);
    const faithErrors = toFaithfulnessErrors(faithResult);

    if (!faithResult.ok) {
      log("structure", "言い換え検出", { count: faithResult.missing.length });

      // paraphrase_report.json を必ず保存（根拠を残す）
      saveParaphraseReport(artifactDir, faithResult);

      if (STRICT_NO_PARAPHRASE) {
        // 厳格モード: 1件でも停止
        return res.status(400).json({
          error: {
            code: "FAITHFULNESS_VIOLATION",
            message: `原文と異なる表現が検出されました（${faithResult.missing.length}件）。STRICT_NO_PARAPHRASE=true のため停止。`,
            missing: faithResult.missing,
          },
        });
      }

      // デフォルト: 警告として記録し処理続行
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

    // (8) 成果物保存（static_applied は job.json に内部メタとして追加）
    const structuredMd = buildStructuredMarkdown(sanitized, normalizedText);

    const jobWithMeta = mergeResult.staticApplied
      ? { ...sanitized, static_applied: true, static_applied_keys: mergeResult.staticAppliedKeys }
      : sanitized;
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
      companyName: sanitized.company.name,
      companyKey: companyKey ?? undefined,
      provenance: Object.keys(mergeResult.provenance).length > 0 ? mergeResult.provenance : undefined,
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
      suggestedFilename: buildSuggestedFilename(jobTitle ?? title, sanitized.position.title),
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
// POST /api/render
//   入力: { runId, approve: true }
//   出力: { docx (base64), scoutText, suggestedFilename, meta }
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

    // faithfulness チェック（render 前最終防衛）
    // デフォルト: 警告のみ。STRICT_NO_PARAPHRASE=true の場合のみ停止。
    let showFixedOvertime = true;
    try {
      const rawMd = fs.readFileSync(path.join(artifactDir, "job_raw.md"), "utf8");
      const faithResult = faithfulnessCheck(sanitized, rawMd);
      if (!faithResult.ok) {
        saveParaphraseReport(artifactDir, faithResult);
        if (STRICT_NO_PARAPHRASE) {
          return res.status(400).json({
            error: {
              code: "FAITHFULNESS_VIOLATION",
              message: `原文と異なる表現が検出されました（${faithResult.missing.length}件）。STRICT_NO_PARAPHRASE=true のため停止。`,
              missing: faithResult.missing,
            },
          });
        }
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

    const suggestedFilename = buildSuggestedFilename(sanitized.position.title, sanitized.position.title);

    return res.json({
      docx: docxBuffer.toString("base64"),
      scoutText,
      suggestedFilename,
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
    const { url, title, rawText, rawHtml, siteHint, jobTitle, extractMeta } = req.body ?? {};

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

    // evidence 検証: rawText 内に根拠が無い項目を無効化
    const evidenceResult = validateEvidence(sanitized, normalized);
    const warnings: string[] = [...evidenceResult.warnings];

    // 企業名の正規化（トリムのみ）
    applyCompanyNameNormalization(sanitized);

    // 【歓迎】マーカーチェック
    stripUnfoundedWant(sanitized, normalized, warnings);

    // company_key 解決 + 企業定型ブロックマージ
    const companyKey = resolveCompanyKey(sanitized.company.name);
    if (companyKey) {
      log("company", `company_key 解決: "${sanitized.company.name}" → "${companyKey}"`);
    }
    const mergeResult = mergeCompanyStatic(sanitized, companyKey, ENABLE_COMPANY_STATIC);
    if (mergeResult.staticApplied) {
      log("company", "company_static 注入", { keys: mergeResult.staticAppliedKeys });
    }

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

    // faithfulness チェック（デフォルト: 警告のみ。STRICT_NO_PARAPHRASE=true で停止）
    const faithResult = faithfulnessCheck(sanitized, normalized);
    const faithErrors = toFaithfulnessErrors(faithResult);

    if (!faithResult.ok) {
      log("generate", "言い換え検出", { count: faithResult.missing.length });

      // paraphrase_report.json を必ず保存
      saveParaphraseReport(artifactDir, faithResult);

      if (STRICT_NO_PARAPHRASE) {
        return res.status(400).json({
          error: {
            code: "FAITHFULNESS_VIOLATION",
            message: `原文と異なる表現が検出されました（${faithResult.missing.length}件）。STRICT_NO_PARAPHRASE=true のため停止。`,
            missing: faithResult.missing,
          },
        });
      }

      // デフォルト: 警告として記録し処理続行
      warnings.push(`PARAPHRASE_WARNING: 原文と異なる表現の可能性（${faithResult.missing.length}件）。詳細は paraphrase_report.json を確認してください。`);
    }

    warnings.push(...buildWarnings(sanitized));
    warnings.push(...sanitized.compliance.warnings);

    const showFixedOvertime = hasFixedOvertimeKeywords(normalized);

    // --- 最終成果物の上書き保存（バリデーション通過後）---
    const structuredMd = buildStructuredMarkdown(sanitized, normalized);
    fs.writeFileSync(path.join(artifactDir, "job_structured.md"), structuredMd, "utf8");

    const jobWithMeta = mergeResult.staticApplied
      ? { ...sanitized, static_applied: true, static_applied_keys: mergeResult.staticAppliedKeys }
      : sanitized;
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
      companyName: sanitized.company.name,
      companyKey: companyKey ?? undefined,
      provenance: Object.keys(mergeResult.provenance).length > 0 ? mergeResult.provenance : undefined,
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
        sanitized.position.title
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

app.listen(port, () => {
  console.log(`Museum JobTool Ver 0.3.6 — Server listening on port ${port}`);
  if (OUTPUT_DIR) console.log(`  OUTPUT_DIR: ${OUTPUT_DIR}`);
  if (ENABLE_COMPANY_STATIC) console.log(`  ENABLE_COMPANY_STATIC: ON`);
  if (STRICT_NO_PARAPHRASE) console.log(`  STRICT_NO_PARAPHRASE: ON (言い換え検出で停止)`);
});
