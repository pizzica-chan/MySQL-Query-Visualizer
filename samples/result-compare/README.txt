結果比較モード用の手動テスト用サンプル（アプリからは読み込みません）

使い方:
  1. アプリヘッダで「結果比較」を選ぶ
  2. 各ケースの before.sql を SQL A、after.sql を SQL B に貼る
  3. 期待結果は各フォルダの expected.txt を参照

ケース一覧:
  --- 結果同じと推定しやすいリファクタ ---
  01-alias-only             … エイリアス表記のみ変更
  02-join-order             … INNER JOIN の記述順入れ替え（結合順リファクタの基本）
  04-where-and-swap         … WHERE の AND 順序入れ替え
  08-join-reorder-refactor  … 4 表の結合順リファクタ（行は同じ・結合順だけ違う）
  10-comma-to-inner-join    … カンマ結合 → 明示 INNER JOIN

  --- 行順のみ ---
  03-order-by-only          … ORDER BY のみ変更（結果セットは同じ・並び順に差分）

  --- 構文差分が出やすい（意図は同等寄り） ---
  09-where-to-on            … WHERE 絞り込みを ON へ移動（INNER では行は同じことが多いが構文差分）
  07-subquery-to-join       … 相関 EXISTS → JOIN + DISTINCT

  --- 結果が変わる例 ---
  05-join-condition-bug          … JOIN 条件のミス
  06-select-column-add           … SELECT 列追加
  11-left-join-preserved-side    … LEFT JOIN の保全側入れ替え（OUTER は向きを見る）
