const btnGenerate = document.getElementById("btn-generate");
const btnRender = document.getElementById("btn-render");
const btnCancel = document.getElementById("btn-cancel");
const previewArea = document.getElementById("preview-area");
const warningsEl = document.getElementById("warnings");
const btnRow = document.getElementById("btn-row");
const statusEl = document.getElementById("status");

// 現在のセッション（プレビュー後に保持）
let currentSession = null;

const setStatus = (text) => {
  statusEl.textContent = text;
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

// ===========================================================================
// Step 1: 「求人票を解析」→ プレビュー表示
// ===========================================================================
btnGenerate.addEventListener("click", () => {
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

    currentSession = {
      runId: response.runId || response.sessionId,
      sessionId: response.runId || response.sessionId,
      suggestedFilename: response.suggestedFilename
    };

    // 警告表示
    const warnings = response.meta?.warnings ?? [];
    const faithViolations = response.meta?.faithViolations ?? [];
    if (warnings.length > 0 || faithViolations.length > 0) {
      warningsEl.innerHTML = "";
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

    previewArea.textContent = response.structuredMd || "(構造化データなし)";
    previewArea.style.display = "block";
    btnRow.style.display = "flex";
    setStatus("プレビューを確認してください。問題なければ「OK — Word生成」を押してください。");
  });
});

// ===========================================================================
// Step 2: 「OK — Word生成」→ サーバー側保存
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

      // サーバーが保存したパスを表示
      const saved = response.savedFiles ?? [];
      if (saved.length > 0) {
        const docx = saved.find((f) => f.endsWith(".docx"));
        setStatus(docx
          ? `保存完了: ${docx}`
          : `保存完了: ${saved.length}件のファイルを保存しました`);
      } else {
        setStatus("完了（保存先未設定 — storage.json を確認してください）");
      }
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
