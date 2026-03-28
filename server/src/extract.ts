// ---------------------------------------------------------------------------
// 丸数字（①〜⑳）→ "1) " 形式に変換（NFKC前に適用必須）
// NFKCは①を素の "1" に変換し直後テキストと連結して不自然になるため、
// NFKC適用前にスペース付き番号形式へ展開する。
// ---------------------------------------------------------------------------
const CIRCLED_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

export const replaceCircledNumbers = (text: string): string => {
  let result = text;
  for (let i = 0; i < CIRCLED_NUMBERS.length; i++) {
    result = result.replaceAll(CIRCLED_NUMBERS[i], `${i + 1}) `);
  }
  return result;
};

export const normalizeRawText = (rawText: string): string => {
  // 丸数字展開 → NFKC正規化 → 改行整理
  return replaceCircledNumbers(rawText).normalize("NFKC").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

// ---------------------------------------------------------------------------
// blockquote / >記号セクション抽出（サーバーサイド・依存ライブラリなし）
// ---------------------------------------------------------------------------

export type ExtractedSection = {
  label: string;
  value: string;
  domTag: string;
  snippet: string;
};

// HTMLエンティティを最低限デコード
const decodeEntities = (s: string): string =>
  s.replace(/&nbsp;/g, " ")
   .replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">")
   .replace(/&amp;/g, "&")
   .replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'");

// タグを除去してプレーンテキスト化
const stripTags = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

// ---------------------------------------------------------------------------
// 軽量HTMLトークナイザー
// ブロック要素を順番にトークンとして返す（ネスト非対応だが HRMOS に十分）
// ---------------------------------------------------------------------------
type HtmlToken = { tag: string; text: string };

const BLOCK_TAGS = ["blockquote", "ul", "ol", "p", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6"];

const tokenizeHtml = (html: string): HtmlToken[] => {
  const tokens: HtmlToken[] = [];
  const lower = html.toLowerCase();
  let pos = 0;

  while (pos < html.length) {
    const ltIdx = lower.indexOf("<", pos);
    if (ltIdx === -1) break;

    let found = false;
    for (const tag of BLOCK_TAGS) {
      const openStr = `<${tag}`;
      if (lower.startsWith(openStr, ltIdx)) {
        const afterTag = lower[ltIdx + openStr.length];
        if (!afterTag || afterTag === ">" || afterTag === " " || afterTag === "\n" || afterTag === "\r" || afterTag === "/") {
          const closeStr = `</${tag}>`;
          const closeIdx = lower.indexOf(closeStr, ltIdx + openStr.length);
          if (closeIdx !== -1) {
            const inner = html.slice(ltIdx, closeIdx + closeStr.length);
            const text = stripTags(inner).normalize("NFKC").replace(/\s+/g, " ").trim();
            tokens.push({ tag, text });
            pos = closeIdx + closeStr.length;
            found = true;
            break;
          }
        }
      }
    }

    if (!found) pos = ltIdx + 1;
  }

  return tokens;
};

// ---------------------------------------------------------------------------
// extractBlockquoteSections: rawHtml から blockquote / > 形式セクションを抽出
// ---------------------------------------------------------------------------
export const extractBlockquoteSections = (rawHtml: string): ExtractedSection[] => {
  const tokens = tokenizeHtml(rawHtml);
  const sections: ExtractedSection[] = [];
  const seen = new Set<string>();
  const VALUE_TAGS = new Set(["ul", "ol", "p", "div", "li"]);

  const collectValue = (startIdx: number): string => {
    const parts: string[] = [];
    for (let i = startIdx; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.tag === "blockquote") break;
      if (/^h[1-6]$/.test(t.tag)) break;
      if (t.text.startsWith(">") || t.text.startsWith("＞")) break;
      if (VALUE_TAGS.has(t.tag) && t.text) parts.push(t.text);
    }
    return parts.join("\n").trim();
  };

  for (let i = 0; i < tokens.length; i++) {
    const { tag, text } = tokens[i];

    // Pattern A: <blockquote> が見出しとして使われているケース
    if (tag === "blockquote") {
      if (!text || text.length > 60) continue;
      const label = text.replace(/^[>＞]\s*/, "").trim();
      if (!label || seen.has(label)) continue;
      const value = collectValue(i + 1);
      if (value) {
        seen.add(label);
        sections.push({ label, value, domTag: "blockquote", snippet: value.slice(0, 120) });
      }
      continue;
    }

    // Pattern B: テキストが > または ＞ で始まる要素が見出しとして使われているケース
    if (["p", "div", "span", "li"].includes(tag)) {
      if (!text.startsWith(">") && !text.startsWith("＞")) continue;
      const label = text.replace(/^[>＞]\s*/, "").trim();
      if (!label || label.length > 60 || seen.has(label)) continue;
      const value = collectValue(i + 1);
      if (value) {
        seen.add(label);
        sections.push({ label, value, domTag: "blockquote-text", snippet: value.slice(0, 120) });
      }
    }
  }

  return sections;
};

// ---------------------------------------------------------------------------
// mergeBlockquoteSections: 既存セクションに blockquote 由来セクションをマージ
// 既存ラベルと重複するものは追加しない
// ---------------------------------------------------------------------------
export const mergeBlockquoteSections = (
  existingSections: ExtractedSection[],
  rawHtml: string,
  existingMethod: string = ""
): { sections: ExtractedSection[]; method: string } => {
  const blockquoteSections = extractBlockquoteSections(rawHtml);
  const existingLabels = new Set(existingSections.map((s) => s.label));
  const additional = blockquoteSections.filter((s) => !existingLabels.has(s.label));
  const sections = [...existingSections, ...additional];
  const method = additional.length > 0
    ? `${existingMethod}+blockquote(${additional.length})`
    : existingMethod;
  return { sections, method };
};
