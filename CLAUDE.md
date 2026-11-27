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
                    取り除いた修飾子と句（文の最後の FOR UPDATE / FOR SHARE、PARTITION (…)、IGNORE など）を位置付きで記録し、
                    同時に processedToOriginal（位置対応表）を作る
  → node-sql-parser で AST 化
  → parser.ts で ParsedQuery へ変換（記録した行ロックと IGNORE を最上位の文に持たせる）
  → remapParsedQuerySpans で全 sourceSpan を元 SQL の座標へ戻し、trimParsedQuerySpanEnds で範囲の後ろの空白とコメントを除き、
    attachTableModifiers で、記録した PARTITION (…) をその表に持たせる
```

SQL 前後比較（`query-result-diff.ts`）は、構文カテゴリのシグネチャ比較を主軸に、
合接クエリ範囲でのみ `cq-equivalence.ts` が意味等価を厳密に証明する二段構成。

## 変更を報告する前に確かめること

これまでの不具合の多くは、次のどれかを確かめずに直したことから出ている。直したら、報告する前に 1 つずつ確かめる。

1. **MySQL で書ける SQL か**。MySQL Reference Manual の構文と、その構文の説明にある制限を確かめる。書けない形はエラーにする（`FULL JOIN` を受け付け、ケース集にも成功する SQL として載っていた）。ケース集に `expectSuccess: true` で足す SQL も、MySQL で動くかを確かめる。
2. **前処理で取り除いたものを、作用説明から消していないか**。修飾子や句を取り除くときは、`REMOVED_MODIFIER_HANDLING`（sql-preprocess.ts）に扱いを書く。記録して作用説明に出すか、結果の行も SQL の作用も変えない理由を書く。`preprocess-removed.test.ts` が、取り除く修飾子のすべてに扱いが決まっていることと、出すと決めたものが作用説明に出ていることを確かめている（`UPDATE IGNORE` の IGNORE と、表の後ろの `PARTITION (…)` を黙って取り除いていた）。
3. **SQL を渡して確かめたか**。作用説明のテストは、`ParsedQuery` を手で組み立てずに、`parseMySqlQuery` に SQL を渡して書く。説明の文を用意しても、パーサーがその SQL を読めず、文まで届かないことがある（`FOR SHARE` と `FOR UPDATE OF` の説明の文があったのに、構文エラーになっていた）。
4. **同じ仕組みの、別の形でも試したか**。1 つの形で直したら、次の形も試す。
   - 演算子: 種類を替えた形と、左右を入れ替えた形
   - 結合: INNER・LEFT・RIGHT・CROSS・STRAIGHT_JOIN・NATURAL・カンマ結合
   - 位置: SQL の途中と最後、サブクエリと派生テーブルの中、UNION のブランチ
   - 文: SELECT・UPDATE・DELETE（複数のテーブルを使う UPDATE と DELETE を含む）
5. **エラー文が、正しい SQL を直すように案内していないか**。MySQL で書けるのに読めない構文は、未対応と書く（`EXCEPT ALL` に「「ALL」で構文を解釈できません」と出ていた）。
6. **Oracle 版も確かめたか**（下の「Oracle 版と同じ作りのファイルが多い」）。説明の文を持ってくるときは、その方言の公式のリファレンスで意味を確かめる（`FOR UPDATE OF` の後ろに書くのは、Oracle では列、MySQL では表。Oracle 版の文を持ってきて、「指定した列の表」と書いていた）。
7. **足したテストが、直す前のコードで失敗するか**（下の「テストや `npm run check:browser` の確認項目を足したら」）。

## 変更時に踏みやすい落とし穴

- **node-sql-parser は WHERE・ON・HAVING の中で AND と OR を同じ優先順位として左から結び付ける**（`a OR b AND c` が `(a OR b) AND c` になる）。`parseMySqlQuery` が `astify` の直後に `logical-precedence.ts` で組み直している。AST を自分で `astify` する経路を足すときも、この組み直しを通す。`||` と括弧の無い `XOR` は比較より強く結び付けられて組み直せないので、エラーにしている。

- **`parser.ts` はモジュールレベルの可変状態を持つ**（`nodeCounter` / `naturalJoinStarts` / `processedSqlForNatural` / `straightJoinHint*` / `embeddedSubqueryAsts` / `renamedFunctions` / `maskedProcessed` / `maskedProcessedFor`）。`parseMySqlQuery` の先頭の `resetIds()` で毎回全消しする前提なので、解析を並行化したり再入させたりすると壊れる。変数を足したら、`resetIds()` とこの一覧の両方に足す。

- **比較モードの緑の「同じ」は、安全の根拠として読まれる**。緑は等価性を証明できたとき（`cq-equivalence.ts`）だけに出し、構文に差分が無いだけのときは色の付かない「構文の違いなし」にしている。偽陽性（違う結果を「同じ」と言う）が最も高コストなので、判定を緩める変更は必ず反例を探してから入れる。見つけた反例と「同じ」と判定すべきペアは `src/lib/fixtures/result-diff-pairs.ts` に足す（`query-result-diff-soundness.test.ts` が全件を回す）。

- **比較の正規化は「結果を変えない書き換え」だけにする**。JOIN は辺の集合ではなく結合の木（`join-tree.ts`）で比べる。外部結合で行を残す側は直前のテーブルではなく、それより左の結合全体。等価性の証明（`cq-equivalence.ts`）は MySQL の `=` を推移的にも反射的にも扱わない（型変換と NULL で成り立たない）。

- **エイリアス解決は表示用と比較用で挙動が違う**。比較側は `applyAliasResolution(q, true, { keepSelfJoinAliases: true })` を使う。自己結合の `u1` / `u2` を同じ実テーブル名に潰すと、どちらのインスタンスを出力・絞り込みしているかの違いが消えて誤判定になる。

- **SQL テキストを正規表現で走査するときは `maskNonCode()` を通す**。文字列リテラルやコメントの中身（例: `WHERE note = 'o.id'`）をテーブル参照と誤読する。`maskNonCode` は長さを保つので、マスク後のオフセットは元テキストと一致する。

- **vitest の既定 environment は `node`**。DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く。

- **新しい SQL 構文への対応は `src/lib/fixtures/sql-cases.ts` にケースを足す**。複数のテストファイルがこのフィクスチャを横断で回すので、1 箇所足せば解析の不変条件・正規化・オフライン監査すべてに乗る。

- **ホバーで要素の位置や当たり判定を変えない**（`transform` で持ち上げる、線の当たり判定のパスを細くする、など）。要素の端にあるマウスが外れてホバーが切れ、戻ってまたホバーする、を繰り返してカーソルや表示が点滅する（JOIN 図の線で ea1722e が直した）。ホバーで変えるのは色・枠・影だけにする。

- **JOIN 図の線と矢印の色は CSS 変数にしない**。React Flow は矢印マーカーの id に色の文字列を使うので、`var(...)` を渡すと id が壊れる。テーマごとの色は `themedJoinColor` / `themedJoinEdge`（`join-flow-layout.ts`）で 16 進の色を差し替える。ミニマップや背景の点など props で渡す色も同じ。

- **テーブルの別名の大文字小文字は OS で変わる**。MySQL のテーブルの別名は、Unix では既定で区別し、Windows と macOS では区別しない（MySQL 8.4 リファレンス 11.2.3）。「同じ別名が 1 つだけか」のように重複を数える判定では、区別しない側で数える。

- **エディタのカーソル連動は DOM の `data-span-start` / `data-span-end` で要素を探す**（`useCaretSourceLink`）。新しい表示要素を SQL と連動させるときは `sourceSelectableProps` を使えば、クリックの連動とカーソルの連動の両方の対象になる。非表示のタブ（`.tab-pane--hidden`）の要素は対象外。

- **テストや `npm run check:browser` の確認項目を足したら、直す前のコードで失敗することを確かめる**。別の経路で同じ状態になって、修正がなくても通る項目を書いてしまうことがある（JOIN 図の中だけの描き直しを確かめるつもりの項目が、App 全体の描き直しで通っていた）。直したファイルだけを `git stash push <ファイル>` で戻してテストを実行し、戻ったことを `git status` で確かめる（無いファイルを並べると stash そのものが失敗し、直したコードのままテストを実行してしまう）。不具合は特定の形でしか出ないことがある（位置を返さないノード、データベース名付きの列、など）ので、見つけた SQL そのものから縮めてテストを書く。テストや確認スクリプトの指摘を、確認の仕組みの誤りと判断する前に、その SQL で実際の範囲と表示を確かめる。

- **単一解析の右側（`AnalysisResult`）は `memo` で包み、SQL の入力中は描き直さない**。大きな SQL では右側の DOM が 20 万要素を超え、1 文字ごとに描き直すと入力が数秒止まる。props に渡すのは、入力中に変わらない値（`useMemo` の結果、`useState` の setter、`useCallback`）だけにする。その場で作るオブジェクトや関数（`{...}` や `() => ...`）を渡すと、描くたびに値が変わるので、memo で描き直しを止められない。`App.render-count.test.tsx` で確かめている。

- **エディタの色分け（`sql-highlight.ts`）は、入力の 1 文字ごとに SQL 全体に対して実行する**。文字ごとに正規表現を作ったり、残りの文字列を `slice` で切り出したりしない。正規表現は最初に 1 回だけ作り、sticky（`y`）で位置を指定して照合する。

- **入力中の SQL をボタンなどで差し替えるときは、SqlEditor の中で `execCommand('insertText')` を使って入れる**（サンプルの読み込みは `replaceAll`、字下げは `applyEdit`）。`setSql` などで値を直接差し替えると、ブラウザの「元に戻す」の履歴が消える。さらに 300ms 後には保存も上書きされるので、入力していた SQL を取り戻せなくなる。

- **式の表示用の文字列（`exprToString` の結果）を、あとから読み直して表を探す処理がある**。読み直しているのは、別名の置き換え（`alias-resolver.ts`）、実質 INNER JOIN の判定（`join-effective-inner.ts`）、結合条件が参照する表（`join-condition.ts`）、作用説明の色分け（`effect-text-highlight.ts`）、SQL前後比較（`query-result-diff.ts`・`cq-equivalence.ts`）。名前のバッククォートやデータベース名の付け方など、式の書き方を変えたら、これらをすべて確かめる（`\.` を含む正規表現で検索すると洗い出せる）。表の参照を正規表現で探すときは `\b` を使わず、`qualifiedReferencePattern()`（sql-lex.ts）を使う。`\b` は ASCII の文字しか語として扱わないので、日本語の名前（`売上.`）の前で境界にならない。`maskNonCode()` はバッククォートの名前も伏せるので、表の参照を探す前には、バッククォートの名前を残す `maskLiteralsAndComments()` を使う。

- **SQL パーサーは、文字列・数値・NULL・CASE 式・CAST・FROM 句のサブクエリに位置（`loc`）を返さない**。列の範囲は `fillMissingColumnSpans`、派生テーブルは `derivedTableSourceSpan` で補っている（parser.ts）。範囲や位置に頼る処理を足すときは、これらの形でもテストする。

- **SQL パーサーは、MySQL では書けない SQL も受け付ける**（ON の無い `LEFT JOIN`、MySQL には無い `FULL JOIN` など）。受け付けたまま説明すると、MySQL では動かない SQL の作用を見せてしまう。新しい書き方に対応するときは、MySQL Reference Manual の構文で書けるかを確かめ、書けない形はエラーにする。

- **作用説明に、SQL の結果についての説明（NULL の扱い・小計の行・行ロックなど）を足すときは、公式のリファレンスで確かめ、コードのコメントに出典を書く**。ページの文を文言どおりに確かめられないときは、確かめられた範囲だけを書き、コメントにもそう書く。

- **解析の途中で使う仮の名前と値を、画面に出さない**（結合条件の無い JOIN の印 `(no condition)`、別名の無いサブクエリの `derived_0`、名前を読めなかった表の `table_1`）。`display-placeholder.test.ts` が、共有のケース集の全件の作用説明と SQL 構造で確かめている。仮の名前を新しく作るときは、このテストの判定にも足す。

- **Oracle 版（`../OracleDB-QueryParser`）と同じ作りのファイルが多い**（`query-effect.ts`・`join-effective-inner.ts`・`join-condition.ts`・`alias-resolver.ts`・`effect-text-highlight.ts`、parser.ts の式の表示と範囲を補う処理など）。片方で不具合を直したら、もう片方の同じ関数も確かめる。違う作りの例: 集合演算の結果全体の ORDER BY と LIMIT は、MySQL 版では `unionTail` が持ち、Oracle 版では最上位の `ParsedQuery` が持つ。
