const statusEl = document.getElementById("status");
const folderEl = document.getElementById("folder");
const btnGenerate = document.getElementById("btn-generate");
const btnRender = document.getElementById("btn-render");
const btnCancel = document.getElementById("btn-cancel");
const previewArea = document.getElementById("preview-area");
const warningsEl = document.getElementById("warnings");
const btnRow = document.getElementById("btn-row");

// 現在のセッション（プレビュー後に保持）
let currentSession = null;

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

const resetToInitial = () => {
  currentSession = null;
  previewArea.style.display = "none";
  previewArea.textContent = "";
  warningsEl.style.display = "none";
  warningsEl.textContent = "";
  btnRow.style.display = "none";
  btnGenerate.disabled = false;
  setStatus("待機中");
};

loadFolderName();

// ===========================================================================
// Step 1: 「求人票を解析」→ プレビュー表示
// ===========================================================================
btnGenerate.addEventListener("click", () => {
  const folderName = (folderEl?.value ?? "").trim().replace(/\\/g, "/");
  saveFolderName(folderName);

  btnGenerate.disabled = true;
  previewArea.style.display = "none";
  warningsEl.style.display = "none";
  btnRow.style.display = "none";
  setStatus("解析中... （ページ内容を取得してAI構造化しています）");

  chrome.runtime.sendMessage({ type: "GENERATE_JOB_PREVIEW" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(`エラー: ${chrome.runtime.lastError.message}`);
      btnGenerate.disabled = false;
      return;
    }
    if (!response || !response.ok) {
      setStatus(`エラー: ${response?.message || "不明なエラー"}`);
      btnGenerate.disabled = false;
      return;
    }

    // プレビューデータを保持
    currentSession = {
      sessionId: response.sessionId,
      suggestedFilename: response.suggestedFilename
    };

    // Ver 0.3: 警告表示（カテゴリ分け）
    const warnings = response.meta?.warnings ?? [];
    const faithViolations = response.meta?.faithViolations ?? [];
    if (warnings.length > 0 || faithViolations.length > 0) {
      warningsEl.innerHTML = "";

      // カテゴリ別に警告を分類
      const warningLabels = {
        "SOCIAL_INSURANCE_MISSING": "社会保険の情報が未取得です",
        "BENEFITS_MISSING": "福利厚生の情報が未取得です",
        "OVERTIME_MISSING": "時間外労働の情報が未取得です",
        "FAITHFULNESS_VIOLATIONS_DETECTED": "原文忠実性チェックで差異を検出"
      };

      for (const w of warnings) {
        const key = w.split(":")[0];
        const label = warningLabels[key] || w;
        const div = document.createElement("div");
        div.className = key.includes("MISSING") ? "warn-info" : "warn-error";
        div.textContent = label;
        warningsEl.appendChild(div);
      }

      if (faithViolations.length > 0) {
        const header = document.createElement("div");
        header.className = "warn-error";
        header.textContent = `原文忠実性チェック（${faithViolations.length}件）:`;
        warningsEl.appendChild(header);
        faithViolations.forEach((v) => {
          const item = document.createElement("div");
          item.className = "warn-info";
          item.textContent = `  ${v.field}: ${v.value}`;
          warningsEl.appendChild(item);
        });
      }

      warningsEl.style.display = "block";
    }

    // プレビュー表示
    previewArea.textContent = response.structuredMd || "(構造化データなし)";
    previewArea.style.display = "block";
    btnRow.style.display = "flex";
    setStatus("プレビューを確認してください。問題なければ「OK — Word生成」を押してください。");
  });
});

// ===========================================================================
// Step 2: 「OK — Word生成」→ docx生成 & ダウンロード
// ===========================================================================
btnRender.addEventListener("click", () => {
  if (!currentSession?.sessionId) {
    setStatus("エラー: セッション情報がありません。もう一度「求人票を解析」を押してください。");
    return;
  }

  const folderName = (folderEl?.value ?? "").trim().replace(/\\/g, "/");
  btnRender.disabled = true;
  btnCancel.disabled = true;
  setStatus("Word生成中...");

  chrome.runtime.sendMessage(
    {
      type: "RENDER_JOB_DOCX",
      sessionId: currentSession.sessionId,
      folderName: folderName || undefined,
      suggestedFilename: currentSession.suggestedFilename
    },
    (response) => {
      btnRender.disabled = false;
      btnCancel.disabled = false;

      if (chrome.runtime.lastError) {
        setStatus(`エラー: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response || !response.ok) {
        setStatus(`エラー: ${response?.message || "不明なエラー"}`);
        return;
      }

      let msg = "完了: ダウンロードしました";
      if (response.scoutText) {
        msg += `\n\nスカウト文:\n${response.scoutText}`;
      }
      setStatus(msg);
      // 生成完了後はボタンを隠す
      btnRow.style.display = "none";
    }
  );
});

// ===========================================================================
// キャンセル → 初期状態に戻す
// ===========================================================================
btnCancel.addEventListener("click", () => {
  resetToInitial();
});
