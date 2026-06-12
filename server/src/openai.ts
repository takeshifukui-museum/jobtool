import Anthropic from "@anthropic-ai/sdk";
import { jobPostingSchema, JobPosting } from "./schema.js";
import fs from "node:fs";
import path from "node:path";

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

const loadScoutTemplate = (): { system: string; userTemplate: string } => {
  const candidates = [
    path.resolve(process.cwd(), "config", "scout_template.md"),
    path.resolve(process.cwd(), "..", "config", "scout_template.md"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        const systemMatch = content.match(/## システムプロンプト（AIへの指示）\n([\s\S]*?)(?=## ユーザープロンプト|$)/);
        const userMatch = content.match(/## ユーザープロンプト（差し込みテンプレ）\n([\s\S]*?)$/);
        return {
          system: systemMatch?.[1]?.trim() ?? "あなたはスカウト文の作成者です。",
          userTemplate: userMatch?.[1]?.trim() ?? "{{job_summary}}"
        };
      }
    } catch { /* continue */ }
  }
  return {
    system: "あなたはスカウト文の作成者です。柔らかく寄り添う文体で、断定評価は避けます。求人URLは本文に入れません。",
    userTemplate: "次の求人票データを元にスカウト文を作成してください。\n{{job_summary}}\n\n署名:\n株式会社Museum\n代表取締役\n福井 毅"
  };
};

const buildScoutPrompt = (job: JobPosting): { system: string; user: string } => {
  const template = loadScoutTemplate();
  const jobSummary = JSON.stringify(job, null, 2);
  const companyName = job.company.displayName ?? job.company.name;
  const positionTitle = job.position.title;

  const user = template.userTemplate
    .replace(/{{company_name}}/g, companyName)
    .replace(/{{position_title}}/g, positionTitle)
    .replace(/{{job_summary}}/g, jobSummary);

  return { system: template.system, user };
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

export const generateScoutText = async (job: JobPosting): Promise<string> => {
  const { system, user } = buildScoutPrompt(job);

  const response = await client.messages.create({
    model: process.env.MODEL || "claude-sonnet-4-6",
    max_tokens: 2048,
    system,
    messages: [
      {
        role: "user",
        content: user
      }
    ]
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text.trim() : "";
};