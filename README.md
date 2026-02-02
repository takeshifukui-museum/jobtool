# Museum JobTool

求人ページのURLを入力すると、求人情報を取得し、法令順守ルールに沿って整形した株式会社Museumフォーマットの求人票（Word文書）を生成するツールです。

## 構成

- **server/** - Node.js/TypeScriptサーバー（求人情報抽出・Word生成）
- **extension/** - Chrome拡張（UI）

## セットアップ

### 1. サーバーの準備

```bash
cd server

# 依存関係のインストール
npm install

# .envファイルを作成（.env.exampleをコピー）
cp .env.example .env

# .envファイルを編集してOpenAI APIキーを設定
# OPENAI_API_KEY=sk-your-api-key-here
```

### 2. サーバーの起動

```bash
cd server
npm run dev
```

サーバーが `http://localhost:3000` で起動します。

### 3. Chrome拡張のインストール

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をONにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. `extension` フォルダを選択

### 4. ロゴファイルの配置（任意）

Museum ロゴを求人票に表示する場合は、以下のファイルを配置してください：
- `server/templates/museum_logo.png`

## 使い方

1. サーバーを起動（`npm run dev`）
2. Chrome拡張のアイコンをクリック
3. 求人ページのURLを入力（またはHRMOSなどの求人ページで自動入力）
4. 「求人票を生成」ボタンをクリック
5. Word文書がダウンロードされます

## API

### POST /api/generate

求人票を生成します。

**リクエスト:**
```json
{
  "url": "https://hrmos.co/pages/company/jobs/xxxxx"
}
```

**レスポンス:**
- Content-Type: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Content-Disposition: `attachment; filename*=UTF-8''求人票_企業名_ポジション名.docx`

## 法令順守ルール

このツールは以下のルールに従って求人票を生成します：

### 加工禁止項目
以下は原文をそのまま記載（要約・言い換え・再構成禁止）：
- 業務内容
- 求めるスキル（必須/歓迎）
- 年収・待遇
- 休日休暇
- 福利厚生

### 転載禁止項目
以下は元情報にあっても出力しない：
- 性別
- 年齢
- 身体的特徴
- 病歴
- 国籍

### 必須掲載項目
情報がある限り必ず掲載：
- 業務内容
- 契約期間
- 就業場所・就業時刻
- 休憩時間・休日休暇
- 賃金（必須）
- 社会保険

## トラブルシューティング

### 「サーバーに接続できません」エラー
- サーバーが起動しているか確認（`npm run dev`）
- ポート3000が使用されていないか確認

### 「求人情報の抽出に失敗しました」エラー
- OpenAI APIキーが正しく設定されているか確認
- `.env`ファイルが存在するか確認

### 拡張が動作しない
1. `chrome://extensions` で拡張を更新（リロード）
2. 対象ページをF5で更新
3. manifestのmatchesパターンを確認

## 開発

### サーバー開発
```bash
cd server
npm run dev  # 開発モード（ホットリロード）
npm run build  # ビルド
npm start  # 本番起動
```

### ディレクトリ構造
```
jobtool/
├── server/
│   ├── src/
│   │   ├── index.ts      # サーバーエントリーポイント
│   │   ├── openai.ts     # OpenAI API連携
│   │   ├── schema.ts     # JSONスキーマ定義
│   │   ├── scraper.ts    # Webスクレイピング
│   │   └── word.ts       # Word文書生成
│   ├── templates/
│   │   └── museum_logo.png  # ロゴ画像（任意）
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   ├── content.js
│   └── images/
│       └── (icon files)
└── README.md
```
