const expandPage = async () => {
  const expandables = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
  expandables.forEach((el) => el.click());
  const detailElements = Array.from(document.querySelectorAll("details"));
  detailElements.forEach((detail) => {
    detail.open = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
};

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
    if (line === last) continue; // 連続重複行の除去（内容削除ではなく重複整理）
    out.push(line);
    last = line;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const pickJobTitle = () => {
  const h1 = document.querySelector("h1");
  const h1Text = h1 && h1.textContent ? h1.textContent.replace(/\s+/g, " ").trim() : "";
  if (h1Text && h1Text.length >= 2 && h1Text.length <= 80) return h1Text;
  return document.title ? document.title.replace(/\s+/g, " ").trim() : "";
};

const extractBestText = () => {
  const candidates = [
    { label: "main", el: document.querySelector("main") },
    { label: "[role=main]", el: document.querySelector('[role="main"]') },
    { label: "article", el: document.querySelector("article") }
  ].filter((c) => c.el);

  // section は多いので、長そうなものをいくつか拾う
  const sections = Array.from(document.querySelectorAll("section")).slice(0, 8);
  sections.forEach((el, i) => candidates.push({ label: `section#${i + 1}`, el }));

  // 最終フォールバック
  if (candidates.length === 0) candidates.push({ label: "body", el: document.body });

  const noiseSelector =
    "nav,header,footer,aside,button,form,script,style,noscript,svg,canvas,iframe,[role='navigation'],[aria-hidden='true']";

  let best = { label: "body", text: document.body ? document.body.innerText : "" };
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
      best = { label: c.label, text };
    }
  }
  return best;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_PAGE") {
    expandPage()
      .then(() => {
        const picked = extractBestText();
        const rawText = normalizeExtractedText(picked.text);
        sendResponse({
          url: location.href,
          title: document.title,
          jobTitle: pickJobTitle(),
          rawText,
          siteHint: location.hostname.includes("hrmos") ? "HRMOS" : "unknown",
          extractMeta: { source: picked.label, length: rawText.length }
        });
      })
      .catch(() => {
        sendResponse({
          url: location.href,
          title: document.title,
          jobTitle: pickJobTitle(),
          rawText: normalizeExtractedText(document.body ? document.body.innerText : ""),
          siteHint: location.hostname.includes("hrmos") ? "HRMOS" : "unknown",
          extractMeta: { source: "body(fallback)", length: (document.body ? document.body.innerText : "").length }
        });
      });
    return true;
  }
});
