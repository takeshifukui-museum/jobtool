import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobPostingSchema, JobPosting } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type GenerateInput = {
  url: string;
  title: string;
  rawText: string;
  siteHint: string;
};

const buildJobPrompt = (input: GenerateInput) => {
  return `あなたは求人票の構造化エキスパートです。次のWebページ本文をもとに、extract_job_postingツールを使って求人票を構造化してください。

# 入力情報
URL: ${input.url}
タイトル: ${input.title}
サイトヒント: ${input.siteHint}

# 本文
${input.rawText}

# 抽出ルール
- あなたの仕事は「要約」ではなく「分類」です。原文の順序をできるだけ保ち、原文に無い推測はしない
- 出力する値は上記「本文」からのみ抽出すること。推測・補完・他の求人情報の混入は厳禁
- 【加工禁止＝原文そのまま必須】次の項目は、本文から該当箇所をできるだけそのままコピペして格納する
  - 業務内容: job.responsibilities[]（原文の箇条書き/文を1行ずつ、順序維持）
  - 求める経験・スキル（必須/歓迎）: requirements.must[] / requirements.want[]（原文の箇条書き/文を1行ずつ、順序維持）
  - 年収・待遇（賃金）: salary.summary（原文の該当文/行をそのまま。賃金は必須）
  - 休日休暇: work.holidays（原文の該当文をそのまま）
  - 福利厚生: benefits.items[]（原文の箇条書き/文を1行ずつ、順序維持）
- salary.details[] は年収レンジ等の原文行をそのまま（無ければ空配列）
- 固定残業代がある場合:
  - salary.fixedOvertime.amount に金額（原文そのまま）
  - salary.fixedOvertime.includedHours に時間数（原文そのまま）
  - salary.fixedOvertime.excessPayment に超過分の扱い（原文そのまま）
- 時間外労働: 情報が無い場合は work.overtime.exists=false, details="" とする（推測しない）
- compliance.forbiddenDetected/warnings は空配列でよい
- 禁止転載(性別/年齢/国籍/病歴)は含めない

# evidenceルール（最重要）
以下の項目には必ず evidence フィールドを返すこと。
evidence は「本文」中にそのまま存在する短い抜粋（10〜80文字程度）を格納する。
evidence が見つからない項目は空文字で返す（無理に埋めない）。

- company.nameEvidence: 企業名の根拠
- position.titleEvidence: ポジション名の根拠
- position.employmentTypeEvidence: 雇用形態の根拠
- position.contractTermEvidence: 契約期間の根拠
- work.locationEvidence: 勤務地の根拠
- salary.summaryEvidence: 賃金の根拠
`;
};

export const generateJobPosting = async (input: GenerateInput): Promise<JobPosting> => {
  const response = await client.messages.create({
    model: process.env.MODEL || "claude-sonnet-4-6",
    max_tokens: 8192,
    tools: [
      {
        name: "extract_job_posting",
        description: "求人ページから構造化された求人票データを抽出する",
        input_schema: jobPostingSchema as any
      }
    ],
    tool_choice: { type: "tool", name: "extract_job_posting" },
    system: "あなたは求人票の構造化エキスパートです。与えられた求人ページの本文からextract_job_postingツールを使って情報を抽出してください。",
    messages: [
      {
        role: "user",
        content: buildJobPrompt(input)
      }
    ]
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM_INVALID_JSON");
  }
  return toolUse.input as JobPosting;
};

const SCOUT_TEMPLATE_PATH = path.resolve(__dirname, "..", "config", "scout_template.md");

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
  const companyName = job.company.displayName ?? job.company.name ?? "";
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
