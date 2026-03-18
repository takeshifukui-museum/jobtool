import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { generateJobPosting, generateScoutText } from "./openai.js";
import { sanitizeJobPosting } from "./sanitize.js";
import { normalizeRawText } from "./extract.js";
import { renderJobDocx, resolveTemplatePath, getTemplateStat } from "./word.js";
import { JobPosting } from "./schema.js";

// #region agent log (debug mode)
const DEBUG_ENDPOINT = "http://127.0.0.1:7243/ingest/17ed477e-d29e-46f0-9713-bddaa4a1a07d";
const dbg = (payload: { location: string; message: string; data?: Record<string, unknown>; runId: string; hypothesisId: string }) => {
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, timestamp: Date.now() })
  }).catch(() => {});
};
// #endregion

const log = (msg: string, data?: Record<string, unknown>) => {
  console.log(`[generate] ${msg}`, data ?? "");
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const MIN_EXTRACTED_CHARS = Number(process.env.MIN_EXTRACTED_CHARS || 300);

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

const buildStructuredMarkdown = (job: JobPosting): string => {
  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? `時間外労働: ${job.work.overtime.details}`
      : job.work.overtime.exists
        ? "時間外労働あり"
        : "時間外労働なし"
    : "";

  const fixedOvertimeText = job.salary.fixedOvertime
    ? [job.salary.fixedOvertime.includedHours, job.salary.fixedOvertime.excessPayment, job.salary.fixedOvertime.notes]
        .filter((x) => x && x.trim() !== "")
        .join("\n")
    : "";

  return [
    `# 求人票（構造化）`,
    ``,
    `## 企業`,
    `- 企業名: ${job.company.name || "（不明）"}`,
    `- 企業概要: ${job.company.summary || "（記載なし）"}`,
    ``,
    `## 採用ポジション`,
    `- タイトル: ${job.position.title || "（不明）"}`,
    `- 雇用形態: ${job.position.employmentType || "（記載なし）"}`,
    `- 契約期間: ${job.position.contractTerm || "（記載なし）"}`,
    `- 試用期間: ${job.position.probation || "（記載なし）"}`,
    ``,
    `## 業務内容（原文そのまま）`,
    listToMd(job.job.responsibilities),
    job.job.notes ? `\n\n補足:\n${job.job.notes}` : ``,
    ``,
    `## 求める経験・スキル（原文そのまま）`,
    `### 必須`,
    listToMd(job.requirements.must),
    ``,
    `### 歓迎`,
    listToMd(job.requirements.want),
    ``,
    `## 勤務条件`,
    `- 勤務地: ${job.work.location || "（記載なし）"}`,
    `- 勤務時間: ${job.work.hours || "（記載なし）"}`,
    `- 休憩時間: ${job.work.breakTime || "（記載なし）"}`,
    `- 休日休暇（原文そのまま）: ${job.work.holidays || "（記載なし）"}`,
    overtimeText ? `- 時間外労働: ${overtimeText.replace(/^時間外労働:\s*/, "")}` : ``,
    ``,
    `## 賃金・待遇（原文そのまま）`,
    `- 賃金: ${job.salary.summary || "（必須）"}`,
    job.salary.details && job.salary.details.length > 0 ? `\n${listToMd(job.salary.details)}` : ``,
    fixedOvertimeText ? `\n\n固定残業代:\n${fixedOvertimeText}` : ``,
    ``,
    `## 福利厚生（原文そのまま）`,
    listToMd(job.benefits.items),
    ``,
    `## 社会保険`,
    `- ${job.insurance.socialInsurance || "（記載なし）"}`,
    ``,
    `## 選考プロセス`,
    `- ${job.selection.process || "（記載なし）"}`,
    ``,
    `---`,
    `source: ${job.source.url}`
  ]
    .filter((x) => x !== "")
    .join("\n");
};

const ensureDataDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

const saveIntermediateArtifacts = (
  dir: string,
  payload: {
    job_raw: string;
    job_structured: string;
    job_json: JobPosting;
    output_docx: Buffer;
    meta: Record<string, unknown>;
  }
): void => {
  ensureDataDir(dir);
  fs.writeFileSync(path.join(dir, "job_raw.md"), payload.job_raw, "utf8");
  fs.writeFileSync(path.join(dir, "job_structured.md"), payload.job_structured, "utf8");
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(payload.job_json, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "output.docx"), payload.output_docx);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(payload.meta, null, 2), "utf8");
};

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!allowedOrigin) {
        return callback(null, true);
      }
      if (!origin || origin === allowedOrigin) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    }
  })
);
app.use(express.json({ limit: "4mb" }));

app.post("/api/generate", async (req, res) => {
  try {
    const { url, title, rawText, siteHint } = req.body ?? {};

    // #region agent log (debug mode)
    dbg({
      location: "server/src/index.ts:api_generate:entry",
      message: "request received",
      data: {
        hasUrl: Boolean(url),
        hasTitle: Boolean(title),
        hasJobTitle: typeof req.body?.jobTitle === "string",
        rawTextLen: typeof rawText === "string" ? rawText.length : String(rawText ?? "").length,
        siteHint: typeof siteHint === "string" ? siteHint : undefined
      },
      runId: "pre-fix",
      hypothesisId: "H4_H5"
    });
    // #endregion

    if (!rawText || String(rawText).trim() === "") {
      return res.status(400).json({ error: { code: "TEXT_EXTRACTION_EMPTY", message: "rawText is empty" } });
    }

    const normalizedText = normalizeRawText(String(rawText));
    const extractedLength = normalizedText.length;
    log("抽出テキスト文字数", { extractedLength, min: MIN_EXTRACTED_CHARS });
    if (extractedLength === 0) {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "抽出テキストが0文字です。ページ本文を取得できませんでした。" }
      });
    }
    if (extractedLength < MIN_EXTRACTED_CHARS) {
      return res.status(400).json({
        error: {
          code: "TEXT_EXTRACTION_TOO_SHORT",
          message: `抽出テキストが短すぎます（${extractedLength}文字）。ログイン必須/本文未展開/抽出失敗の可能性があります。`
        }
      });
    }

    // #region agent log (debug mode)
    dbg({
      location: "server/src/index.ts:api_generate:before_openai",
      message: "calling OpenAI for structured job",
      data: {
        urlHost: (() => {
          try {
            return new URL(String(url ?? "")).host;
          } catch {
            return null;
          }
        })(),
        normalizedLen: normalizedText.length
      },
      runId: "pre-fix",
      hypothesisId: "H1_H2_H3"
    });
    // #endregion

    const job = await generateJobPosting({
      url: String(url ?? ""),
      title: String(title ?? ""),
      rawText: normalizedText,
      siteHint: String(siteHint ?? "unknown")
    });

    const jobWithCompliance: JobPosting = {
      ...job,
      compliance: job.compliance ?? { forbiddenDetected: [], warnings: [] }
    };

    const { sanitized, forbiddenDetected } = sanitizeJobPosting(jobWithCompliance);
    sanitized.compliance.forbiddenDetected = Array.from(new Set([...sanitized.compliance.forbiddenDetected, ...forbiddenDetected]));

    const companyNameLen = sanitized.company?.name?.length ?? 0;
    const positionTitleLen = sanitized.position?.title?.length ?? 0;
    const jobRespLen = sanitized.job?.responsibilities?.length ?? 0;
    const salarySummaryLen = sanitized.salary?.summary?.length ?? 0;
    log("OpenAI構造化JSON主要項目", {
      companyNameLen,
      positionTitleLen,
      jobRespLen,
      salarySummaryLen
    });
    if (!sanitized.company?.name?.trim() || !sanitized.position?.title?.trim()) {
      return res.status(400).json({
        error: {
          code: "JOB_JSON_EMPTY_OR_INVALID",
          message: "構造化結果に企業名またはポジション名がありません。"
        }
      });
    }

    const warnings: string[] = [];
    if (!sanitized.job.responsibilities || sanitized.job.responsibilities.length === 0) {
      warnings.push("RESPONSIBILITIES_EMPTY");
    }
    if (!sanitized.requirements.must || sanitized.requirements.must.length === 0) {
      warnings.push("REQUIREMENTS_MUST_EMPTY");
    }

    if (!sanitized.salary.summary || sanitized.salary.summary.trim() === "") {
      return res.status(400).json({ error: { code: "SALARY_REQUIRED", message: "salary.summary is required" } });
    }

    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    const scoutText = await generateScoutText(sanitized);
    let templatePath: string;
    try {
      templatePath = resolveTemplatePath();
    } catch (templateErr) {
      const msg = templateErr instanceof Error ? templateErr.message : String(templateErr);
      log("テンプレート解決失敗", { error: msg });
      return res.status(500).json({
        error: { code: "TEMPLATE_NOT_FOUND_OR_EMPTY", message: msg }
      });
    }
    const templateStat = getTemplateStat(templatePath);
    log("テンプレートファイル", { path: templatePath, exists: templateStat.exists, size: templateStat.size });
    if (!templateStat.exists || templateStat.size === 0) {
      return res.status(500).json({
        error: {
          code: "TEMPLATE_NOT_FOUND_OR_EMPTY",
          message: `テンプレートが存在しないか0バイトです: ${templatePath}`
        }
      });
    }

    let docxBuffer: Buffer;
    try {
      log("Word差し込み開始", { templatePath });
      docxBuffer = await renderJobDocx(sanitized, templatePath, {
        rawText: typeof req.body?.rawText === "string" ? req.body.rawText : normalizedText,
        jobTitle: typeof req.body?.jobTitle === "string" ? req.body.jobTitle : undefined
      });
      log("Word差し込み完了", { outputSize: docxBuffer.length });
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      return res
        .status(500)
        .json({ error: { code: "DOCX_RENDER_FAIL", message: "Word生成に失敗しました", detail } });
    }

    const metaWarnings = [...warnings, ...sanitized.compliance.warnings];
    const dateStr = new Date().toISOString().slice(0, 10);
    const companyPart = sanitizePathSegment(sanitized.company.name);
    const positionPart = sanitizePathSegment(sanitized.position.title);
    const hash = crypto
      .createHash("sha256")
      .update(String(url ?? "") + String(Date.now()))
      .digest("hex")
      .slice(0, 8);
    const artifactDir = path.join(DATA_DIR, dateStr, `${companyPart}_${positionPart}_${hash}`);

    try {
      saveIntermediateArtifacts(artifactDir, {
        job_raw: normalizedText,
        job_structured: buildStructuredMarkdown(sanitized),
        job_json: sanitized,
        output_docx: docxBuffer,
        meta: {
          warnings: metaWarnings,
          url: url || undefined,
          title: title || undefined,
          jobTitle: typeof req.body?.jobTitle === "string" ? req.body.jobTitle : undefined,
          siteHint: siteHint || undefined,
          extractedLength: normalizedText.length,
          minExtractedChars: MIN_EXTRACTED_CHARS,
          extractMeta: req.body?.extractMeta ?? undefined,
          templatePath,
          templateSize: templateStat.size,
          companyNameLen,
          positionTitleLen,
          jobRespLen,
          salarySummaryLen,
          savedAt: new Date().toISOString()
        }
      });
    } catch (saveError) {
      console.error("Failed to save intermediate artifacts:", saveError);
    }

    const suggestedFilename = buildSuggestedFilename(
      typeof req.body?.jobTitle === "string" ? req.body.jobTitle : typeof req.body?.title === "string" ? req.body.title : undefined,
      sanitized.position.title
    );
    const docxBase64 = docxBuffer.toString("base64");
    return res.json({
      docx: docxBase64,
      scoutText,
      suggestedFilename,
      meta: {
        warnings: metaWarnings
      }
    });
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    let code = "INTERNAL_ERROR";
    let message = "不明なエラーが発生しました";
    if (detail.includes("テンプレートが") || detail.includes("テンプレートが見つかりません")) {
      code = "TEMPLATE_NOT_FOUND_OR_EMPTY";
      message = detail;
    } else if (detail.includes("Word差し込みに失敗") || detail.includes("docx")) {
      code = "DOCX_RENDER_FAIL";
      message = detail;
    } else if (detail === "LLM_INVALID_JSON" || detail.includes("LLM_INVALID_JSON")) {
      code = "LLM_INVALID_JSON";
      message = "AIの構造化結果が不正です。もう一度お試しください。";
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
