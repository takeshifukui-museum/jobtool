# Museum Jobtool MVP

ATS求人ページ（主にHRMOS）を開いた状態でChrome拡張から求人票を生成し、Word（.docx）とスカウト文を返すMVPです。

## 構成
```
/museum-jobtool
  /server        Node + Express API
  /extension     Chrome拡張 (MV3)
  /templates     Wordテンプレ
```

## セットアップ（Windows）

### 1) サーバ起動
1. `museum-jobtool/server` に移動
2. 依存関係をインストール
   ```bash
   npm install
   ```
3. `.env.example` を `.env` にコピーして `OPENAI_API_KEY` を設定
4. 開発サーバ起動
   ```bash
   npm run dev
   ```

### 2) テンプレ配置
- `museum-jobtool/templates/museum_template.docx` を、MuseumのWordテンプレに差し替えてください。
- テンプレ内には指定の差し込みタグが含まれている必要があります。

### 3) Chrome拡張の読み込み
1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `museum-jobtool/extension` を選択

### 4) 動作テスト
1. HRMOS求人ページを開く
2. 拡張の「求人票生成」ボタンを押下
3. `.docx` がダウンロードされれば成功

## API
`POST /api/generate`

入力:
```json
{
  "url": "https://...",
  "title": "...",
  "rawText": "document.body.innerText 相当",
  "siteHint": "HRMOS",
  "outputs": ["job_docx", "scout_text"]
}
```

出力:
```json
{
  "docx": "Base64エンコードされたdocx",
  "scoutText": "スカウト文",
  "meta": { "warnings": [] }
}
```

## エラーコード
- `TEXT_EXTRACTION_EMPTY`: rawTextが空
- `SALARY_REQUIRED`: salary.summary が空
- `TEMPLATE_RENDER_FAIL`: docx生成失敗
- `LLM_INVALID_JSON`: LLM出力のJSONが壊れている

## ファイル別要点
- `server/src/index.ts`: APIエンドポイントとエラーハンドリング
- `server/src/openai.ts`: Responses APIで求人票JSONとスカウト文生成
- `server/src/schema.ts`: 求人票JSONスキーマ
- `server/src/sanitize.ts`: 禁止転載フィルタ
- `server/src/word.ts`: docx差し込み + 空行削除
- `server/src/extract.ts`: rawText正規化と配列の整形
- `extension/*`: Chrome拡張UI・抽出・API呼び出し
- `templates/museum_template.docx`: Wordテンプレ（差し替え前提）
