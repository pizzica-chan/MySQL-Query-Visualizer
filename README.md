# MySQL Query Visualizer

MySQL の **SELECT / UPDATE / DELETE** をブラウザ内で解析し、JOIN・条件・クエリの作用を視覚的に表示する Web UI です。  
SQL の送信や外部 API 通信は行わず、**完全オフライン**で動作します。

## 機能

### SQL 入力

- リアルタイム解析（入力後 400ms）
- シンタックスハイライト
- サンプル読み込み（SELECT / UPDATE / DELETE / UNION）

### タブ

| タブ | 内容 |
|------|------|
| **作用説明** | 表示・更新・削除の対象、検索範囲（JOIN）、WHERE / HAVING を自然言語で説明 |
| **SQL構造** | 文の種類・件数、テーブル一覧、SELECT 列、GROUP BY、ORDER BY、LIMIT、SET 句、DELETE 対象など |
| **JOIN 図** | テーブル間の結合をインタラクティブなグラフで表示。LEFT JOIN が後続条件で実質 INNER になる場合は破線・≈INNER で示す |
| **WHERE / HAVING** | 論理演算子ごとの条件ツリー。IN / EXISTS 内のサブクエリも展開 |
| **UNION / サブクエリ** | UNION 各ブランチやネストした SELECT を個別に解析（該当時のみ表示） |

### その他

- **エイリアスを実テーブル名で表示** — チェックで JOIN 図・条件・SQL構造タブの表示名を切り替え

## 起動方法（開発）

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 を開いてください。

## ビルド

```bash
npm run build
npm run preview   # ビルド成果物の確認（http://localhost:4173）
```

## GitHub Pages で公開

`master` / `main` への push で [GitHub Actions](.github/workflows/deploy-pages.yml) がテスト・ビルド・デプロイを行います。

**公開 URL:** https://pizzica-chan.github.io/MySQL-Query-Visualizer/

### 初回セットアップ（リポジトリ設定）

1. GitHub リポジトリの **Settings → Pages**
2. **Build and deployment → Source** を **GitHub Actions** に変更
3. `master`（または `main`）へ push するとワークフローが実行される

### ローカルで Pages 向けビルドを試す

通常の `npm run build` はオフライン配布用（`base: './'`）。GitHub Pages 向けは環境変数 `GITHUB_PAGES=true` を付けてビルドします。

```bash
# Linux / macOS / Git Bash
GITHUB_PAGES=true npm run build

# PowerShell
$env:GITHUB_PAGES='true'; npm run build
```

## オフライン配布

`npm run build` の成果物は **`dist/`** に出力されます。

```
dist/
  index.html      … CSS は <style> にインライン、JS は ./assets/app.js を参照
  assets/app.js
  assets/app.css  … ビルド生成物（index.html からは参照しない）
```

**インライン CSS + classic script（非 module）** のため、`dist/index.html` をブラウザで直接開いても利用できます（`dist/assets/app.js` も同じフォルダに必要）。

> `file://` では外部 CSS（`<link href="...">`）と ES module の外部読み込みが CORS でブロックされます。CSS は HTML 内に埋め込み、JS は IIFE の classic script で読み込みます。

リポジトリには `dist/` も同梱しているため、Node.js がなくても配布物だけでオフライン利用できます。

配布物を更新する場合:

```bash
npm run build              # オフライン配布向け（GITHUB_PAGES は付けない）
npm run verify-dist-offline # file:// 直開き向けか検証
npm run ensure-dist        # push 前: 再ビルド + 検証 + dist 同期チェック
```

> **注意:** `GITHUB_PAGES=true npm run build` は GitHub Actions の Pages デプロイ専用です。  
> 生成物を `dist/` にコミットしないでください（`ensure-dist` と CI が検出して失敗します）。

## テスト

```bash
npm test              # ユニットテスト一式
npm run test:dist     # ビルド + オフライン監査・JOIN 図描画テスト
```

## 対応範囲

### 文種

- **SELECT**（UNION / サブクエリ / 派生テーブル含む）
- **UPDATE**（JOIN 付き、SET 句）
- **DELETE**（複数テーブル指定）

### SQL 構文（主要）

- JOIN: INNER / LEFT / RIGHT / FULL / CROSS、暗黙 JOIN（カンマ区切り）
- WHERE / HAVING: 比較、IN、BETWEEN、LIKE、IS NULL、EXISTS、NOT、AND / OR
- GROUP BY / ORDER BY / LIMIT / OFFSET / DISTINCT

### 未対応・制限

- INSERT / REPLACE など上記以外の文種
- WITH（CTE）、ウィンドウ関数の専用説明
- 実行計画・実際の行数取得（解析・可視化のみ）

## 技術スタック

- React 19 + TypeScript + Vite
- [node-sql-parser](https://github.com/taozhi8833990/node-sql-parser) — MySQL AST 解析
- [@xyflow/react](https://reactflow.dev/) — JOIN 関係のグラフ表示
