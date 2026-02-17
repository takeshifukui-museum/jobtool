const API_BASE = "http://localhost:3000";

const btnGenerate = document.getElementById("btn-generate");
const btnRender = document.getElementById("btn-render");
const btnCancel = document.getElementById("btn-cancel");
const previewArea = document.getElementById("preview-area");
const warningsEl = document.getElementById("warnings");
const btnRow = document.getElementById("btn-row");
const statusEl = document.getElementById("status");

// 保存先フォルダ UI
const wordOutputDirEl = document.getElementById("word-output-dir");
const textOutputDirEl = document.getElementById("text-output-dir");
const btnBrowseWord = document.getElementById("btn-browse-word");
const btnBrowseText = document.getElementById("btn-browse-text");

// 現在のセッション（プレビュー後に保持）
let currentSession = null;

const setStatus = (text) => {
  statusEl.textContent = text;
};

// ===========================================================================
// 設定の読み込み / 保存（サーバー側 user_settings.json 経由）
// ===========================================================================
const loadSettings = async () => {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (!res.ok) return;
    const data = await res.json();
    if (wordOutputDirEl) wordOutputDirEl.value = data.wordOutputDir || "";
    if (textOutputDirEl) textOutputDirEl.value = data.textOutputDir || "";
  } catch {
    // サーバー未起動時は無視
  }
};

const saveSettings = async () => {
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wordOutputDir: wordOutputDirEl?.value || "",
        textOutputDir: textOutputDirEl?.value || "",
      }),
    });
  } catch {
    // ignore
  }
};

const browseFolder = async (inputEl) => {
  try {
    const res = await fetch(`${API_BASE}/api/select-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPath: inputEl?.value || "" }),
    });
    const data = await res.json();
    if (data.path) {
      inputEl.value = data.path;
      await saveSettings();
    }
  } catch {
    // ignore
  }
};

// 起動時に設定を読み込み
loadSettings();

// 参照ボタン
btnBrowseWord.addEventListener("click", () => browseFolder(wordOutputDirEl));
btnBrowseText.addEventListener("click", () => browseFolder(textOutputDirEl));

// 入力欄を直接編集した場合も保存
wordOutputDirEl.addEventListener("change", () => saveSettings());
textOutputDirEl.addEventListener("change", () => saveSettings());

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

// ===========================================================================
// Step 1: 「求人票を解析」→ プレビュー表示
// ===========================================================================
btnGenerate.addEventListener("click", () => {
  // 保存先設定を保存
  saveSettings();

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

    // プレビューデータを保持（runId 優先、sessionId は後方互換）
    currentSession = {
      runId: response.runId || response.sessionId,
      sessionId: response.runId || response.sessionId,
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
// Step 2: 「OK — Word生成」→ docx生成 & ダウンロード or 自動保存
// ===========================================================================
btnRender.addEventListener("click", () => {
  const runId = currentSession?.runId || currentSession?.sessionId;
  if (!runId) {
    setStatus("エラー: セッション情報がありません。もう一度「求人票を解析」を押してください。");
    return;
  }

  btnRender.disabled = true;
  btnCancel.disabled = true;
  setStatus("Word生成中...");

  chrome.runtime.sendMessage(
    {
      type: "RENDER_JOB_DOCX",
      runId,
      sessionId: runId,
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

      // サーバーがコピー済みの場合はコピー先を表示
      const copied = response.copiedFiles ?? [];
      if (copied.length > 0) {
        setStatus(`完了: ${copied.length}件のファイルを保存しました`);
      } else {
        setStatus("完了: ダウンロードしました");
      }
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
