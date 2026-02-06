import { runAI, renderMarkdown } from "./ai";

// --- DOM elements ---
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const overlay = document.getElementById("editor-overlay") as HTMLPreElement;
const lineNumbers = document.getElementById("line-numbers") as HTMLDivElement;

const aiOutput = document.getElementById("ai-output") as HTMLTextAreaElement;
const mdPreview = document.getElementById("md-preview") as HTMLDivElement;
const charCount = document.getElementById("char-count") as HTMLSpanElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const fontSizeDisplay = document.getElementById("font-size-display") as HTMLSpanElement;

const splitter = document.getElementById("splitter") as HTMLDivElement;
const leftPane = document.getElementById("left-pane") as HTMLDivElement;
const rightPane = document.getElementById("right-pane") as HTMLDivElement;

const btnAiRun = document.getElementById("btn-ai-run") as HTMLButtonElement;
const btnAppend = document.getElementById("btn-append") as HTMLButtonElement;
const btnReplace = document.getElementById("btn-replace") as HTMLButtonElement;
const btnUnmark = document.getElementById("btn-unmark") as HTMLButtonElement;
const aiAction = document.getElementById("ai-action") as HTMLSelectElement;

const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
const tabContents = document.querySelectorAll<HTMLDivElement>(".tab-content");

// --- Constants ---
const MIN_PANE_WIDTH = 240;
const LS_KEY_SPLIT = "ai-editor-split-ratio";
const LS_KEY_FONT = "ai-editor-font-size";
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;

// autosave
const AUTOSAVE_IDLE_MS = 3 * 60 * 1000;
let autosaveTimer: number | null = null;

// --- Types ---
type Range = { start: number; end: number };
type Note = { line: number; snippet: string };

// 保存するメタ情報
type Meta = {
  version: "0.3";
  notes: Note[];
  aiRanges: Range[];
};

// --- State ---
let fontSize = loadFontSize();
let splitRatio = loadSplitRatio();
let isDragging = false;

let lastText = ""; // 差分追跡用
let aiRanges: Range[] = []; // 複数AI範囲
let notes: Note[] = []; // 付箋（行＋断片）

// --- Helpers ---
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getLines(text: string): string[] {
  return text.split("\n");
}

function lineCount(text: string): number {
  return Math.max(1, getLines(text).length);
}

function getLineText(lineNo: number): string {
  const lines = getLines(editor.value);
  const idx = clamp(lineNo - 1, 0, lines.length - 1);
  return lines[idx] ?? "";
}

function makeSnippet(lineText: string): string {
  const t = lineText.trim();
  return t.length <= 40 ? t : t.slice(0, 40);
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .map(r => ({ start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (!last || r.start > last.end) out.push({ ...r });
    else last.end = Math.max(last.end, r.end);
  }
  return out;
}

// 差分（common prefix / suffix）で編集位置を推定
function computeDiff(oldText: string, newText: string): { start: number; oldEnd: number; newEnd: number; delta: number } {
  const oldLen = oldText.length;
  const newLen = newText.length;

  let start = 0;
  while (start < oldLen && start < newLen && oldText[start] === newText[start]) start++;

  let oldEnd = oldLen;
  let newEnd = newLen;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const delta = newLen - oldLen;
  return { start, oldEnd, newEnd, delta };
}

// 編集に合わせてAI範囲を追従（v0.3の現実解）
function applyDiffToRanges(oldText: string, newText: string): void {
  const { start, oldEnd, delta } = computeDiff(oldText, newText);
  if (delta === 0 && oldText === newText) return;

  const updated: Range[] = aiRanges.map(r => ({ ...r }));

  for (const r of updated) {
    if (r.end <= start) {
      // before change: no-op
      continue;
    } else if (r.start >= oldEnd) {
      // after change: shift
      r.start += delta;
      r.end += delta;
    } else {
      // overlap: keep AI origin and expand to include change
      r.end += delta;
      r.start = Math.min(r.start, start);
      r.end = Math.max(r.end, start); // safety
    }
  }

  aiRanges = mergeRanges(updated).map(r => ({
    start: clamp(r.start, 0, newText.length),
    end: clamp(r.end, 0, newText.length),
  }));
}

// 付箋を表示用に「現在の行」に解決する
function resolveNotesToLines(): Map<number, number> {
  // key: noteIndex, value: resolvedLine
  const map = new Map<number, number>();
  const lines = getLines(editor.value);

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let resolved = n.line;

    if (n.snippet) {
      const found = lines.findIndex((ln) => ln.trim().startsWith(n.snippet));
      if (found >= 0) resolved = found + 1;
    }

    map.set(i, clamp(resolved, 1, lines.length));
  }
  return map;
}

// --- Font size ---
function loadFontSize(): number {
  const saved = localStorage.getItem(LS_KEY_FONT);
  if (saved) {
    const n = parseInt(saved, 10);
    if (!isNaN(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
  }
  return DEFAULT_FONT_SIZE;
}

function saveFontSize(): void {
  localStorage.setItem(LS_KEY_FONT, String(fontSize));
}

function applyFontSize(): void {
  editor.style.fontSize = fontSize + "px";
  overlay.style.fontSize = fontSize + "px";
  lineNumbers.style.fontSize = fontSize + "px";
  aiOutput.style.fontSize = fontSize + "px";
  mdPreview.style.fontSize = fontSize + "px";
  fontSizeDisplay.textContent = `${fontSize}px`;
  renderAll();
}

applyFontSize();

// Ctrl+Wheel for font size
document.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0 && fontSize < MAX_FONT_SIZE) fontSize++;
      else if (e.deltaY > 0 && fontSize > MIN_FONT_SIZE) fontSize--;
      applyFontSize();
      saveFontSize();
    }
  },
  { passive: false }
);

// --- Splitter ---
function loadSplitRatio(): number {
  const saved = localStorage.getItem(LS_KEY_SPLIT);
  if (saved) {
    const n = parseFloat(saved);
    if (!isNaN(n) && n > 0 && n < 1) return n;
  }
  return 0.5;
}

function saveSplitRatio(): void {
  localStorage.setItem(LS_KEY_SPLIT, String(splitRatio));
}

function applySplitLayout(): void {
  const appEl = document.getElementById("app")!;
  const totalWidth = appEl.clientWidth;
  const splitterWidth = splitter.clientWidth;
  const available = totalWidth - splitterWidth;

  let leftWidth = Math.round(available * splitRatio);
  let rightWidth = available - leftWidth;

  if (leftWidth < MIN_PANE_WIDTH) {
    leftWidth = MIN_PANE_WIDTH;
    rightWidth = available - leftWidth;
  }
  if (rightWidth < MIN_PANE_WIDTH) {
    rightWidth = MIN_PANE_WIDTH;
    leftWidth = available - rightWidth;
  }

  leftPane.style.width = leftWidth + "px";
  leftPane.style.flexGrow = "0";
  leftPane.style.flexShrink = "0";
  rightPane.style.width = rightWidth + "px";
  rightPane.style.flexGrow = "0";
  rightPane.style.flexShrink = "0";
}

applySplitLayout();

splitter.addEventListener("mousedown", (e: MouseEvent) => {
  e.preventDefault();
  isDragging = true;
  document.body.classList.add("resizing");
  splitter.classList.add("dragging");
});

document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!isDragging) return;
  const appEl = document.getElementById("app")!;
  const rect = appEl.getBoundingClientRect();
  const splitterWidth = splitter.clientWidth;
  const available = rect.width - splitterWidth;

  let leftWidth = e.clientX - rect.left;
  if (leftWidth < MIN_PANE_WIDTH) leftWidth = MIN_PANE_WIDTH;
  if (leftWidth > available - MIN_PANE_WIDTH) leftWidth = available - MIN_PANE_WIDTH;

  splitRatio = leftWidth / available;
  applySplitLayout();
});

document.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;
  document.body.classList.remove("resizing");
  splitter.classList.remove("dragging");
  saveSplitRatio();
});

window.addEventListener("resize", () => applySplitLayout());

// --- Tabs ---
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab!;
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabContents.forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + target)!.classList.add("active");

    if (target === "preview") updatePreview();
  });
});

// --- Render ---
function updateCharCount(): void {
  charCount.textContent = `${editor.value.length} 文字`;
}

function renderLineNumbers(): void {
  const lines = lineCount(editor.value);
  const resolved = resolveNotesToLines();
  const pinnedLines = new Set<number>();
  for (const [, ln] of resolved) pinnedLines.add(ln);

  let html = "";
  for (let i = 1; i <= lines; i++) {
    const pin = pinnedLines.has(i) ? "📌" : "";
    html += `<div class="ln" data-line="${i}"><span class="pin">${pin}</span><span class="n">${i}</span></div>`;
  }
  lineNumbers.innerHTML = html;
}

function renderOverlay(): void {
  const text = editor.value;
  const ranges = mergeRanges(aiRanges).map(r => ({
    start: clamp(r.start, 0, text.length),
    end: clamp(r.end, 0, text.length),
  }));

  if (ranges.length === 0) {
    overlay.textContent = text;
    return;
  }

  let out = "";
  let cursor = 0;

  for (const r of ranges) {
    if (r.start > cursor) out += escapeHtml(text.slice(cursor, r.start));
    out += `<span class="ai">${escapeHtml(text.slice(r.start, r.end))}</span>`;
    cursor = r.end;
  }
  if (cursor < text.length) out += escapeHtml(text.slice(cursor));

  overlay.innerHTML = out;
}

function syncScroll(): void {
  overlay.scrollTop = editor.scrollTop;
  lineNumbers.scrollTop = editor.scrollTop;
}

function renderAll(): void {
  updateCharCount();
  renderLineNumbers();
  renderOverlay();
  syncScroll();
}

// --- Markdown Preview ---
function updatePreview(): void {
  mdPreview.innerHTML = renderMarkdown(editor.value);
}

// --- Autosave ---
function scheduleAutosave(): void {
  if (autosaveTimer) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    void doAutosave();
  }, AUTOSAVE_IDLE_MS);
}

function buildMeta(): Meta {
  return {
    version: "0.3",
    notes,
    aiRanges,
  };
}

async function doAutosave(): Promise<void> {
  const payload = {
    text: editor.value,
    metaJson: JSON.stringify(buildMeta(), null, 2),
  };

  statusText.textContent = "自動保存中...";
  const res = await window.electronAPI.autosave(payload);
  if (res.ok) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    statusText.textContent = `自動保存: ${hh}:${mm}`;
  } else {
    statusText.textContent = `自動保存エラー: ${res.message || "unknown"}`;
  }
}

// --- Events ---
editor.addEventListener("scroll", () => syncScroll());

editor.addEventListener("input", () => {
  // AI範囲を編集に追従（改行で色が消える問題を潰す）
  const newText = editor.value;
  applyDiffToRanges(lastText, newText);
  lastText = newText;

  renderAll();
  scheduleAutosave();
});

// 初回
lastText = editor.value;

// 行番号クリックで付箋ON/OFF
lineNumbers.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const lnEl = target.closest(".ln") as HTMLDivElement | null;
  if (!lnEl) return;

  const clickedLine = parseInt(lnEl.dataset.line || "0", 10);
  if (!clickedLine) return;

  const resolved = resolveNotesToLines();
  // 既にその行に付箋があるなら消す（最初の1件）
  let removed = false;
  for (let i = 0; i < notes.length; i++) {
    const rLine = resolved.get(i);
    if (rLine === clickedLine) {
      notes.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (removed) {
    statusText.textContent = `付箋を外しました（行 ${clickedLine}）`;
  } else {
    const txt = getLineText(clickedLine);
    notes.push({ line: clickedLine, snippet: makeSnippet(txt) });
    statusText.textContent = `付箋を付けました（行 ${clickedLine}）`;
  }

  renderLineNumbers();
  scheduleAutosave();
});

// --- AI Execution ---
let isRunning = false;

async function executeAI(): Promise<void> {
  if (isRunning) return;

  const action = aiAction.value;
  let text: string;

  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  if (selStart !== selEnd) text = editor.value.substring(selStart, selEnd);
  else text = editor.value;

  if (!text.trim()) {
    statusText.textContent = "テキストが空です";
    return;
  }

  isRunning = true;
  btnAiRun.disabled = true;
  statusText.textContent = "AI処理中...";

  try {
    const result = await runAI(text, action);

    if (aiOutput.value.trim()) aiOutput.value += "\n\n---\n\n" + result;
    else aiOutput.value = result;

    aiOutput.scrollTop = aiOutput.scrollHeight;
    statusText.textContent = "AI処理完了";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    aiOutput.value += "\n\n[エラー] " + msg;
    statusText.textContent = "エラー発生";
  } finally {
    isRunning = false;
    btnAiRun.disabled = false;
  }
}

btnAiRun.addEventListener("click", () => void executeAI());

// Ctrl+Enter shortcut
editor.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    void executeAI();
  }
});

// --- Append / Replace buttons ---
// 追記：挿入した範囲をAI範囲として追加（長文でも残る）
btnAppend.addEventListener("click", () => {
  const aiText = aiOutput.value;
  if (!aiText.trim()) {
    statusText.textContent = "AI出力が空です";
    return;
  }

  const beforeLen = editor.value.length;
  const glue = editor.value.trim() ? "\n\n" : "";
  const inserted = glue + aiText;

  editor.value = editor.value + inserted;

  // 挿入範囲をAIとして記録（複数保持）
  aiRanges.push({ start: beforeLen + glue.length, end: beforeLen + inserted.length });
  aiRanges = mergeRanges(aiRanges);

  lastText = editor.value;
  renderAll();
  statusText.textContent = "左ペインに追記しました（AI部分を水色表示）";
  scheduleAutosave();
});

// 置換：全文をAIとして扱う（前のAI範囲は破棄）
btnReplace.addEventListener("click", () => {
  const aiText = aiOutput.value;
  if (!aiText.trim()) {
    statusText.textContent = "AI出力が空です";
    return;
  }

  const ok = confirm("左ペインの内容をAI出力で置換します。よろしいですか？");
  if (!ok) return;

  editor.value = aiText;
  aiRanges = [{ start: 0, end: aiText.length }];

  lastText = editor.value;
  renderAll();
  statusText.textContent = "左ペインを置換しました（AI部分を水色表示）";
  scheduleAutosave();
});

// 選択範囲のAIマーク解除（便利ボタン）
btnUnmark.addEventListener("click", () => {
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  if (s === e) {
    statusText.textContent = "解除したい範囲を選択してください";
    return;
  }

  const next: Range[] = [];
  for (const r of aiRanges) {
    // no overlap
    if (e <= r.start || s >= r.end) {
      next.push(r);
      continue;
    }
    // overlap: split
    if (s > r.start) next.push({ start: r.start, end: s });
    if (e < r.end) next.push({ start: e, end: r.end });
  }
  aiRanges = mergeRanges(next);

  renderAll();
  statusText.textContent = "選択範囲のAIマークを解除しました";
  scheduleAutosave();
});

// --- Save (main menu) support ---
window.electronAPI.onRequestSavePayload((kind: "saveAs" | "save" | "autosave", _filePath: string | null) => {
  const meta = JSON.stringify(buildMeta(), null, 2);
  window.electronAPI.sendSavePayload(kind, _filePath, { text: editor.value, metaJson: meta });
  statusText.textContent = kind === "saveAs" ? "保存しました（名前を付けて保存）" : "保存しました";
});

// --- Initial ---
renderAll();
statusText.textContent = "Ready";
scheduleAutosave();
