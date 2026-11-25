# MySQL Query Visualizer

MySQL の SELECT / UPDATE / DELETE をブラウザ内で解析し、JOIN・条件・クエリの作用を可視化する Web UI。
React 19 + TypeScript + Vite。SQL 解析は node-sql-parser の MySQL 専用ビルド。サーバーを持たない完全クライアント完結型。

## プロジェクト固有ルール（最優先）

Cursor と共通の恒久ルール。**全文は以下が正**（要点だけ下に再掲するが、判断に迷ったら必ず本文を読む）:

@.cursor/rules/offline-only.mdc
@.cursor/rules/dist-on-push.mdc

- **実行時の外部通信は禁止** — `fetch` / CDN / 外部フォント / Analytics SDK を入れない。SQL やユーザー入力を外部へ送らない。`npm install` や `npm run build` でのネットワーク利用は問題ない（禁止なのは配布物の実行時）。
- **push 前に `dist/` を同期** — `npm run ensure-dist` を通し、ソースと一緒に `dist/` もコミットする。

## コマンド

```bash
npm run dev                  # 開発サーバー (http://localhost:5173)
npm test                     # ユニットテスト一式（vitest）
npm run build                # tsc -b && vite build（オフライン配布向け）
npm run test:dist            # ビルド + オフライン監査 + JOIN 図描画テスト
npm run check:browser        # ビルド + ヘッドレス Chrome で dist/ を操作（Tab・IME・クリップボード・hashchange など happy-dom で見られない動き）
npm run ensure-dist          # push 前: 再ビルド + 検証 + dist 同期チェック
```

型チェック単体は `npx tsc -b`。ESLint は**未導入**なので、ソース中の `eslint-disable` コメントは実際には効いていない（意図の記録として残っている）。

## 構成

```
src/lib/        解析・比較のロジック（UI 非依存。テストはここに集中している）
src/components/ 表示（React Flow による JOIN 図、各タブ）
src/hooks/      React Flow の state 同期、配色の購読、エディタのカーソル位置と表示の連動
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

- **node-sql-parser は WHERE・ON・HAVING の中で AND と OR を同じ優先順位として左から結び付ける**（`a OR b AND c` が `(a OR b) AND c` になる）。`parseMySqlQuery` が `astify` の直後に `logical-precedence.ts` で組み直している。AST を自分で `astify` する経路を足すときも、この組み直しを通す。`||` と括弧の無い `XOR` は比較より強く結び付けられて組み直せないので、エラーにしている。

- **`parser.ts` はモジュールレベルの可変状態を持つ**（`nodeCounter` / `naturalJoinStarts` / `straightJoinHint*`）。`parseMySqlQuery` の先頭の `resetIds()` で毎回全消しする前提なので、解析を並行化したり再入させたりすると壊れる。

- **比較モードの緑の「同じ」は、安全の根拠として読まれる**。緑は等価性を証明できたとき（`cq-equivalence.ts`）だけに出し、構文に差分が無いだけのときは色の付かない「構文の違いなし」にしている。偽陽性（違う結果を「同じ」と言う）が最も高コストなので、判定を緩める変更は必ず反例を探してから入れる。

- **エイリアス解決は表示用と比較用で挙動が違う**。比較側は `applyAliasResolution(q, true, { keepSelfJoinAliases: true })` を使う。自己結合の `u1` / `u2` を同じ実テーブル名に潰すと、どちらのインスタンスを出力・絞り込みしているかの違いが消えて誤判定になる。

- **SQL テキストを正規表現で走査するときは `maskNonCode()` を通す**。文字列リテラルやコメントの中身（例: `WHERE note = 'o.id'`）をテーブル参照と誤読する。`maskNonCode` は長さを保つので、マスク後のオフセットは元テキストと一致する。

- **vitest の既定 environment は `node`**。DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く。

- **新しい SQL 構文への対応は `src/lib/fixtures/sql-cases.ts` にケースを足す**。複数のテストファイルがこのフィクスチャを横断で回すので、1 箇所足せば解析の不変条件・正規化・オフライン監査すべてに乗る。

- **ホバーで要素の位置や当たり判定を変えない**（`transform` で持ち上げる、線の当たり判定のパスを細くする、など）。要素の端にあるマウスが外れてホバーが切れ、戻ってまたホバーする、を繰り返してカーソルや表示が点滅する（JOIN 図の線で ea1722e が直した）。ホバーで変えるのは色・枠・影だけにする。

- **JOIN 図の線と矢印の色は CSS 変数にしない**。React Flow は矢印マーカーの id に色の文字列を使うので、`var(...)` を渡すと id が壊れる。テーマごとの色は `themedJoinColor` / `themedJoinEdge`（`join-flow-layout.ts`）で 16 進の色を差し替える。ミニマップや背景の点など props で渡す色も同じ。

- **テーブルの別名の大文字小文字は OS で変わる**。MySQL のテーブルの別名は、Unix では既定で区別し、Windows と macOS では区別しない（MySQL 8.4 リファレンス 11.2.3）。「同じ別名が 1 つだけか」のように重複を数える判定では、区別しない側で数える。

- **エディタのカーソル連動は DOM の `data-span-start` / `data-span-end` で要素を探す**（`useCaretSourceLink`）。新しい表示要素を SQL と連動させるときは `sourceSelectableProps` を使えば、クリックの連動とカーソルの連動の両方の対象になる。非表示のタブ（`.tab-pane--hidden`）の要素は対象外。

- **テストや `npm run check:browser` の確認項目を足したら、直す前のコードで失敗することを確かめる**。別の経路で同じ状態になって、修正がなくても通る項目を書いてしまうことがある（JOIN 図の中だけの描き直しを確かめるつもりの項目が、App 全体の描き直しで通っていた）。

- **単一解析の右側（`AnalysisResult`）は `memo` で包み、SQL の入力中は描き直さない**。大きな SQL では右側の DOM が 20 万要素を超え、1 文字ごとに描き直すと入力が数秒止まる。props に渡すのは、入力中に変わらない値（`useMemo` の結果、`useState` の setter、`useCallback`）だけにする。その場で作るオブジェクトや関数（`{...}` や `() => ...`）を渡すと、描くたびに値が変わるので、memo で描き直しを止められない。`App.render-count.test.tsx` で確かめている。

- **エディタの色分け（`sql-highlight.ts`）は、入力の 1 文字ごとに SQL 全体に対して実行する**。文字ごとに正規表現を作ったり、残りの文字列を `slice` で切り出したりしない。正規表現は最初に 1 回だけ作り、sticky（`y`）で位置を指定して照合する。

- **入力中の SQL をボタンなどで差し替えるときは、SqlEditor の中で `execCommand('insertText')` を使って入れる**（サンプルの読み込みは `replaceAll`、字下げは `applyEdit`）。`setSql` などで値を直接差し替えると、ブラウザの「元に戻す」の履歴が消える。さらに 300ms 後には保存も上書きされるので、入力していた SQL を取り戻せなくなる。
