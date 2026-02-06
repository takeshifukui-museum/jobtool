// Type declarations for electronAPI exposed by preload

declare global {
  interface Window {
    electronAPI: {
      aiRequest: (text: string, action: string) => Promise<string>;
      sendEditorContent: (content: string) => void;
      onGetEditorContent: (callback: () => void) => void;
      renderMarkdown: (source: string) => string;
    };
  }
}

export async function runAI(text: string, action: string): Promise<string> {
  return window.electronAPI.aiRequest(text, action);
}

export function renderMarkdown(source: string): string {
  return window.electronAPI.renderMarkdown(source);
}
