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

const buildDownloadFilename = (folderName, suggestedFilename) => {
  const fallback = "求人票_求人情報.docx";
  const safeFile = sanitizePathPart(suggestedFilename || fallback) || fallback;
  const file = safeFile.toLowerCase().endsWith(".docx") ? safeFile : `${safeFile}.docx`;

  const rawFolder = String(folderName || "")
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/g, "")
    .replace(/^\/+/g, "");

  const parts = rawFolder
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map(sanitizePathPart)
    .filter(Boolean);

  if (parts.length === 0) return file;
  return `${parts.join("/")}/${file}`;
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
          extractMeta: payload.extractMeta
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
        const { folderName, suggestedFilename } = message;
        if (!runId) {
          sendResponse({ ok: false, message: "runId がありません" });
          return;
        }

        const data = await apiPost(API_RENDER, { runId, approve: true });

        const filename = buildDownloadFilename(folderName, data.suggestedFilename || suggestedFilename);
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
          sendResponse({ ok: true, message: "ダウンロードしました", scoutText: data.scoutText || "" });
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
