# MySQL Query Visualizer

MySQL の **SELECT / UPDATE / DELETE** をブラウザ内で解析し、JOIN・条件・クエリの作用を視覚的に表示する Web UI です。  
SQL の送信や外部 API 通信は行わず、**完全オフライン**で動作します。

## 機能

### SQL 入力

- リアルタイム解析（入力後 400ms）
- シンタックスハイライト
- サンプル読み込み（SELECT / UPDATE / DELETE / UNION）
  - SELECT: 多段 JOIN・派生テーブル・相関 EXISTS / IN / NOT IN
  - UNION: ブランチごとに JOIN・集約・派生テーブル・サブクエリ

### モード

| モード | 内容 |
|------|------|
| **単一解析** | 1 本の SQL を解析し、構造・作用・JOIN 図を表示（従来どおり） |
| **SQL前後比較** | 2 本の SQL（変更前 / 変更後）を構文比較し、実行結果に影響しそうな差分をカテゴリ別に表示 |

### タブ（単一解析）

| タブ | 内容 |
|------|------|
| **SQL構造** | 句ごとの SQL 構造（表示対象・結合条件・WHERE・集約・後処理）。クリックで左の SQL と連動（デフォルト） |
| **作用説明** | SQL が苦手な方向けの自然言語説明。JOIN を文章で説明し、要約・WHERE・集約を日本語で表示 |
| **JOIN 図** | テーブル間の結合をインタラクティブなグラフで表示。UNION 時はブランチごとの JOIN 図 |
| **サブクエリ** | IN / EXISTS / 派生テーブルなどネストした SELECT を個別に解析（該当時のみ表示） |

### SQL前後比較

性能改善などで JOIN などを書き換えたとき、**結果が変わっていないか**を構文面から確認するためのモードです。  
主軸は **構文差分の列挙**（実行前の構文レビュー）で、限定した範囲でのみ意味等価を証明します。

- 実 DB への実行や結果行の貼り付けは行いません（完全オフライン・解析のみ）
- 出力列・テーブル・JOIN・WHERE / HAVING・GROUP BY・LIMIT・UNION / CTE などをカテゴリ別に比較
- サマリーは **結果セット**（行の集合）と **並び順**（ORDER BY）を分けて表示します
- LIMIT / OFFSET があるとき、ORDER BY の違いは結果セットにも影響し得ると判定します
- エイリアスの違いは実テーブル名に解決してから比較します
- よくあるリファクタ（INNER の WHERE↔ON など）で証明まで届かないものは **要確認ヒント**（黄）として補助表示します。結果セット推定は「異なる」のままです
- 「結果セットが同じ」は構文カテゴリに差分がないことの推定です（下記の証明が付く場合を除く）

#### 合接クエリ範囲での等価証明

一般の SQL 意味等価は決定不能ですが、**合接クエリ（conjunctive query）** に収まる範囲なら等価性を厳密に判定できます（Chandra-Merlin の準同型定理）。この範囲に限って、構文が違っても「結果セットは同じ」と言い切ります。

判定対象になる条件（すべて満たすときのみ）:

- INNER / CROSS / STRAIGHT_JOIN と暗黙結合のみ（OUTER・NATURAL は対象外）
- 条件は `AND` と `=` のみ。オペランドは修飾済みの列参照か数値 / 文字列リテラル
- 正の相関 `EXISTS`（半結合）は本体に展開して扱う。`NOT EXISTS` は対象外
- 出力列は修飾済みの単純な列参照のみ（`*`・関数・式は対象外）
- GROUP BY / HAVING / LIMIT / OFFSET / UNION / CTE / 派生テーブルがない
- テーブル参照が 8 個以内

これにより「相関 EXISTS ↔ INNER JOIN + DISTINCT」「WHERE ↔ ON の移動」「冗長な自己結合」などが、パターンマッチではなく同一の正規形として一致します。

安全側の設計:

- **許可リスト方式** — 対象外の構文が 1 つでもあれば即座に判定を諦め、従来の構文差分表示に戻ります
- **字句レベルの二重チェック** — 構文木とは別に元 SQL を走査し、対象外のキーワード・演算子があれば拒否します
- **探索予算** — 上限を超えたら「証明できなかった」扱いにします（打ち切りで「同じ」とは言いません）
- **DISTINCT の非対称** — 片方だけ `DISTINCT` の場合は緑にせず「重複を除けば同じ」と表示します（元テーブルに重複行があると行数が変わるため）

### その他

- **エイリアスを実テーブル名で表示** — チェックで JOIN 図・条件・SQL構造の表示名を切り替え（単一解析）

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

- JOIN: INNER / LEFT / RIGHT / FULL / CROSS / **STRAIGHT_JOIN**、**NATURAL JOIN**、**JOIN USING**、暗黙 JOIN（カンマ区切り）
- **WITH（CTE）** — 定義の解析と FROM 参照の紐付け、作用説明での表示
- WHERE / HAVING: 比較、IN、BETWEEN、LIKE、IS NULL、EXISTS、NOT、AND / OR
- GROUP BY / ORDER BY / LIMIT / OFFSET / DISTINCT
- MySQL ヒント・修飾子: `SELECT STRAIGHT_JOIN`（クエリ単位の結合順ヒント。FROM の JOIN 種別は書き換えない） / `DISTINCTROW` 等、`USE`/`FORCE`/`IGNORE INDEX`、`PARTITION`、`UPDATE`/`DELETE` の `LOW_PRIORITY` / `IGNORE` / `QUICK`

### 未対応・制限

- INSERT / REPLACE など上記以外の文種
- ウィンドウ関数の専用説明
- オプティマイザヒントコメント（`/*+ STRAIGHT_JOIN */` 等）
- 実行計画・実際の行数取得（解析・可視化のみ）
- SQL前後比較における一般の意味的等価の証明（合接クエリ範囲を超えると構文差分の検出まで）

## 技術スタック

- React 19 + TypeScript + Vite
- [node-sql-parser](https://github.com/taozhi8833990/node-sql-parser) — MySQL AST 解析
- [@xyflow/react](https://reactflow.dev/) — JOIN 関係のグラフ表示
