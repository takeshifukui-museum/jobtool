# サーバー実行手順（PowerShell）

## 1. 依存関係のインストール

```powershell
cd C:\dev\museum-jobtool\server
npm install
```

## 2. 環境変数の設定

`.env` を作成し、OpenAI API キーを設定します。

```powershell
# .env.example をコピーして編集
Copy-Item .env.example .env
# .env を開いて OPENAI_API_KEY=sk-... を設定
```

または手動で `.env` を作成：

```
OPENAI_API_KEY=sk-your-key-here
PORT=3000
```

## 3. サーバーの起動

**開発モード（tsx watch）:**

```powershell
cd C:\dev\museum-jobtool\server
npm run dev
```

**ビルドして本番起動:**

```powershell
cd C:\dev\museum-jobtool\server
npm run build
npm start
```

## 4. 動作確認（/api/generate の呼び出し）

別の PowerShell ウィンドウで：

```powershell
$body = @{
  url = "https://example.com/job/123"
  title = "エンジニア募集"
  rawText = "【業務内容】システム開発【給与】月給30万円〜"
  siteHint = "hrmos"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/generate" -Body $body -ContentType "application/json; charset=utf-8"
```

## 保存されるファイルの例（パス）

`/api/generate` が成功すると、次のディレクトリに中間成果物が保存されます。

**ディレクトリ形式:**

```
server/data/YYYY-MM-DD/{company}_{position}_{hash}/
```

**具体例（2025年2月12日に「株式会社サンプル」の「Webエンジニア」で生成した場合）:**

```
C:\dev\museum-jobtool\server\data\2025-02-12\株式会社サンプル_Webエンジニア_a1b2c3d4\meta.json
C:\dev\museum-jobtool\server\data\2025-02-12\株式会社サンプル_Webエンジニア_a1b2c3d4\job_raw.md
C:\dev\museum-jobtool\server\data\2025-02-12\株式会社サンプル_Webエンジニア_a1b2c3d4\job_structured.md
C:\dev\museum-jobtool\server\data\2025-02-12\株式会社サンプル_Webエンジニア_a1b2c3d4\job.json
C:\dev\museum-jobtool\server\data\2025-02-12\株式会社サンプル_Webエンジニア_a1b2c3d4\output.docx
```

| ファイル         | 内容 |
|------------------|------|
| `meta.json`      | 警告一覧、リクエストの url/title、保存日時 |
| `job_raw.md`     | 正規化した生テキスト（入力本文） |
| `job_structured.md` | 構造化・サニタイズ後の求人データ（JSON 整形） |
| `job.json`       | サニタイズ後の求人オブジェクト（JSON） |
| `output.docx`    | 生成された求人票 Word ファイル |

※ `{company}` / `{position}` はファイル名に使えない文字が `_` に置換され、長さは最大 50 文字に切り詰められます。`{hash}` は URL + タイムスタンプから算出した 8 文字の英数字です。
