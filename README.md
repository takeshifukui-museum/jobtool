# jobtool（Sales_JobADCatcher_202603）

株式会社Museum｜求人票・スカウト文生成ツール

---

## このプロジェクトの目的

採用サイト（主にHRMOS）の求人ページをChrome拡張から読み込み、
求人票（Word/.docx）とスカウト文を自動生成する。

将来的にはURLを貼るだけで求人票＋スカウト文が一発生成できるSaaSとして
零細人材紹介業者向けに提供することを視野に入れている。

---

## ステータス

**完成（運用中）**

- Chrome拡張（MV3）：求人ページからテキスト抽出 ✅
- Expressサーバー：Claude APIで求人票JSON生成・スカウト文生成 ✅
- Word出力：docxtemplaterで.docx生成 ✅
- Claude APIへの移行完了（旧OpenAI API→Claude API） ✅

---

## 担当AI

**Claude + Claude Code**（開発完了）
**ChatGPT + Codex**（museum-jobtool-codexリポジトリ経由で参照）
改修が必要な場合はAGENTS.mdのルールに従って担当AIを割り当てる。

---

## リポジトリ構成

| リポジトリ | 用途 |
|---|---|
| takeshifukui-museum/jobtool | メイン開発リポジトリ（Claude担当） |
| takeshifukui-museum/museum-jobtool-codex | ChatGPT+Codex参照用（jobtool/mainのミラー） |

---

## 環境

- OS：Windows
- Node.js：v24.13.0
- ローカルパス：C:\dev\jobtool\
- GitHubリポジトリ：takeshifukui-museum/jobtool
- APIキー：Anthropic Claude API（ANTHROPIC_API_KEY）

---

## フォルダ構成

```
jobtool/
├── extension/        Chrome拡張（MV3）
├── server/           Node + Express API
│   └── src/
│       ├── index.ts  APIエンドポイント
│       ├── openai.ts Claude API連携（名前はopenaiだが実際はClaude）
│       ├── schema.ts 求人票JSONスキーマ
│       ├── extract.ts テキスト前処理
│       ├── sanitize.ts 禁止転載フィルタ
│       └── word.ts   Word文書生成
├── templates/        Wordテンプレート
└── assets/           ロゴ等
```

---

## 起動方法

1. `server/起動.bat`をダブルクリック（またはコマンドプロンプトで`npm run dev`）
2. Chromeで`chrome://extensions/`を開く
3. 「パッケージ化されていない拡張機能を読み込む」→`extension/`フォルダを選択
4. HRMOSなどの求人ページを開く
5. Chrome拡張の「求人票を解析」ボタンを押す
6. `.docx`がダウンロードされれば成功

---

## 出力先

- 求人票：`C:\Museum\JobSheets\`
- スカウト文：`C:\Museum\ScoutTexts\`

---

## .envの設定内容

```
ANTHROPIC_API_KEY=AnthropicのAPIキー
```

---

## 保持しているブランチ

| ブランチ | 用途 |
|---|---|
| main | 最新版・本番 |
| finish-jobtool-clean | クリーンな初期状態（参照用） |
| claude/ai-text-editor-split-pane-bdEqm | AIテキストエディタ（別ツール・将来verUP予定） |

---

## 注意事項

- `server/src/openai.ts`というファイル名だが、実際はClaude APIを使用（import文変更コスト回避のため名前を維持）
- credentials等の機密ファイルはGitHubにプッシュしない
- museum-jobtool-codexリポジトリはjobtool/mainのミラーであり、直接編集しない
