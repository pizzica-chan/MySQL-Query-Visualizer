# MySQL Query Visualizer

MySQL の SELECT / UPDATE / DELETE をブラウザ内で解析し、JOIN・条件・クエリの作用を可視化する Web UI。
React 19 + TypeScript + Vite。SQL 解析は node-sql-parser の MySQL 専用ビルド。サーバーを持たない完全クライアント完結型。

## プロジェクト固有ルール（最優先）

Cursor と共通の恒久ルール。**全文は以下が正**（要点だけ下に再掲するが、判断に迷ったら必ず本文を読む）:

@.cursor/rules/offline-only.mdc
@.cursor/rules/dist-on-push.mdc

- **実行時の外部通信は禁止** — `fetch` / CDN / 外部フォント / Analytics SDK を入れない。SQL やユーザー入力を外部へ送らない。`npm install` や `npm run build` でのネットワーク利用は問題ない（禁止なのは配布物の実行時）。
- **push 前に `dist/` を同期** — `npm run ensure-dist` を通し、ソースと一緒に `dist/` もコミットする。`GITHUB_PAGES=true` のビルド結果は `dist/` にコミットしない。

## コマンド

```bash
npm run dev                  # 開発サーバー (http://localhost:5173)
npm test                     # ユニットテスト一式（vitest）
npm run build                # tsc -b && vite build（オフライン配布向け）
npm run test:dist            # ビルド + オフライン監査 + JOIN 図描画テスト
npm run ensure-dist          # push 前: 再ビルド + 検証 + dist 同期チェック
```

型チェック単体は `npx tsc -b`。ESLint は**未導入**なので、ソース中の `eslint-disable` コメントは実際には効いていない（意図の記録として残っている）。

## 構成

```
src/lib/        解析・比較のロジック（UI 非依存。テストはここに集中している）
src/components/ 表示（React Flow による JOIN 図、各タブ）
src/hooks/      React Flow の state 同期
src/lib/fixtures/ 全テストが共有する SQL ケース集と不変条件アサーション
```

解析パイプライン:

```
入力 SQL
  → sql-preprocess: node-sql-parser が扱えない MySQL 構文を書き換え、
                    同時に processedToOriginal（位置対応表）を作る
  → node-sql-parser で AST 化
  → parser.ts で ParsedQuery へ変換
  → remapParsedQuerySpans で全 sourceSpan を元 SQL の座標へ戻す
```

SQL 前後比較（`query-result-diff.ts`）は、構文カテゴリのシグネチャ比較を主軸に、
合接クエリ範囲でのみ `cq-equivalence.ts` が意味等価を厳密に証明する二段構成。

## 変更時に踏みやすい落とし穴

- **`parser.ts` はモジュールレベルの可変状態を持つ**（`nodeCounter` / `naturalJoinStarts` / `straightJoinHint*`）。`parseMySqlQuery` の先頭の `resetIds()` で毎回全消しする前提なので、解析を並行化したり再入させたりすると壊れる。

- **比較モードの「同じ」は緑で表示され、安全の根拠として読まれる**。偽陽性（違う結果を「同じ」と言う）が最も高コストなので、判定を緩める変更は必ず反例を探してから入れる。

- **エイリアス解決は表示用と比較用で挙動が違う**。比較側は `applyAliasResolution(q, true, { keepSelfJoinAliases: true })` を使う。自己結合の `u1` / `u2` を同じ実テーブル名に潰すと、どちらのインスタンスを出力・絞り込みしているかの違いが消えて誤判定になる。

- **SQL テキストを正規表現で走査するときは `maskNonCode()` を通す**。文字列リテラルやコメントの中身（例: `WHERE note = 'o.id'`）をテーブル参照と誤読する。`maskNonCode` は長さを保つので、マスク後のオフセットは元テキストと一致する。

- **vitest の既定 environment は `node`**。DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く。

- **新しい SQL 構文への対応は `src/lib/fixtures/sql-cases.ts` にケースを足す**。複数のテストファイルがこのフィクスチャを横断で回すので、1 箇所足せば解析の不変条件・正規化・オフライン監査すべてに乗る。
