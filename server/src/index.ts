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
import { checkFaithfulness } from "./validate.js";

const log = (msg: string, data?: Record<string, unknown>) => {
  console.log(`[generate] ${msg}`, data ?? "");
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const MIN_EXTRACTED_CHARS = Number(process.env.MIN_EXTRACTED_CHARS || 300);

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ver 0.3: 必須欠落チェック（停止条件）
// ---------------------------------------------------------------------------
type RequiredFieldCheck = { label: string; present: boolean };

const checkRequiredFields = (job: JobPosting): RequiredFieldCheck[] => {
  return [
    { label: "業務内容", present: (job.job.responsibilities ?? []).filter((x) => x.trim()).length > 0 },
    { label: "就業場所", present: Boolean(job.work.location?.trim()) },
    { label: "就業時間", present: Boolean(job.work.hours?.trim()) },
    { label: "休日休暇", present: Boolean(job.work.holidays?.trim()) },
    { label: "賃金", present: Boolean(job.salary.summary?.trim()) }
  ];
};

// ---------------------------------------------------------------------------
// Ver 0.3: プレビュー警告生成
// ---------------------------------------------------------------------------
const buildPreviewWarnings = (job: JobPosting): string[] => {
  const warnings: string[] = [];

  // 社会保険未取得
  if (!job.insurance.socialInsurance?.trim()) {
    warnings.push("SOCIAL_INSURANCE_MISSING: 社会保険の情報が取得できませんでした。原文をご確認ください。");
  }

  // 福利厚生未取得
  if (!job.benefits.items || job.benefits.items.filter((x) => x.trim()).length === 0) {
    warnings.push("BENEFITS_MISSING: 福利厚生の情報が取得できませんでした。");
  }

  // 時間外労働未取得
  if (!job.work.overtime || (!job.work.overtime.details?.trim() && job.work.overtime.exists === false)) {
    warnings.push("OVERTIME_MISSING: 時間外労働の情報が取得できませんでした。");
  }

  return warnings;
};

// ---------------------------------------------------------------------------
// buildStructuredMarkdown — Canonical Key 使用（Ver 0.3）
// ---------------------------------------------------------------------------
const buildStructuredMarkdown = (job: JobPosting, rawText?: string): string => {
  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? `時間外労働: ${job.work.overtime.details}`
      : job.work.overtime.exists
        ? "時間外労働あり"
        : ""
    : "";

  // 固定残業代: 原文に関連語がある場合のみ表示
  const showFixedOvertime = rawText ? hasFixedOvertimeKeywords(rawText) : Boolean(
    job.salary.fixedOvertime &&
    ((job.salary.fixedOvertime.amount ?? "").trim() ||
     (job.salary.fixedOvertime.includedHours ?? "").trim() ||
     (job.salary.fixedOvertime.excessPayment ?? "").trim())
  );

  const foLines: string[] = [];
  if (showFixedOvertime && job.salary.fixedOvertime) {
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
    ``,
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
    job.salary.details && job.salary.details.filter((x) => x.trim()).length > 0 ? `\n${listToMd(job.salary.details)}` : ``,
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
    `source: ${job.source.url}`
  ];

  return lines.filter((x) => x !== ``).join("\n");
};

const ensureDataDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

/** artifactDir を作成してパスを返す */
const buildArtifactDir = (companyName: string, positionTitle: string, url: string): string => {
  const dateStr = new Date().toISOString().slice(0, 10);
  const companyPart = sanitizePathSegment(companyName);
  const positionPart = sanitizePathSegment(positionTitle);
  const hash = crypto
    .createHash("sha256")
    .update(String(url ?? "") + String(Date.now()))
    .digest("hex")
    .slice(0, 8);
  return path.join(DATA_DIR, dateStr, `${companyPart}_${positionPart}_${hash}`);
};

/** artifactDir のパスから sessionId を導出（DATA_DIR からの相対パス） */
const toSessionId = (artifactDir: string): string => {
  return path.relative(DATA_DIR, artifactDir);
};

/** sessionId を検証して絶対パスに戻す */
const resolveSessionDir = (sessionId: string): string | null => {
  // パストラバーサル防止
  if (!sessionId || sessionId.includes("..") || path.isAbsolute(sessionId)) return null;
  const resolved = path.resolve(DATA_DIR, sessionId);
  if (!resolved.startsWith(DATA_DIR)) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
};

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

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

// ===========================================================================
// POST /api/generate — fetch/extract/structure → プレビュー用データ返却
//   Word生成はしない。ユーザーがプレビュー確認後に /api/render を呼ぶ。
// ===========================================================================
app.post("/api/generate", async (req, res) => {
  try {
    const { url, title, rawText, rawHtml, siteHint, jobTitle, extractMeta } = req.body ?? {};

    // -----------------------------------------------------------------------
    // (1) fetch ガード: rawText 必須
    // -----------------------------------------------------------------------
    if (!rawText || String(rawText).trim() === "") {
      return res.status(400).json({
        error: { code: "TEXT_EXTRACTION_EMPTY", message: "rawText is empty — ページ本文が取得できませんでした。" }
      });
    }

    // -----------------------------------------------------------------------
    // (2) extract: 正規化 + 文字数チェック
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // (3) structure: OpenAI で構造化
    // -----------------------------------------------------------------------
    log("OpenAI構造化開始");
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

    // sanitize（禁止転載除去）
    const { sanitized, forbiddenDetected } = sanitizeJobPosting(jobWithCompliance);
    sanitized.compliance.forbiddenDetected = Array.from(
      new Set([...sanitized.compliance.forbiddenDetected, ...forbiddenDetected])
    );

    // -----------------------------------------------------------------------
    // (4) 空の求人票 根絶ガード
    // -----------------------------------------------------------------------
    if (!sanitized.company?.name?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果に企業名がありません。ページが求人情報ではない可能性があります。" }
      });
    }
    if (!sanitized.position?.title?.trim()) {
      return res.status(400).json({
        error: { code: "JOB_JSON_EMPTY_OR_INVALID", message: "構造化結果にポジション名がありません。" }
      });
    }

    const mainFieldsFilled = [
      sanitized.job.responsibilities?.length > 0,
      sanitized.requirements.must?.length > 0 || sanitized.requirements.want?.length > 0,
      Boolean(sanitized.work.location?.trim()),
      Boolean(sanitized.salary.summary?.trim())
    ];
    const filledCount = mainFieldsFilled.filter(Boolean).length;
    if (filledCount === 0) {
      return res.status(400).json({
        error: { code: "JOB_JSON_ALL_EMPTY", message: "構造化結果の主要項目がすべて空です。取得したテキストが求人情報ではない可能性があります。" }
      });
    }

    // 時間外労働: 情報が無い場合は項目自体を削除
    if (sanitized.work.overtime && sanitized.work.overtime.exists === false && !sanitized.work.overtime.details) {
      delete sanitized.work.overtime;
    }

    // -----------------------------------------------------------------------
    // (5) Ver 0.3: 必須欠落チェック（停止条件）
    //     業務内容 / 就業場所 / 就業時間 / 休日休暇 / 賃金
    // -----------------------------------------------------------------------
    const requiredChecks = checkRequiredFields(sanitized);
    const missingFields = requiredChecks.filter((c) => !c.present);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: {
          code: "REQUIRED_FIELDS_MISSING",
          message: `必須項目が欠落しています: ${missingFields.map((f) => f.label).join("、")}`,
          missingFields: missingFields.map((f) => f.label)
        }
      });
    }

    // -----------------------------------------------------------------------
    // (6) 言い換え禁止の機械チェック（Ver 0.3: 1件以上でWord生成不可）
    //     job.json の各 value が job_raw.md に部分一致で存在するか検証
    // -----------------------------------------------------------------------
    const faithViolations = checkFaithfulness(sanitized, normalizedText);
    const warnings: string[] = [];

    if (faithViolations.length > 0) {
      warnings.push("FAITHFULNESS_VIOLATIONS_DETECTED");
      log("言い換え検出", { count: faithViolations.length, fields: faithViolations.map((v) => v.field) });
    }

    // Ver 0.3: 言い換え検出があればエラー（Word生成不可）
    if (faithViolations.length >= 5) {
      return res.status(400).json({
        error: {
          code: "FAITHFULNESS_CHECK_FAILED",
          message: `原文忠実性チェックに失敗しました（${faithViolations.length}件の言い換え検出）。AIが原文を大幅に改変しています。`,
          violations: faithViolations
        }
      });
    }

    // -----------------------------------------------------------------------
    // (7) Ver 0.3: プレビュー警告
    // -----------------------------------------------------------------------
    const previewWarnings = buildPreviewWarnings(sanitized);
    warnings.push(...previewWarnings);

    // 固定残業代: 原文に関連語がない場合は fixedOvertime を無効化
    const showFixedOvertime = hasFixedOvertimeKeywords(normalizedText);
    if (!showFixedOvertime && sanitized.salary.fixedOvertime) {
      log("固定残業代: 原文に関連語が無いため非表示");
    }

    // -----------------------------------------------------------------------
    // プレビュー用成果物を保存
    // -----------------------------------------------------------------------
    const structuredMd = buildStructuredMarkdown(sanitized, normalizedText);
    const artifactDir = buildArtifactDir(sanitized.company.name, sanitized.position.title, String(url ?? ""));
    const metaWarnings = [...warnings, ...sanitized.compliance.warnings];

    ensureDataDir(artifactDir);

    // job_raw.html（取り込み結果 — Content Scriptから送られたHTML）
    if (rawHtml && typeof rawHtml === "string") {
      fs.writeFileSync(path.join(artifactDir, "job_raw.html"), rawHtml, "utf8");
    }

    // job_raw.md（抽出結果）
    fs.writeFileSync(path.join(artifactDir, "job_raw.md"), normalizedText, "utf8");

    // extract_report.json
    const extractReport = {
      url: url || null,
      siteHint: siteHint || null,
      extractMeta: extractMeta ?? null,
      extractedLength,
      minExtractedChars: MIN_EXTRACTED_CHARS,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(artifactDir, "extract_report.json"), JSON.stringify(extractReport, null, 2), "utf8");

    // job_structured.md（プレビュー用）
    fs.writeFileSync(path.join(artifactDir, "job_structured.md"), structuredMd, "utf8");

    // job.json（差し込み用）
    fs.writeFileSync(path.join(artifactDir, "job.json"), JSON.stringify(sanitized, null, 2), "utf8");

    // meta.json
    const meta = {
      schemaVersion: "museum_jobposting_v0.3",
      warnings: metaWarnings,
      faithViolations: faithViolations.length > 0 ? faithViolations : undefined,
      showFixedOvertime,
      url: url || undefined,
      title: title || undefined,
      jobTitle: typeof jobTitle === "string" ? jobTitle : undefined,
      siteHint: siteHint || undefined,
      extractedLength,
      companyName: sanitized.company.name,
      positionTitle: sanitized.position.title,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(artifactDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

    const sessionId = toSessionId(artifactDir);
    log("プレビュー成果物保存完了", { sessionId, artifactDir });

    // -----------------------------------------------------------------------
    // レスポンス: プレビュー用データ（docxは含まない）
    // -----------------------------------------------------------------------
    return res.json({
      sessionId,
      job: sanitized,
      structuredMd,
      suggestedFilename: buildSuggestedFilename(
        typeof jobTitle === "string" ? jobTitle : typeof title === "string" ? title : undefined,
        sanitized.position.title
      ),
      meta: {
        warnings: metaWarnings,
        faithViolations: faithViolations.length > 0 ? faithViolations : undefined,
        showFixedOvertime
      }
    });
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.status ?? (error as any)?.response?.status;
    let code = "INTERNAL_ERROR";
    let message = "不明なエラーが発生しました";
    if (status === 429 || detail.includes("429") || detail.includes("quota")) {
      code = "OPENAI_QUOTA_EXCEEDED";
      message = "OpenAI APIの利用上限に達しています。ダッシュボードで課金状況を確認してください。";
    } else if (detail === "LLM_INVALID_JSON" || detail.includes("LLM_INVALID_JSON")) {
      code = "LLM_INVALID_JSON";
      message = "AIの構造化結果が不正です。もう一度お試しください。";
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

// ===========================================================================
// POST /api/render — プレビュー確認後の Word 生成 + スカウト文
//   sessionId を受け取り、保存済み job.json から docx を生成する。
// ===========================================================================
app.post("/api/render", async (req, res) => {
  try {
    const { sessionId } = req.body ?? {};

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({
        error: { code: "SESSION_ID_REQUIRED", message: "sessionId が必要です。先に /api/generate を実行してください。" }
      });
    }

    const artifactDir = resolveSessionDir(sessionId);
    if (!artifactDir) {
      return res.status(400).json({
        error: { code: "SESSION_NOT_FOUND", message: `セッション '${sessionId}' が見つかりません。` }
      });
    }

    // job.json を読み込む
    const jobJsonPath = path.join(artifactDir, "job.json");
    if (!fs.existsSync(jobJsonPath)) {
      return res.status(400).json({
        error: { code: "JOB_JSON_NOT_FOUND", message: "job.json が見つかりません。先に /api/generate を実行してください。" }
      });
    }
    const sanitized: JobPosting = JSON.parse(fs.readFileSync(jobJsonPath, "utf8"));

    // -----------------------------------------------------------------------
    // render 前ガード: 差し込み対象の行数が0ならエラー
    // -----------------------------------------------------------------------
    const renderableFields = [
      sanitized.company?.name,
      sanitized.position?.title,
      sanitized.salary?.summary,
      ...(sanitized.job?.responsibilities ?? []),
      sanitized.work?.location,
      sanitized.work?.hours,
      sanitized.work?.holidays,
      ...(sanitized.benefits?.items ?? [])
    ].filter((v) => v && String(v).trim() !== "");

    if (renderableFields.length === 0) {
      return res.status(400).json({
        error: { code: "RENDER_NO_DATA", message: "差し込み対象のデータが0件です。job.json の内容を確認してください。" }
      });
    }

    // -----------------------------------------------------------------------
    // Ver 0.3: 必須項目チェック（render前の最終防衛）
    // -----------------------------------------------------------------------
    const requiredChecks = checkRequiredFields(sanitized);
    const missingFields = requiredChecks.filter((c) => !c.present);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: {
          code: "REQUIRED_FIELDS_MISSING",
          message: `必須項目が欠落しています: ${missingFields.map((f) => f.label).join("、")}`,
          missingFields: missingFields.map((f) => f.label)
        }
      });
    }

    // -----------------------------------------------------------------------
    // Ver 0.3: 言い換えチェック再検証（render前の最終防衛）
    // -----------------------------------------------------------------------
    let showFixedOvertime = true;
    try {
      const rawMdPath = path.join(artifactDir, "job_raw.md");
      const rawMd = fs.readFileSync(rawMdPath, "utf8");
      const faithViolations = checkFaithfulness(sanitized, rawMd);
      if (faithViolations.length >= 5) {
        return res.status(400).json({
          error: {
            code: "FAITHFULNESS_CHECK_FAILED",
            message: `原文忠実性チェックに失敗しました（${faithViolations.length}件）。Word生成を阻止しました。`,
            violations: faithViolations
          }
        });
      }
      // 固定残業代: 原文に関連語がない場合は非表示
      showFixedOvertime = hasFixedOvertimeKeywords(rawMd);
    } catch {
      // job_raw.md が無い場合はスキップ
    }

    // meta.json から showFixedOvertime を優先取得
    try {
      const metaPath = path.join(artifactDir, "meta.json");
      const metaData = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (typeof metaData.showFixedOvertime === "boolean") {
        showFixedOvertime = metaData.showFixedOvertime;
      }
    } catch { /* ignore */ }

    // -----------------------------------------------------------------------
    // テンプレート解決
    // -----------------------------------------------------------------------
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
    if (!templateStat.exists || templateStat.size === 0) {
      return res.status(500).json({
        error: {
          code: "TEMPLATE_NOT_FOUND_OR_EMPTY",
          message: `テンプレートが存在しないか0バイトです: ${templatePath}`
        }
      });
    }

    // -----------------------------------------------------------------------
    // Word 生成
    // -----------------------------------------------------------------------
    let docxBuffer: Buffer;
    try {
      log("Word差し込み開始", { templatePath, showFixedOvertime });
      // meta.json から jobTitle を取得
      let jobTitle: string | undefined;
      try {
        const metaPath = path.join(artifactDir, "meta.json");
        const metaData = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        jobTitle = metaData.jobTitle;
      } catch { /* ignore */ }

      docxBuffer = await renderJobDocx(sanitized, templatePath, { jobTitle, showFixedOvertime });
      log("Word差し込み完了", { outputSize: docxBuffer.length });
    } catch (error) {
      console.error(error);
      const detail = error instanceof Error ? error.message : String(error);
      return res
        .status(500)
        .json({ error: { code: "DOCX_RENDER_FAIL", message: "Word生成に失敗しました", detail } });
    }

    // -----------------------------------------------------------------------
    // スカウト文生成
    // -----------------------------------------------------------------------
    const scoutText = await generateScoutText(sanitized);

    // -----------------------------------------------------------------------
    // output.docx 保存
    // -----------------------------------------------------------------------
    fs.writeFileSync(path.join(artifactDir, "output.docx"), docxBuffer);
    log("output.docx 保存完了", { dir: artifactDir });

    // meta.json に render 情報を追記
    try {
      const metaPath = path.join(artifactDir, "meta.json");
      const metaData = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      metaData.renderedAt = new Date().toISOString();
      metaData.templatePath = templatePath;
      metaData.templateSize = templateStat.size;
      metaData.docxSize = docxBuffer.length;
      fs.writeFileSync(metaPath, JSON.stringify(metaData, null, 2), "utf8");
    } catch { /* ignore */ }

    // -----------------------------------------------------------------------
    // レスポンス
    // -----------------------------------------------------------------------
    const suggestedFilename = buildSuggestedFilename(
      sanitized.position.title,
      sanitized.position.title
    );
    const docxBase64 = docxBuffer.toString("base64");
    return res.json({
      docx: docxBase64,
      scoutText,
      suggestedFilename,
      meta: { warnings: sanitized.compliance?.warnings ?? [] }
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
    } else if (detail) {
      message = detail;
    }
    return res.status(500).json({ error: { code, message, detail } });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
