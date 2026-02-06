import { contextBridge, ipcRenderer } from "electron";

// markdown-it runs in preload
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MarkdownIt = require("markdown-it");
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

type SavePayload = { text: string; metaJson: string };
type SaveKind = "saveAs" | "save" | "autosave";

contextBridge.exposeInMainWorld("electronAPI", {
  aiRequest: (text: string, action: string): Promise<string> =>
    ipcRenderer.invoke("ai-request", text, action),

  renderMarkdown: (source: string): string => md.render(source),

  // main -> renderer: 「保存したいのでpayload返して」
  onRequestSavePayload: (callback: (kind: SaveKind, filePath: string | null) => void): void => {
    ipcRenderer.on("request-save-payload", (_e, kind: SaveKind, filePath: string | null) => {
      callback(kind, filePath);
    });
  },

  // renderer -> main: payload送信
  sendSavePayload: (kind: SaveKind, filePath: string | null, payload: SavePayload): void => {
    ipcRenderer.send("send-save-payload", kind, filePath, payload);
  },

  // renderer -> main: autosave（直接payload送る方式）
  autosave: (payload: SavePayload): Promise<{ ok: boolean; filePath?: string; message?: string }> =>
    ipcRenderer.invoke("autosave", payload),
});
