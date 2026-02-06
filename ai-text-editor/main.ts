import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";

let mainWindow: BrowserWindow | null = null;

function loadConfig(): Record<string, string> {
  const configPath = path.join(__dirname, "..", "config", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "AI Text Editor v0.2",
  });

  // __dirname = dist/, HTML is in renderer/ at project root
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Build menu with Save As
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => handleSaveAs(),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

async function handleSaveAs(): Promise<void> {
  if (!mainWindow) return;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save As",
    filters: [
      { name: "Text files", extensions: ["txt"] },
      { name: "Markdown files", extensions: ["md"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  if (!result.canceled && result.filePath) {
    mainWindow.webContents.send("get-editor-content");
    ipcMain.once("editor-content", (_event, content: string) => {
      fs.writeFileSync(result.filePath!, content, "utf-8");
    });
  }
}

// IPC: AI request
ipcMain.handle(
  "ai-request",
  async (_event, text: string, action: string): Promise<string> => {
    const config = loadConfig();
    const provider = config.provider || "openai";
    const model = config.model || "gpt-4o-mini";

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
  }
);

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string
): Promise<string> {
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

async function callClaude(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string
): Promise<string> {
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

// IPC: Save As trigger from menu
ipcMain.on("save-as", () => handleSaveAs());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
