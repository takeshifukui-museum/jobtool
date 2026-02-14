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
  toFaithfulnessErrors,
} from "./validate.js";

const log = (tag: string, msg: string, data?: Record<string, unknown>) => {
  console.log(`[${tag}] ${msg}`, data ?? "");
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const MIN_EXTRACTED_CHARS = Number(process.env.MIN_EXTRACTED_CHARS || 300);

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
//   extract 時: data/YYYY-MM-DD/_pending_{hash}/  (runId = "YYYY-MM-DD/_pending_{hash}")
//   structure 後: data/YYYY-MM-DD/{company}_{position}_{hash}/  (runId 更新)
// ---------------------------------------------------------------------------
const toRunId = (artifactDir: string): string => path.relative(DATA_DIR, artifactDir);

const resolveRunDir = (runId: string): string | null => {
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
  if (!job.insurance.socialInsurance?.trim()) {
    w.push("SOCIAL_INSURANCE_MISSING: 社会保険の情報が取得できませんでした。原文をご確認ください。");
  }
  if (!job.benefits.items || job.benefits.items.filter((x) => x.trim()).length === 0) {
    w.push("BENEFITS_MISSING: 福利厚生の情報が取得できませんでした。");
  }
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
    `### 歓迎`,
    listToMd(job.requirements.want),
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
    `## 福利厚生（原文そのまま）`,
    listToMd(job.benefits.items),
    ``,
    `## 社会保険`,
    job.insurance.socialInsurance?.trim() ? `- ${job.insurance.socialInsurance}` : `- （記載なし）`,
    ``,
    job.selection.process?.trim() ? `## 選考プロセス\n- ${job.selection.process}\n` : ``,
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

    // ディレクトリ作成: extract 時は企業名/ポジション不明のため _pending_{hash}
    const hash = makeHash(String(url ?? "") + normalized.slice(0, 200));
    let artifactDir: string;
    if (inputRunId) {
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

    // (3) 空の求人票ガード
    if (!sanitized.company?.name?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果に企業名がありません。ページが求人情報ではない可能性があります。" },
      });
    }
    if (!sanitized.position?.title?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果にポジション名がありません。" },
      });
    }

    // 時間外労働: 情報が無い場合は項目自体を削除
    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    // (4) 必須欠落チェック（停止条件）
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

    // (5) faithfulness チェック
    const faithResult = faithfulnessCheck(sanitized, normalizedText);
    const faithErrors = toFaithfulnessErrors(faithResult);
    const warnings: string[] = [];

    if (!faithResult.ok) {
      warnings.push("FAITHFULNESS_VIOLATIONS_DETECTED");
      log("structure", "言い換え検出", { count: faithResult.missing.length });

      // 致命的（5件以上）は停止
      if (faithResult.missing.length >= 5) {
        return res.status(400).json({
          error: {
            code: "FAITHFULNESS_VIOLATION",
            message: "原文に存在しない文言が混入しています",
            missing: faithResult.missing,
          },
        });
      }
    }

    // (6) プレビュー警告
    warnings.push(...buildWarnings(sanitized));
    warnings.push(...sanitized.compliance.warnings);

    // 固定残業代表示フラグ
    const showFixedOvertime = hasFixedOvertimeKeywords(normalizedText);

    // (7) ディレクトリ名を正式名に更新（_pending_ → company_position_hash）
    let finalDir = artifactDir;
    let finalRunId = runId;
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

    // (8) 成果物保存
    const structuredMd = buildStructuredMarkdown(sanitized, normalizedText);

    fs.writeFileSync(path.join(finalDir, "job.json"), JSON.stringify(sanitized, null, 2), "utf8");
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
      positionTitle: sanitized.position.title,
      jobTitle,
      structuredAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(finalDir, "meta.json"), JSON.stringify(updatedMeta, null, 2), "utf8");

    log("structure", "保存完了", { runId: finalRunId });

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
    let showFixedOvertime = true;
    try {
      const rawMd = fs.readFileSync(path.join(artifactDir, "job_raw.md"), "utf8");
      const faithResult = faithfulnessCheck(sanitized, rawMd);
      if (faithResult.missing.length >= 5) {
        return res.status(400).json({
          error: {
            code: "FAITHFULNESS_VIOLATION",
            message: "原文に存在しない文言が混入しています",
            missing: faithResult.missing,
          },
        });
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

    if (!sanitized.company?.name?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果に企業名がありません。" },
      });
    }
    if (!sanitized.position?.title?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果にポジション名がありません。" },
      });
    }

    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    // 必須欠落チェック
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

    // faithfulness チェック
    const faithResult = faithfulnessCheck(sanitized, normalized);
    const faithErrors = toFaithfulnessErrors(faithResult);
    const warnings: string[] = [];

    if (!faithResult.ok) {
      warnings.push("FAITHFULNESS_VIOLATIONS_DETECTED");
      log("generate", "言い換え検出", { count: faithResult.missing.length });
    }
    if (faithResult.missing.length >= 5) {
      return res.status(400).json({
        error: {
          code: "FAITHFULNESS_VIOLATION",
          message: "原文に存在しない文言が混入しています",
          missing: faithResult.missing,
        },
      });
    }

    warnings.push(...buildWarnings(sanitized));
    warnings.push(...sanitized.compliance.warnings);

    const showFixedOvertime = hasFixedOvertimeKeywords(normalized);

    // --- 保存 ---
    const hash = makeHash(String(url ?? "") + normalized.slice(0, 200));
    const companyPart = sanitizePathSegment(sanitized.company.name);
    const positionPart = sanitizePathSegment(sanitized.position.title);
    const artifactDir = path.join(DATA_DIR, dateStr(), `${companyPart}_${positionPart}_${hash}`);
    ensureDir(artifactDir);

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

    const structuredMd = buildStructuredMarkdown(sanitized, normalized);
    fs.writeFileSync(path.join(artifactDir, "job_structured.md"), structuredMd, "utf8");
    fs.writeFileSync(path.join(artifactDir, "job.json"), JSON.stringify(sanitized, null, 2), "utf8");

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
  console.log(`Museum JobTool Ver 0.3 — Server listening on port ${port}`);
});
