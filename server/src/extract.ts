export const normalizeRawText = (rawText: string): string => {
  return rawText.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const listToText = (items?: string[]): string => {
  if (!items || items.length === 0) {
    return "";
  }
  return items.filter((item) => item && item.trim() !== "").map((item) => `・${item}`).join("\n");
};

// ---------------------------------------------------------------------------
// 〒郵便番号整形: 3桁-4桁 → 〒3桁-4桁（既に〒がある場合は追加しない）
// ---------------------------------------------------------------------------
export const formatPostalCode = (text: string): string => {
  return text.replace(/(^|[^〒])(\d{3}-\d{4})/g, "$1〒$2");
};

// ---------------------------------------------------------------------------
// 可読性整形（限定許可）: render直前に適用
//   - 「・」「■」「●」の前で改行
//   - 「【必須】」「【歓迎】」の前で改行
//   - 連続空白整理
// 意味変更は禁止。
// ---------------------------------------------------------------------------
export const formatReadability = (text: string): string => {
  let result = text;
  // 「・」「■」「●」の前で改行（既に改行がある場合は追加しない）
  result = result.replace(/([^\n])(・|■|●)/g, "$1\n$2");
  // 「【必須】」「【歓迎】」の前で改行
  result = result.replace(/([^\n])(【必須】|【歓迎】)/g, "$1\n$2");
  // 連続空白整理（改行以外の連続空白→1個）
  result = result.replace(/[^\S\n]{2,}/g, " ");
  return result;
};

// ---------------------------------------------------------------------------
// 固定残業代関連語の検出
// ---------------------------------------------------------------------------
const FIXED_OVERTIME_KEYWORDS = [
  "固定残業", "みなし残業", "定額残業", "見込み残業",
  "固定時間外", "みなし時間外"
];

export const hasFixedOvertimeKeywords = (rawText: string): boolean => {
  return FIXED_OVERTIME_KEYWORDS.some((kw) => rawText.includes(kw));
};
