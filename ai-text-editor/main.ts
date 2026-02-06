import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";

let mainWindow: BrowserWindow | null = null;

// 最後に保存したファイルパス（本文側）
let currentFilePath: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 450,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "AI Text Editor v0.3",
  });

  // __dirname = dist/, HTML is in renderer/ at project root
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: "ファイル",
      submenu: [
        {
          label: "名前を付けて保存...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => requestSavePayload("saveAs"),
        },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => requestSavePayload("save"),
        },
        { type: "separator" },
        { role: "quit", label: "終了" },
      ],
    },
    {
      label: "編集",
      submenu: [
        { role: "undo", label: "元に戻す" },
        { role: "redo", label: "やり直し" },
        { type: "separator" },
        { role: "cut", label: "切り取り" },
        { role: "copy", label: "コピー" },
        { role: "paste", label: "貼り付け" },
        { role: "selectAll", label: "すべて選択" },
      ],
    },
    {
      label: "表示",
      submenu: [
        { role: "reload", label: "再読み込み" },
        { role: "toggleDevTools", label: "開発者ツール" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

type SaveKind = "saveAs" | "save" | "autosave";
type SavePayload = { text: string; metaJson: string };

function metaPathFor(contentPath: string): string {
  const dir = path.dirname(contentPath);
  const base = path.basename(contentPath, path.extname(contentPath));
  return path.join(dir, `${base}.aieditor.json`);
}

async function requestSavePayload(kind: SaveKind): Promise<void> {
  if (!mainWindow) return;
  mainWindow.webContents.send("request-save-payload", kind, currentFilePath);
}

async function saveAsWithDialog(payload: SavePayload): Promise<{ ok: boolean; filePath?: string; message?: string }> {
  if (!mainWindow) return { ok: false, message: "window not ready" };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "名前を付けて保存",
    filters: [
      { name: "Text files", extensions: ["txt"] },
      { name: "Markdown files", extensions: ["md"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !result.filePath) return { ok: false, message: "canceled" };

  const filePath = result.filePath;
  const metaPath = metaPathFor(filePath);

  fs.writeFileSync(filePath, payload.text, "utf-8");
  fs.writeFileSync(metaPath, payload.metaJson, "utf-8");

  currentFilePath = filePath;
  return { ok: true, filePath };
}

function saveToCurrent(payload: SavePayload): { ok: boolean; filePath?: string; message?: string } {
  if (!currentFilePath) return { ok: false, message: "no current file path" };
  const metaPath = metaPathFor(currentFilePath);

  fs.writeFileSync(currentFilePath, payload.text, "utf-8");
  fs.writeFileSync(metaPath, payload.metaJson, "utf-8");
  return { ok: true, filePath: currentFilePath };
}

function ensureAutosaveDir(): string {
  const dir = path.join(app.getPath("documents"), "AI Text Editor", "autosave");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function autosavePath(): string {
  const dir = ensureAutosaveDir();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `autosave_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return path.join(dir, `${name}.txt`);
}

// IPC: renderer -> main 保存payload受信
ipcMain.on("send-save-payload", async (_event, kind: SaveKind, filePath: string | null, payload: SavePayload) => {
  try {
    if (kind === "saveAs") {
      await saveAsWithDialog(payload);
    } else if (kind === "save") {
      const r = saveToCurrent(payload);
      if (!r.ok) {
        await saveAsWithDialog(payload);
      }
    }
  } catch (e: unknown) {
    // ここでは握りつぶす（renderer側でステータス表示するため）
  }
});

// IPC: autosave
ipcMain.handle("autosave", async (_event, payload: SavePayload) => {
  try {
    // 既存ファイルがあるなら上書き、無いならautosaveへ
    if (currentFilePath) {
      const r = saveToCurrent(payload);
      return r.ok ? { ok: true, filePath: r.filePath } : { ok: false, message: r.message };
    }
    const p = autosavePath();
    const meta = metaPathFor(p);

    fs.writeFileSync(p, payload.text, "utf-8");
    fs.writeFileSync(meta, payload.metaJson, "utf-8");

    return { ok: true, filePath: p };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
});

// ===== AI request (OpenAI/Claude) =====

function loadConfig(): Record<string, string> {
  const configPath = path.join(__dirname, "..", "config", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

ipcMain.handle("ai-request", async (_event, text: string, action: string): Promise<string> => {
  const config = loadConfig();
  const provider = config.provider || "openai";
  const model = config.model || "gpt-5.2";

  const systemPrompts: Record<string, string> = {
    proofread:
      "あなたは優秀な日本語校正者です。以下の文章を校正してください。意味を変えず、文量を増やさないでください。修正した文章のみを返してください。",
    compress:
      "あなたは優秀な文章圧縮者です。以下の文章を元の70〜80%程度の長さに圧縮してください。重要な意味は維持してください。圧縮した文章のみを返してください。",
    tone:
      "あなたは優秀なビジネス文書ライターです。以下の文章をビジネスにふさわしい丁寧な文体に書き換えてください。書き換えた文章のみを返してください。",
  };

  const systemPrompt = systemPrompts[action] || systemPrompts.proofread;

  try {
    if (provider === "claude") {
      return await callClaude(config.claudeApiKey || "", model, systemPrompt, text);
    } else {
      return await callOpenAI(config.openaiApiKey || "", model, systemPrompt, text);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `[エラー] ${message}`;
  }
});

async function callOpenAI(apiKey: string, model: string, systemPrompt: string, userText: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "[応答なし]";
}

async function callClaude(apiKey: string, model: string, systemPrompt: string, userText: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const content = data.content;
  if (Array.isArray(content) && content.length > 0) {
    return content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  return "[応答なし]";
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => app.quit());

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
