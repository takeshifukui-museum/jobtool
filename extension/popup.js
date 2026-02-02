// Museum JobTool - Popup Script

const SERVER_URL = "http://localhost:3000";

// DOM Elements
const urlInput = document.getElementById("url");
const generateBtn = document.getElementById("generate");
const useCurrentTabBtn = document.getElementById("useCurrentTab");
const statusDiv = document.getElementById("status");

// Status display functions
function showStatus(message, type) {
  statusDiv.className = `status show ${type}`;
  if (type === "loading") {
    statusDiv.innerHTML = `<span class="spinner"></span>${message}`;
  } else {
    statusDiv.textContent = message;
  }
}

function hideStatus() {
  statusDiv.className = "status";
}

// Use current tab URL
useCurrentTabBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      urlInput.value = tab.url;
    }
  } catch (err) {
    showStatus("タブのURLを取得できませんでした", "error");
  }
});

// Generate document
generateBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();

  if (!url) {
    showStatus("URLを入力してください", "error");
    return;
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    showStatus("無効なURL形式です", "error");
    return;
  }

  // Disable button and show loading
  generateBtn.disabled = true;
  showStatus("求人票を生成中...", "loading");

  try {
    // Send request to local server
    const response = await fetch(`${SERVER_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });

    // Handle error responses - show actual error message (not just "Internal error")
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || `サーバーエラー (${response.status})`);
    }

    // Get the blob
    const blob = await response.blob();

    // Extract filename from Content-Disposition header
    let filename = "求人票.docx";
    const contentDisposition = response.headers.get("Content-Disposition");
    if (contentDisposition) {
      // Try to extract UTF-8 encoded filename
      const utf8Match = contentDisposition.match(/filename\*=UTF-8''(.+)/);
      if (utf8Match) {
        filename = decodeURIComponent(utf8Match[1]);
      } else {
        // Fallback to regular filename
        const match = contentDisposition.match(/filename="?([^";\n]+)"?/);
        if (match) {
          filename = match[1];
        }
      }
    }

    // Create download URL
    const downloadUrl = URL.createObjectURL(blob);

    // Trigger download using Chrome Downloads API
    chrome.downloads.download({
      url: downloadUrl,
      filename: filename,
      saveAs: true,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        showStatus(`ダウンロードエラー: ${chrome.runtime.lastError.message}`, "error");
      } else {
        showStatus(`求人票を生成しました: ${filename}`, "success");
      }
      // Clean up the object URL after a delay
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    });

  } catch (err) {
    // Show detailed error message (not generic "Internal error")
    let errorMessage = err.message;

    if (err.name === "TypeError" && err.message.includes("fetch")) {
      errorMessage = "サーバーに接続できません。\nサーバーが起動しているか確認してください。\n(npm run dev)";
    }

    showStatus(errorMessage, "error");
    console.error("Generation error:", err);
  } finally {
    generateBtn.disabled = false;
  }
});

// Auto-fill URL from current tab on popup open
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      // Only auto-fill for job posting sites
      const jobSites = ["hrmos.co", "workday.com", "greenhouse.io", "lever.co", "recruitee.com"];
      const isJobSite = jobSites.some(site => tab.url.includes(site));
      if (isJobSite) {
        urlInput.value = tab.url;
      }
    }
  } catch {
    // Ignore errors during auto-fill
  }
})();
