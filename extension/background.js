// MV3 Service Worker: background.js
// NOTE: Top-level return/await 禁止。createObjectURL 禁止。

const API_BASE = "http://localhost:3000";
const API_EXTRACT = `${API_BASE}/api/extract`;
const API_STRUCTURE = `${API_BASE}/api/structure`;
const API_RENDER = `${API_BASE}/api/render`;
const API_GENERATE = `${API_BASE}/api/generate`; // 互換（使う場合のみ）

console.log("[background] service worker loaded");

const sanitizePathPart = (s) => {
  return String(s || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "");
};

const buildDownloadFilename = (suggestedFilename) => {
  const fallback = "求人票_求人情報.docx";
  const safeFile = sanitizePathPart(suggestedFilename || fallback) || fallback;
  const file = safeFile.toLowerCase().endsWith(".docx") ? safeFile : `${safeFile}.docx`;
  return file;
};

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

const base64ToDataUrl = (base64, mime) => {
  return `data:${mime};base64,${base64}`;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
          siteHint: payload.siteHint,
          extractMeta: payload.extractMeta,
          extractedSections: payload.extractedSections,
          extractionTrace: payload.extractionTrace
        });

        const structureResult = await apiPost(API_STRUCTURE, { runId: extractResult.runId });

        sendResponse({
          ok: true,
          runId: structureResult.runId,
          sessionId: structureResult.runId, // 旧互換
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

  if (message?.type === "RENDER_JOB_DOCX") {
    (async () => {
      try {
        const runId = message.runId || message.sessionId;
        const { suggestedFilename } = message;
        if (!runId) {
          sendResponse({ ok: false, message: "runId がありません" });
          return;
        }

        const data = await apiPost(API_RENDER, { runId, approve: true });

        // サーバーがユーザー指定フォルダへコピー済みの場合
        const copiedFiles = data.copiedFiles ?? [];
        const hasWordCopy = copiedFiles.some((f) => f.endsWith(".docx"));

        if (hasWordCopy) {
          // Word はサーバー側で保存済み → chrome.downloads 不要
          // スカウト文もサーバー側で保存済み
          console.log("[background] files copied by server:", copiedFiles);
          sendResponse({ ok: true, message: "保存しました", copiedFiles });
          return;
        }

        // フォルダ未指定（後方互換）: chrome.downloads で保存
        const filename = buildDownloadFilename(data.suggestedFilename || suggestedFilename);
        const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        // objectURL を使わず data: URL で downloads に渡す
        const dataUrl = base64ToDataUrl(data.docx, mime);

        chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, (downloadId) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message || "unknown download error";
            console.error("[background] download failed:", err);
            sendResponse({ ok: false, message: `download failed: ${err}` });
            return;
          }
          console.log("[background] download started, id:", downloadId);

          // スカウト文を .txt として同じフォルダに保存（UI非表示、ファイル出力のみ）
          if (data.scoutText) {
            try {
              const txtFilename = filename.replace(/\.docx$/i, "").replace(/^求人票_/, "スカウト文_") + ".txt";
              const txtBase64 = btoa(unescape(encodeURIComponent(data.scoutText)));
              const txtDataUrl = `data:text/plain;charset=utf-8;base64,${txtBase64}`;
              chrome.downloads.download({ url: txtDataUrl, filename: txtFilename, saveAs: false }, (txtId) => {
                if (chrome.runtime.lastError) {
                  console.warn("[background] scout text download failed:", chrome.runtime.lastError.message);
                } else {
                  console.log("[background] scout text saved, id:", txtId);
                }
              });
            } catch (e) {
              console.warn("[background] scout text save error:", e);
            }
          }

          sendResponse({ ok: true, message: "ダウンロードしました" });
        });
      } catch (error) {
        sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
      }
    })();
    return true;
  }

  // unknown message
  sendResponse({ ok: false, message: "unknown message type" });
  return false;
});
