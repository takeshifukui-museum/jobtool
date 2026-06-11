const API_GENERATE_URL = "http://localhost:3000/api/generate";
const API_RENDER_URL = "http://localhost:3000/api/render";
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

      // Step 1: /api/generate → sessionId を取得
      const generateResponse = await fetch(API_GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          outputs: ["job_docx", "scout_text"]
        })
      });
      if (!generateResponse.ok) {
        const responseText = await generateResponse.text();
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
      const generateData = await generateResponse.json();
      const { sessionId, scoutText } = generateData;
      if (!sessionId) {
        sendResponse({ ok: false, message: "sessionIdが取得できませんでした" });
        return;
      }

      // Step 2: /api/render → C:/Museum/JobSheets/ に直接保存
      const renderResponse = await fetch(API_RENDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      if (!renderResponse.ok) {
        const responseText = await renderResponse.text();
        let detailMessage = responseText;
        try {
          const errorData = JSON.parse(responseText);
          detailMessage =
            errorData?.error?.detail || errorData?.error?.message || errorData?.error?.code || responseText;
        } catch (parseError) {
          detailMessage = responseText || "レンダリングエラー";
        }
        sendResponse({ ok: false, message: detailMessage });
        return;
      }
      const renderData = await renderResponse.json();
      const { suggestedFilename, savedFiles } = renderData;

      // Step 3: 完了通知（ファイルはサーバーが直接ディスクに保存済み）
      sendResponse({
        ok: true,
        message: `完了: ${suggestedFilename || "求人票"} を保存しました`,
        scoutText: scoutText || ""
      });
    } catch (error) {
      sendResponse({ ok: false, message: error?.message || "エラーが発生しました" });
    }
  });

  return true;
});
