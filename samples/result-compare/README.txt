SQL前後比較モード用の手動テスト用サンプル（アプリからは読み込みません）

使い方:
  1. アプリヘッダで「SQL前後比較」を選ぶ
  2. 各ケースの before.sql を SQL A、after.sql を SQL B に貼る
  3. 期待結果は各フォルダの expected.txt を参照

判定の見方（アプリ）:
  緑 … 構文上、結果に影響しうる差分なし
  黄 … 構文差分あり（並びのみ、または要確認ヒント付きリファクタ）
  赤 … 明確に結果が変わりうる構文差分

ケース一覧:
  --- 1. 構文同等 → 結果同じと推定（緑） ---
  01-alias-only             … エイリアス表記のみ変更
  02-join-order             … INNER JOIN の記述順入れ替え
  04-where-and-swap         … WHERE の AND 順序入れ替え
  08-join-reorder-refactor  … 4 表の結合順リファクタ
  10-comma-to-inner-join    … カンマ結合 → 明示 INNER JOIN

  --- 並び順のみ（黄 / order-only） ---
  03-order-by-only          … ORDER BY のみ変更

  --- 2. 構文差分あり・意味は同等になりやすい（黄 / 要確認ヒント） ---
  07-subquery-to-join       … 相関 EXISTS → JOIN + DISTINCT
  09-where-to-on            … WHERE 絞り込みを ON へ移動（INNER）

  --- 3. 結果が変わる（赤） ---
  05-join-condition-bug          … JOIN 条件のミス
  06-select-column-add           … SELECT 列追加
  11-left-join-preserved-side    … LEFT JOIN の保全側入れ替え
