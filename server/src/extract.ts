export const normalizeRawText = (rawText: string): string => {
  return rawText.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const listToText = (items?: string[]): string => {
  if (!items || items.length === 0) {
    return "";
  }
  return items
    .filter((item) => item && item.trim() !== "")
    .map((item) => {
      // 先頭の「・」「■」「●」「-」を除去して再付与（二重ブレット防止）
      const cleaned = item.replace(/^[・■●\-]\s*/, "").trim();
      return cleaned ? `・${cleaned}` : "";
    })
    .filter(Boolean)
    .join("\n");
};

// ---------------------------------------------------------------------------
// 箇条書き整形: "・A ・B" → "\n・A\n・B" に分割（意味変更なし）
// ---------------------------------------------------------------------------
export const formatBullets = (text: string): string => {
  // 行内の「 ・」を改行 + 「・」に置換
  return text.replace(/ ・/g, "\n・");
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
  // 「・」「■」「●」の前で改行（括弧内を除外、既に改行がある場合は追加しない）
  // 括弧内（（…）、「…」）の「・」は分割しない
  let result = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "（" || ch === "(" || ch === "「") depth++;
    else if (ch === "）" || ch === ")" || ch === "」") depth = Math.max(0, depth - 1);

    if (depth === 0 && (ch === "・" || ch === "■" || ch === "●")) {
      // 直前が改行でなければ改行を挿入
      if (i > 0 && text[i - 1] !== "\n") {
        result += "\n";
      }
    }
    result += ch;
  }
  // 「【必須】」「【歓迎】」の前で改行
  result = result.replace(/([^\n])(【必須】|【歓迎】)/g, "$1\n$2");
  // 連続空白整理（改行以外の連続空白→1個）
  result = result.replace(/[^\S\n]{2,}/g, " ");
  return result;
};

// ---------------------------------------------------------------------------
// 郵便番号後の改行挿入: 〒xxx-xxxx の直後に改行（就業場所向け）
// ---------------------------------------------------------------------------
export const formatPostalCodeLineBreak = (text: string): string => {
  // 〒xxx-xxxx の後にスペースが続く場合 → 改行に変換（既に改行なら何もしない）
  return text.replace(/(〒\d{3}-\d{4})[ \t]+/g, "$1\n");
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
