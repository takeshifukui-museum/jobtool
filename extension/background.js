// MV3 Service Worker: background.js
// ファイル保存は server 側で完結。extension は API 呼び出しと結果表示のみ。

const API_BASE = "http://localhost:3000";
const API_EXTRACT = `${API_BASE}/api/extract`;
const API_STRUCTURE = `${API_BASE}/api/structure`;
const API_RENDER = `${API_BASE}/api/render`;

console.log("[background] service worker loaded");

const apiPost = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!response.ok) {
    const detail = data?.error?.message || data?.error?.detail || data?.error?.code || text || "APIエラー";
    throw new Error(detail);
  }
  return data;
};

const extractFromTab = async (tabId) => {
  const sendExtractMessage = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(response);
      });
    });

  try {
    return await sendExtractMessage();
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.indexOf("Receiving end does not exist") === -1 && msg.indexOf("Could not establish connection") === -1) {
      throw err;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      throw new Error("このページでは実行できません。求人ページを開き、再読み込み（F5）してからもう一度お試しください。");
    }
    return await sendExtractMessage();
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Step 1: extract → structure → プレビュー
  if (message?.type === "GENERATE_JOB_PREVIEW") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      try {
        const tab = tabs[0];
        if (!tab || !tab.id) {
          sendResponse({ ok: false, message: "アクティブタブが見つかりません" });
          return;
        }

        const payload = await extractFromTab(tab.id);

        const extractResult = await apiPost(API_EXTRACT, {
          rawText: payload.rawText,
          rawHtml: payload.rawHtml,
          url: payload.url,
          title: payload.title,
          jobTitle: payload.jobTitle,
          siteHint: payload.siteHint,
          extractMeta: payload.extractMeta,
          extractedSections: payload.extractedSections,
          extractionTrace: payload.extractionTrace
        });

        const structureResult = await apiPost(API_STRUCTURE, { runId: extractResult.runId });

        sendResponse({
          ok: true,
          runId: structureResult.runId,
          sessionId: structureResult.runId,
          job: structureResult.job,
          structuredMd: structureResult.structuredMd,
          suggestedFilename: structureResult.suggestedFilename,
          meta: structureResult.meta
        });
      } catch (error) {
        sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
      }
    });
    return true;
  }

  // Step 2: render → サーバー側で保存完了
  if (message?.type === "RENDER_JOB_DOCX") {
    (async () => {
      try {
        const runId = message.runId || message.sessionId;
        if (!runId) {
          sendResponse({ ok: false, message: "runId がありません" });
          return;
        }

        const data = await apiPost(API_RENDER, { runId, approve: true });

        const savedFiles = data.savedFiles ?? [];
        const saveErrors = data.saveErrors ?? [];

        console.log("[background] server saved files:", savedFiles);
        if (saveErrors.length > 0) {
          console.warn("[background] save errors:", saveErrors);
        }

        sendResponse({
          ok: true,
          message: savedFiles.length > 0 ? "保存しました" : "保存先未設定",
          savedFiles,
          saveErrors,
        });
      } catch (error) {
        sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, message: "unknown message type" });
  return false;
});
