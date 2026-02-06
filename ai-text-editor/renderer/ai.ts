declare global {
  interface Window {
    electronAPI: {
      aiRequest: (text: string, action: string) => Promise<string>;
      renderMarkdown: (source: string) => string;

      getConfig: () => Promise<{
        provider?: "openai" | "claude";
        model?: string;
        openaiApiKey?: string;
        claudeApiKey?: string;
      }>;
      saveConfig: (next: {
        provider?: "openai" | "claude";
        model?: string;
        openaiApiKey?: string;
        claudeApiKey?: string;
      }) => Promise<{ ok: boolean; message?: string }>;

      onFileOpened: (callback: (payload: any) => void) => void;
      onRequestSavePayload: (callback: () => void) => void;
      sendSavePayload: (payload: { text: string; notesJson: string }) => void;
    };
  }
}

export async function runAI(text: string, action: string): Promise<string> {
  return window.electronAPI.aiRequest(text, action);
}
export function renderMarkdown(source: string): string {
  return window.electronAPI.renderMarkdown(source);
}
