// ---------------------------------------------------------------------------
// Museum JobTool — Content Script (DOM優先抽出 + siteHint別 strategy)
// ---------------------------------------------------------------------------

// ---- 丸数字（①〜⑳）→ "1) " 形式変換 ----
// NFKC は ① を素の "1" に変換し直後テキストと連結するため、先に展開する。
const CIRCLED_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const replaceCircledNumbers = (text) => {
  let result = text;
  for (let i = 0; i < CIRCLED_NUMBERS.length; i++) {
    result = result.replaceAll(CIRCLED_NUMBERS[i], `${i + 1}) `);
  }
  return result;
};

// ---- NFKC 正規化（丸数字展開後に適用） ----
const normalizeNFKC = (text) => {
  try {
    return replaceCircledNumbers(String(text || "")).normalize("NFKC");
  } catch {
    return String(text || "");
  }
};

// ---- 展開処理 ----
const expandPage = async () => {
  const expandables = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
  expandables.forEach((el) => el.click());
  const detailElements = Array.from(document.querySelectorAll("details"));
  detailElements.forEach((detail) => {
    detail.open = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
};

// ---- テキスト正規化 ----
const normalizeExtractedText = (text) => {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let last = null;
  let blankStreak = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) {
      blankStreak += 1;
      if (blankStreak <= 1) out.push("");
      continue;
    }
    blankStreak = 0;
    if (line === last) continue;
    out.push(line);
    last = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

// ---- h1 からジョブタイトル ----
const pickJobTitle = () => {
  const h1 = document.querySelector("h1");
  const h1Text = h1 && h1.textContent ? h1.textContent.replace(/\s+/g, " ").trim() : "";
  if (h1Text && h1Text.length >= 2 && h1Text.length <= 80) return h1Text;
  return document.title ? document.title.replace(/\s+/g, " ").trim() : "";
};

// ---- ページ HTML 取得 ----
const captureRawHtml = () => {
  try {
    return document.documentElement.outerHTML;
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// ノイズ除外
// ---------------------------------------------------------------------------
const NOISE_SELECTOR = [
  "nav", "header", "footer", "aside",
  "button", "form", "input", "textarea", "select",
  "script", "style", "noscript", "svg", "canvas", "iframe", "dialog",
  '[role="navigation"]', '[role="dialog"]', '[role="alert"]',
  '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '[aria-hidden="true"]',
  ".modal", ".toast", ".notification", ".cookie-banner", ".consent-banner"
].join(",");

/** UI誘導文の検出 */
const UI_NOISE_RE = /^(応募する|この求人に応募|履歴書を|職務経歴書を|ログイン|新規登録|利用規約|プライバシーポリシー|Cookie)/i;
const isUINoiseText = (text) => {
  const t = (text || "").trim();
  return t.length > 0 && t.length < 200 && UI_NOISE_RE.test(t);
};

// ---------------------------------------------------------------------------
// セクション抽出（dt/dd, th/td, heading → 複数方式で試行）
// ---------------------------------------------------------------------------

/** dt/dd ペアから抽出 */
const extractDlSections = (root) => {
  const sections = [];
  const dls = root.querySelectorAll("dl");
  for (const dl of dls) {
    const dts = dl.querySelectorAll("dt");
    for (const dt of dts) {
      const label = normalizeNFKC(dt.innerText || "").replace(/\s+/g, " ").trim();
      if (!label || label.length > 60) continue;
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName !== "DD" && dd.tagName !== "DT") {
        dd = dd.nextElementSibling;
      }
      if (dd && dd.tagName === "DD") {
        const value = normalizeNFKC(dd.innerText || "").trim();
        if (value && !isUINoiseText(value)) {
          sections.push({ label, value, domTag: "dt/dd", snippet: value.slice(0, 120) });
        }
      }
    }
  }
  return sections;
};

/** table th/td ペアから抽出 */
const extractTableSections = (root) => {
  const sections = [];
  const tables = root.querySelectorAll("table");
  for (const table of tables) {
    const rows = table.querySelectorAll("tr");
    for (const row of rows) {
      const th = row.querySelector("th");
      const td = row.querySelector("td");
      if (th && td) {
        const label = normalizeNFKC(th.innerText || "").replace(/\s+/g, " ").trim();
        const value = normalizeNFKC(td.innerText || "").trim();
        if (label && label.length <= 60 && value && !isUINoiseText(value)) {
          sections.push({ label, value, domTag: "th/td", snippet: value.slice(0, 120) });
        }
      }
    }
  }
  return sections;
};

/** heading + 後続コンテンツから抽出 */
const extractHeadingSections = (root) => {
  const sections = [];
  const headings = root.querySelectorAll("h2, h3, h4, h5");
  for (const h of headings) {
    const label = normalizeNFKC(h.innerText || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 60) continue;
    const parts = [];
    let next = h.nextElementSibling;
    while (next && !/^H[1-6]$/.test(next.tagName)) {
      const text = normalizeNFKC(next.innerText || "").trim();
      if (text) parts.push(text);
      next = next.nextElementSibling;
    }
    const value = parts.join("\n").trim();
    if (value && !isUINoiseText(value)) {
      sections.push({ label, value, domTag: `heading(${h.tagName.toLowerCase()})`, snippet: value.slice(0, 120) });
    }
  }
  return sections;
};

/** コンテナからセクション群を抽出（最も結果が多い方式を採用） */
const extractSectionsFromContainer = (container) => {
  const clone = container.cloneNode(true);
  const noiseEls = clone.querySelectorAll(NOISE_SELECTOR);
  const noiseCount = noiseEls.length;
  noiseEls.forEach((n) => n.remove());

  const dl = extractDlSections(clone);
  const table = extractTableSections(clone);
  const headings = extractHeadingSections(clone);

  let best = dl, method = "dt/dd";
  if (table.length > best.length) { best = table; method = "th/td"; }
  if (headings.length > best.length) { best = headings; method = "headings"; }

  return { sections: best, method, noiseRemoved: noiseCount, cleanText: normalizeNFKC(clone.innerText || "").trim() };
};

// ---------------------------------------------------------------------------
// 汎用テキスト抽出（既存ロジック + 要素返却）
// ---------------------------------------------------------------------------
const extractBestText = () => {
  const candidates = [
    { label: "main", el: document.querySelector("main") },
    { label: "[role=main]", el: document.querySelector('[role="main"]') },
    { label: "article", el: document.querySelector("article") }
  ].filter((c) => c.el);

  const sections = Array.from(document.querySelectorAll("section")).slice(0, 8);
  sections.forEach((el, i) => candidates.push({ label: `section#${i + 1}`, el }));

  if (candidates.length === 0) candidates.push({ label: "body", el: document.body });

  const noiseSelector =
    "nav,header,footer,aside,button,form,script,style,noscript,svg,canvas,iframe,[role='navigation'],[aria-hidden='true']";

  let best = { label: "body", text: document.body ? document.body.innerText : "", el: document.body };
  for (const c of candidates) {
    const root = c.el;
    if (!root) continue;
    const noise = Array.from(root.querySelectorAll(noiseSelector));
    const restored = [];
    for (const n of noise) {
      if (!n || !n.style) continue;
      restored.push([n, n.style.display]);
      n.style.display = "none";
    }
    const text = root.innerText || "";
    for (const [n, prev] of restored) {
      n.style.display = prev;
    }
    if (text.length > (best.text || "").length) {
      best = { label: c.label, text, el: root };
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// HRMOS 専用 Extractor
// ---------------------------------------------------------------------------

const findHrmosJobContainer = () => {
  const selectors = [
    '[class*="job-detail"]',
    '[class*="jobDetail"]',
    '[class*="job_detail"]',
    '[class*="posting-detail"]',
    '[class*="postingDetail"]',
    '[class*="JobBody"]',
    '[class*="job-body"]',
    'main [class*="content"]',
    "main article",
    "main"
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && (el.innerText || "").length > 200) {
        return { el, selector: sel };
      }
    } catch {
      continue;
    }
  }

  const fallbacks = Array.from(document.querySelectorAll("main, article, section, [role='main']"));
  let best = null;
  for (const c of fallbacks) {
    const len = (c.innerText || "").length;
    if (!best || len > (best.el.innerText || "").length) {
      best = { el: c, selector: c.tagName.toLowerCase() };
    }
  }
  return best || { el: document.body, selector: "body" };
};

const hrmosExtractor = () => {
  const { el: container, selector } = findHrmosJobContainer();
  const { sections, method, noiseRemoved, cleanText } = extractSectionsFromContainer(container);

  return {
    rawText: normalizeExtractedText(cleanText),
    extractedSections: sections,
    extractionTrace: {
      strategy: "hrmos",
      containerSelector: selector,
      method,
      sectionCount: sections.length,
      noiseRemoved,
      textLength: cleanText.length
    }
  };
};

// ---------------------------------------------------------------------------
// 汎用 Extractor
// ---------------------------------------------------------------------------

const genericExtractor = () => {
  const picked = extractBestText();
  const rawText = normalizeExtractedText(picked.text);
  const { sections, method, noiseRemoved } = extractSectionsFromContainer(picked.el || document.body);

  return {
    rawText: normalizeNFKC(rawText),
    extractedSections: sections,
    extractionTrace: {
      strategy: "generic",
      containerSelector: picked.label,
      method,
      sectionCount: sections.length,
      noiseRemoved,
      textLength: rawText.length
    }
  };
};

// ---------------------------------------------------------------------------
// siteHint 判定
// ---------------------------------------------------------------------------
const detectSiteHint = () => {
  const host = location.hostname.toLowerCase();
  if (host.includes("hrmos")) return "HRMOS";
  return "unknown";
};

// ---------------------------------------------------------------------------
// メッセージハンドラ
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_PAGE") {
    expandPage()
      .then(() => {
        const siteHint = detectSiteHint();

        let result;
        try {
          result = siteHint === "HRMOS" ? hrmosExtractor() : genericExtractor();
        } catch {
          const picked = extractBestText();
          result = {
            rawText: normalizeExtractedText(normalizeNFKC(picked.text)),
            extractedSections: [],
            extractionTrace: { strategy: "fallback", containerSelector: picked.label, method: "none", sectionCount: 0, noiseRemoved: 0, textLength: (picked.text || "").length }
          };
        }

        const rawHtml = captureRawHtml();

        sendResponse({
          url: location.href,
          title: document.title,
          jobTitle: pickJobTitle(),
          rawText: result.rawText,
          rawHtml,
          extractedSections: result.extractedSections,
          extractionTrace: result.extractionTrace,
          siteHint,
          extractMeta: {
            source: result.extractionTrace.containerSelector,
            strategy: result.extractionTrace.strategy,
            sectionCount: result.extractedSections.length,
            length: result.rawText.length
          }
        });
      })
      .catch(() => {
        sendResponse({
          url: location.href,
          title: document.title,
          jobTitle: pickJobTitle(),
          rawText: normalizeExtractedText(normalizeNFKC(document.body ? document.body.innerText : "")),
          rawHtml: captureRawHtml(),
          extractedSections: [],
          extractionTrace: { strategy: "error-fallback", containerSelector: "body", method: "none", sectionCount: 0, noiseRemoved: 0, textLength: 0 },
          siteHint: detectSiteHint(),
          extractMeta: { source: "body(fallback)", length: (document.body ? document.body.innerText : "").length }
        });
      });
    return true;
  }
});
