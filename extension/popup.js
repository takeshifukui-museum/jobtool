const statusEl = document.getElementById("status");
const button = document.getElementById("generate");
const folderEl = document.getElementById("folder");

const setStatus = (text) => {
  statusEl.textContent = text;
};

const loadFolderName = async () => {
  try {
    const data = await chrome.storage.local.get({ folderName: "" });
    const saved = (data.folderName || "").toString();
    if (folderEl) folderEl.value = saved;
  } catch {
    // ignore
  }
};

const saveFolderName = async (folderName) => {
  try {
    await chrome.storage.local.set({ folderName: folderName || "" });
  } catch {
    // ignore
  }
};

loadFolderName();

button.addEventListener("click", () => {
  const folderName = (folderEl?.value ?? "").trim().replace(/\\/g, "/");
  saveFolderName(folderName);
  setStatus("送信中...");
  chrome.runtime.sendMessage({ type: "GENERATE_JOB_DOCX", folderName: folderName || undefined }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(`エラー: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (!response) {
      setStatus("不明なエラーが発生しました");
      return;
    }
    if (response.ok) {
      setStatus(`完了: ${response.message}`);
      if (response.scoutText) {
        setStatus(`完了: ${response.message}\n\nスカウト文:\n${response.scoutText}`);
      }
      return;
    }
    setStatus(`エラー: ${response.message}`);
  });
});
