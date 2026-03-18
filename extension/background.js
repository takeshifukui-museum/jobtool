const API_URL = "http://localhost:3000/api/generate";
// #region agent log (debug mode)
const DEBUG_ENDPOINT = "http://127.0.0.1:7243/ingest/17ed477e-d29e-46f0-9713-bddaa4a1a07d";
const dbg = (payload) => {
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, timestamp: Date.now() })
  }).catch(() => {});
};
// #endregion

const base64ToDataUrl = (base64, contentType) => {
  return `data:${contentType};base64,${base64}`;
};

const sanitizePathPart = (s) => {
  return String(s || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "");
};

// Chrome downloads API の filename は「相対パス」のみ（絶対パス不可、.. 不可）
const buildDownloadFilename = (folderName, suggestedFilename) => {
  const fallback = "求人票_求人情報.docx";
  const safeFile = sanitizePathPart(suggestedFilename || fallback) || fallback;
  const file = safeFile.toLowerCase().endsWith(".docx") ? safeFile : `${safeFile}.docx`;

  const rawFolder = String(folderName || "")
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/g, "") // drive letter を削除
    .replace(/^\/+/g, ""); // 先頭スラッシュ削除

  const parts = rawFolder
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map(sanitizePathPart)
    .filter(Boolean);

  if (parts.length === 0) return file;
  return `${parts.join("/")}/${file}`;
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
    } catch (injectErr) {
      throw new Error("このページでは実行できません。求人ページを開き、再読み込み（F5）してからもう一度お試しください。");
    }
    return await sendExtractMessage();
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GENERATE_JOB_DOCX") {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    try {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        sendResponse({ ok: false, message: "アクティブタブが見つかりません" });
        return;
      }
      const payload = await extractFromTab(tab.id);

      // #region agent log (debug mode)
      dbg({
        location: "extension/background.js:before_fetch",
        message: "posting to server /api/generate",
        data: {
          urlHost: (() => {
            try {
              return new URL(payload?.url || "").host;
            } catch {
              return null;
            }
          })(),
          rawTextLen: (payload?.rawText || "").length,
          hasFolderName: Boolean(message.folderName)
        },
        runId: "pre-fix",
        hypothesisId: "H5"
      });
      // #endregion

      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          outputs: ["job_docx", "scout_text"]
        })
      });
      if (!response.ok) {
        const responseText = await response.text();
        let detailMessage = responseText;
        try {
          const errorData = JSON.parse(responseText);
          detailMessage =
            errorData?.error?.detail || errorData?.error?.message || errorData?.error?.code || responseText;
        } catch (parseError) {
          detailMessage = responseText || "APIエラー";
        }
        sendResponse({ ok: false, message: detailMessage });
        return;
      }
      const data = await response.json();
      const filename = buildDownloadFilename(message.folderName, data.suggestedFilename);
      const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const url = base64ToDataUrl(data.docx, contentType);
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true
      });
      sendResponse({ ok: true, message: "ダウンロードしました", scoutText: data.scoutText || "" });
    } catch (error) {
      sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
    }
  });

  return true;
});
