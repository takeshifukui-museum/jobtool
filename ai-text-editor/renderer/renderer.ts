import { runAI, renderMarkdown } from "./ai";

// --- DOM elements ---
const editor = document.getElementById("editor") as HTMLTextAreaElement;
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

// --- Font size ---
let fontSize = loadFontSize();
applyFontSize();

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
  document.documentElement.style.setProperty("font-size", fontSize + "px");
  editor.style.fontSize = fontSize + "px";
  aiOutput.style.fontSize = fontSize + "px";
  mdPreview.style.fontSize = fontSize + "px";
  fontSizeDisplay.textContent = `${fontSize}px`;
}

// Ctrl+Wheel for font size
document.addEventListener("wheel", (e: WheelEvent) => {
  if (e.ctrlKey) {
    e.preventDefault();
    if (e.deltaY < 0 && fontSize < MAX_FONT_SIZE) {
      fontSize++;
    } else if (e.deltaY > 0 && fontSize > MIN_FONT_SIZE) {
      fontSize--;
    }
    applyFontSize();
    saveFontSize();
  }
}, { passive: false });

// --- Splitter ---
let splitRatio = loadSplitRatio();
let isDragging = false;

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

  // Clamp to min widths
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

  // Clamp
  if (leftWidth < MIN_PANE_WIDTH) leftWidth = MIN_PANE_WIDTH;
  if (leftWidth > available - MIN_PANE_WIDTH) leftWidth = available - MIN_PANE_WIDTH;

  splitRatio = leftWidth / available;
  applySplitLayout();
});

document.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    document.body.classList.remove("resizing");
    splitter.classList.remove("dragging");
    saveSplitRatio();
  }
});

window.addEventListener("resize", () => {
  applySplitLayout();
});

// --- Tabs ---
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab!;
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabContents.forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + target)!.classList.add("active");

    // Refresh preview when switching to preview tab
    if (target === "preview") {
      updatePreview();
    }
  });
});

// --- Character count ---
function updateCharCount(): void {
  const len = editor.value.length;
  charCount.textContent = `${len} 文字`;
}

editor.addEventListener("input", () => {
  updateCharCount();
});

// --- Markdown Preview ---
function updatePreview(): void {
  mdPreview.innerHTML = renderMarkdown(editor.value);
}

// --- AI Execution ---
let isRunning = false;

async function executeAI(): Promise<void> {
  if (isRunning) return;

  const action = aiAction.value;
  let text: string;

  // Use selection if available, otherwise full text
  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  if (selStart !== selEnd) {
    text = editor.value.substring(selStart, selEnd);
  } else {
    text = editor.value;
  }

  if (!text.trim()) {
    statusText.textContent = "テキストが空です";
    return;
  }

  isRunning = true;
  btnAiRun.disabled = true;
  statusText.textContent = "AI処理中...";

  // Switch to AI tab
  tabButtons.forEach((b) => b.classList.remove("active"));
  tabContents.forEach((c) => c.classList.remove("active"));
  document.querySelector('[data-tab="ai"]')!.classList.add("active");
  document.getElementById("tab-ai")!.classList.add("active");

  try {
    const result = await runAI(text, action);

    // Append to AI output (with separator if already has content)
    if (aiOutput.value.trim()) {
      aiOutput.value += "\n\n---\n\n" + result;
    } else {
      aiOutput.value = result;
    }

    // Scroll to bottom
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

// AI run button
btnAiRun.addEventListener("click", () => executeAI());

// Ctrl+Enter shortcut
editor.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    executeAI();
  }
});

// Also allow Ctrl+Enter in AI output textarea (for re-running)
aiOutput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    executeAI();
  }
});

// --- Append / Replace buttons ---
btnAppend.addEventListener("click", () => {
  const aiText = aiOutput.value;
  if (!aiText.trim()) {
    statusText.textContent = "AI出力が空です";
    return;
  }
  editor.value = editor.value + "\n\n" + aiText;
  updateCharCount();
  statusText.textContent = "左ペインに追記しました";
});

btnReplace.addEventListener("click", () => {
  const aiText = aiOutput.value;
  if (!aiText.trim()) {
    statusText.textContent = "AI出力が空です";
    return;
  }
  const ok = confirm("左ペインの内容をAI出力で置換します。よろしいですか？");
  if (ok) {
    editor.value = aiText;
    updateCharCount();
    statusText.textContent = "左ペインを置換しました";
  }
});

// --- Save As support (IPC from main process) ---
window.electronAPI.onGetEditorContent(() => {
  window.electronAPI.sendEditorContent(editor.value);
});

// --- Initial state ---
updateCharCount();
statusText.textContent = "Ready";
