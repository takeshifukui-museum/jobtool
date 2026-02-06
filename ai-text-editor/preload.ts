import { contextBridge, ipcRenderer } from "electron";

// markdown-it runs in preload (has Node.js access)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MarkdownIt = require("markdown-it");
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

contextBridge.exposeInMainWorld("electronAPI", {
  aiRequest: (text: string, action: string): Promise<string> =>
    ipcRenderer.invoke("ai-request", text, action),

  sendEditorContent: (content: string): void =>
    ipcRenderer.send("editor-content", content),

  onGetEditorContent: (callback: () => void): void => {
    ipcRenderer.on("get-editor-content", () => callback());
  },

  renderMarkdown: (source: string): string => {
    return md.render(source);
  },
});
