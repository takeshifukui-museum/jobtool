import OpenAI from "openai";
import { jobPostingSchema, JobPosting } from "./schema.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
- 時間外労働: 情報が無い場合は work.overtime.exists=false, details=\"\" とする（推測しない）
- compliance.forbiddenDetected/warnings は空配列でよい
- 禁止転載(性別/年齢/国籍/病歴)は含めない
`;
};

export const generateJobPosting = async (input: GenerateInput): Promise<JobPosting> => {
  try {
    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "あなたは求人票JSONを生成するアシスタントです。"
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildJobPrompt(input)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "museum_jobposting_v1",
          strict: true,
          schema: jobPostingSchema as Record<string, unknown>
        }
      }
    });

    const outputText = response.output_text?.trim() ?? "";
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
      message: "OpenAI call failed",
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

export const generateScoutText = async (job: JobPosting): Promise<string> => {
  const response = await client.responses.create({
    model: process.env.MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "あなたはスカウト文の作成者です。柔らかく寄り添う文体で、断定評価は避けます。求人URLは本文に入れません。署名は必ず指定します。"
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `次の求人票JSONを元に、スカウト文を作成してください。\n\n${JSON.stringify(job, null, 2)}\n\n署名:\n株式会社Museum\n代表取締役\n福井 毅`
          }
        ]
      }
    ]
  });

  return response.output_text?.trim() ?? "";
};
