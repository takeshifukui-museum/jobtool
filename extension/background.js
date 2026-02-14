const API_BASE = "http://localhost:3000";
const API_EXTRACT  = `${API_BASE}/api/extract`;
const API_STRUCTURE = `${API_BASE}/api/structure`;
const API_RENDER   = `${API_BASE}/api/render`;

// 互換: 旧 /api/generate（extract+structure を1回で行う）
const API_GENERATE = `${API_BASE}/api/generate`;

// R1: Service Worker 互換 — base64 を Data URL に変換
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

/** API にPOSTしてJSONまたはエラーを返す */
const apiPost = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error?.detail || data?.error?.code || text || "APIエラー";
    throw new Error(detail);
  }
  return data;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // -----------------------------------------------------------------------
  // Step 1: GENERATE_JOB_PREVIEW
  //   新パイプライン: extract → structure の2段階
  //   フォールバック: /api/generate（互換）
  // -----------------------------------------------------------------------
  if (message.type === "GENERATE_JOB_PREVIEW") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      try {
        const tab = tabs[0];
        if (!tab || !tab.id) {
          sendResponse({ ok: false, message: "アクティブタブが見つかりません" });
          return;
        }
        const payload = await extractFromTab(tab.id);

        // --- パイプライン: extract → structure ---
        const extractResult = await apiPost(API_EXTRACT, {
          rawText: payload.rawText,
          rawHtml: payload.rawHtml,
          url: payload.url,
          title: payload.title,
          siteHint: payload.siteHint,
          extractMeta: payload.extractMeta
        });

        const structureResult = await apiPost(API_STRUCTURE, {
          runId: extractResult.runId
        });

        sendResponse({
          ok: true,
          // runId（新）+ sessionId（旧互換）
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

  // -----------------------------------------------------------------------
  // Step 2: RENDER_JOB_DOCX — 確認後にWord生成 & ダウンロード
  // -----------------------------------------------------------------------
  if (message.type === "RENDER_JOB_DOCX") {
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
        const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const dataUrl = base64ToDataUrl(data.docx, contentType);

        // R5: callback 形式で downloads.download を呼ぶ（MV3安定性）
        chrome.downloads.download(
          { url: dataUrl, filename, saveAs: true },
          (downloadId) => {
            // R3: lastError を必ず確認
            if (chrome.runtime.lastError) {
              const err = chrome.runtime.lastError.message || "unknown download error";
              console.error("[background] download failed:", err);
              sendResponse({ ok: false, message: `download failed: ${err}` });
              return;
            }
            console.log("[background] download started, id:", downloadId);
            sendResponse({ ok: true, message: "ダウンロードしました", scoutText: data.scoutText || "" });
          }
        );
      } catch (error) {
        sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
      }
    })();
    return true;
  }
});
