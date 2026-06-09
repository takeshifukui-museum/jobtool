import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobPostingSchema, JobPosting } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

export type GenerateInput = {
  url: string;
  title: string;
  rawText: string;
  siteHint: string;
};

const buildJobPrompt = (input: GenerateInput) => {
  return `あなたは求人票の構造化エキスパートです。次のWebページ本文をもとに、指定のJSONスキーマで求人票を作成してください。

# 入力情報
URL: ${input.url}
タイトル: ${input.title}
サイトヒント: ${input.siteHint}

# 本文
${input.rawText}

# 出力ルール
- JSONスキーマに厳密準拠
- schemaVersion は museum_jobposting_v1
- あなたの仕事は「要約」ではなく「分類」です。原文の順序をできるだけ保ち、原文に無い推測はしない
- 【加工禁止＝原文そのまま必須】次の項目は、本文から該当箇所をできるだけそのままコピペして格納する（言い換え・要約・再構成禁止）
  - 業務内容: job.responsibilities[]（原文の箇条書き/文を1行ずつ、順序維持）
  - 求める経験・スキル（必須/歓迎）: requirements.must[] / requirements.want[]（原文の箇条書き/文を1行ずつ、順序維持）
  - 年収・待遇（賃金）: salary.summary（原文の該当文/行をそのまま。賃金は必須）
  - 休日休暇: work.holidays（原文の該当文をそのまま）
  - 福利厚生: benefits.items[]（原文の箇条書き/文を1行ずつ、順序維持）
- salary.details[] は年収レンジ等の原文行をそのまま（無ければ空配列）
- 固定残業代がある場合は salary.fixedOvertime.includedHours と excessPayment に「原文の表現をそのまま」入れる（無い場合は空文字でよい）
- 時間外労働: 情報が無い場合は work.overtime.exists=false, details="" とする（推測しない）
- compliance.forbiddenDetected/warnings は空配列でよい
- 禁止転載(性別/年齢/国籍/病歴)は含めない
`;
};

export const generateJobPosting = async (input: GenerateInput): Promise<JobPosting> => {
  try {
    const response = await client.messages.create({
      model: process.env.MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      system: "あなたは求人票JSONを生成するアシスタントです。",
      messages: [
        {
          role: "user",
          content: buildJobPrompt(input)
        }
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: jobPostingSchema as Record<string, unknown>
        }
      }
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const outputText = textBlock?.type === "text" ? textBlock.text.trim() : "";
    if (!outputText) {
      throw new Error("LLM_INVALID_JSON");
    }
    try {
      return JSON.parse(outputText) as JobPosting;
    } catch {
      throw new Error("LLM_INVALID_JSON");
    }
  } catch (err) {
    // #region agent log (debug mode)
    const anyErr = err as any;
    dbg({
      location: "server/src/openai.ts:generateJobPosting:error",
      message: "Anthropic call failed",
      data: {
        name: anyErr?.name,
        status: anyErr?.status,
        code: anyErr?.code,
        type: anyErr?.type,
        message: anyErr?.message
      },
      runId: "pre-fix",
      hypothesisId: "H1_H2_H3"
    });
    // #endregion
    throw err;
  }
};

const SCOUT_TEMPLATE_PATH = path.resolve(__dirname, "..", "..", "config", "scout_template.md");

const loadScoutTemplate = (): { system: string; user: string } => {
  const raw = fs.readFileSync(SCOUT_TEMPLATE_PATH, "utf8");
  const sysMarker = "## システムプロンプト（AIへの指示）";
  const usrMarker = "## ユーザープロンプト（差し込みテンプレ）";
  const sysIdx = raw.indexOf(sysMarker);
  const usrIdx = raw.indexOf(usrMarker);
  const system = sysIdx >= 0 && usrIdx >= 0
    ? raw.slice(sysIdx + sysMarker.length, usrIdx).trim()
    : "あなたはMuseumのスカウト文作成者です。";
  const user = usrIdx >= 0
    ? raw.slice(usrIdx + usrMarker.length).trim()
    : "スカウト文を作成してください。";
  return { system, user };
};

export const generateScoutText = async (job: JobPosting): Promise<string> => {
  const template = loadScoutTemplate();
  const jobSummary = JSON.stringify(job, null, 2);
  const companyName = (job as any).company?.displayName ?? job.company.name ?? "";
  const positionTitle = job.position.title ?? "";

  const userPrompt = template.user
    .replace(/\{\{company_name\}\}/g, companyName)
    .replace(/\{\{position_title\}\}/g, positionTitle)
    .replace(/\{\{job_summary\}\}/g, jobSummary);

  const response = await client.messages.create({
    model: process.env.MODEL || "claude-sonnet-4-6",
    max_tokens: 8192,
    system: template.system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text.trim() : "";
};
