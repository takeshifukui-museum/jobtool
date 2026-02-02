import OpenAI from "openai";
import { jobPostingSchema, JobPosting } from "./schema.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `あなたは求人情報を構造化データに変換する専門家です。

【最重要ルール - 法令順守】

■ 加工禁止（絶対厳守）
以下の項目は「読みやすさ」を理由にしても、要約・言い換え・再構成を禁止します。原文をそのまま一字一句変えずに出力してください：
- 業務内容（job）
- 求めるスキル（requirements）
- 年収・待遇（salary）
- 休日休暇（work.holidays）
- 福利厚生（benefits）

■ 転載禁止項目（絶対に出力しない）
元情報に記載があっても、以下は絶対に出力に含めないでください：
- 性別に関する条件
- 年齢に関する条件
- 身体的特徴に関する条件
- 病歴に関する条件
- 国籍に関する条件

■ 必須掲載項目
情報がある限り必ず記載：
- 業務内容
- 契約期間
- 就業場所・就業時刻
- 休憩時間・休日休暇
- 賃金（必須）
- 社会保険

■ 賃金ルール
- 賃金は必ず記載
- 固定残業代がある場合は必ず明記（含まれる時間数・超過分の扱い）

■ 時間外労働
- 情報がない場合は空文字列を設定

■ 表記ルール
- 「応募資格」という表記は禁止 → 「求める経験・スキル」に統一
- 誇張・断定・補足説明の追加は禁止

■ 出力形式
- schemaVersion: "1.0"
- source: 元のURL
- 各フィールドは原文を忠実に転記
- 不明な項目は空文字列または空配列`;

export async function extractJobPosting(
  htmlContent: string,
  sourceUrl: string
): Promise<JobPosting> {
  const userPrompt = `以下のHTML/テキストから求人情報を抽出し、JSON形式で出力してください。

【注意】
- 業務内容、スキル要件、給与、休日、福利厚生は原文をそのまま転記（要約・言い換え禁止）
- 性別・年齢・身体的特徴・病歴・国籍に関する記述は除外
- 時間外労働の情報がなければ overtime は空文字列
- 賃金は必ず記載（固定残業代があれば詳細も含める）

元URL: ${sourceUrl}

--- HTMLコンテンツ ---
${htmlContent}
--- ここまで ---`;

  const response = await client.responses.create({
    model: "gpt-4o",
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "job_posting",
        strict: true,
        schema: jobPostingSchema,
      },
    },
  });

  // Extract the text content from the response
  const outputText = response.output_text;

  if (!outputText) {
    throw new Error("OpenAI API returned empty response");
  }

  const parsed: JobPosting = JSON.parse(outputText);

  // Ensure schemaVersion and source are set
  parsed.schemaVersion = "1.0";
  parsed.source = sourceUrl;

  return parsed;
}
