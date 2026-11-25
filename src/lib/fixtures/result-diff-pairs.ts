/**
 * SQL前後比較の反例集。比較の判定を変えたら、すべてのペアで期待どおりかを確かめる。
 *
 * 比較モードの緑の「同じ」は安全の根拠として読まれるので、
 * 結果が変わりうるペアを「同じ」と判定するのが最も高くつく誤りになる。
 * 見つけた反例は、どのファイルを直したときでもここに足す。
 *
 * expect の値の意味は次のとおり。
 * - different  結果が変わりうる。結果セットのサマリーを「同じ」にしてはいけない
 * - same       結果は変わらない。どのカテゴリにも差分を出さない
 * - proven     結果は変わらない。カテゴリには差分が出てよいが、等価性の証明でサマリーを「同じ」にする
 * - order-only 返る行は変わらず、並び順だけが変わりうる
 */
export type ResultDiffExpectation = 'different' | 'same' | 'proven' | 'order-only';

export interface ResultDiffPair {
  name: string;
  a: string;
  b: string;
  expect: ResultDiffExpectation;
}

const LEFT = 'SELECT a.id FROM a LEFT JOIN o ON a.id = o.aid';
const INNER = 'SELECT a.id FROM a INNER JOIN o ON a.id = o.aid';

const different = (name: string, a: string, b: string): ResultDiffPair => ({ name, a, b, expect: 'different' });
const same = (name: string, a: string, b: string): ResultDiffPair => ({ name, a, b, expect: 'same' });

export const RESULT_DIFF_PAIRS: ResultDiffPair[] = [
  // --- リテラルと式 ---
  different('文字列リテラルの大文字小文字', "SELECT 'A' AS x FROM t", "SELECT 'a' AS x FROM t"),
  different(
    '文字列リテラルの中の空白',
    "SELECT t.id FROM t WHERE t.n = 'a  b'",
    "SELECT t.id FROM t WHERE t.n = 'a b'",
  ),
  different(
    'COLLATE',
    'SELECT t.id FROM t WHERE t.n = t.m COLLATE utf8mb4_bin',
    'SELECT t.id FROM t WHERE t.n = t.m COLLATE utf8mb4_general_ci',
  ),
  different('CONVERT の USING', 'SELECT CONVERT(t.x USING utf8mb4) FROM t', 'SELECT CONVERT(t.x USING latin1) FROM t'),
  // パーサーは引用符の中身だけを値に入れるので、接頭辞を落とすと等価性の証明で同じ定数に見えていた
  different('2 進のリテラル b\'101\'（値は 5）', "SELECT t.id FROM t WHERE t.a = b'101'", 'SELECT t.id FROM t WHERE t.a = 101'),
  different('16 進のリテラル X\'41\'', "SELECT t.id FROM t WHERE t.a = X'41'", 'SELECT t.id FROM t WHERE t.a = 41'),
  different('16 進のリテラル 0x41', 'SELECT t.id FROM t WHERE t.a = 0x41', 'SELECT t.id FROM t WHERE t.a = 41'),
  // `&&` を比較として 1 つの条件にまとめていたので、AND と書いた SQL と別の条件に見えていた
  same('&& と AND', 'SELECT t.id FROM t WHERE t.a = 1 && t.b = 2', 'SELECT t.id FROM t WHERE t.b = 2 AND t.a = 1'),
  different('SUM の DISTINCT', 'SELECT SUM(DISTINCT t.a) FROM t', 'SELECT SUM(t.a) FROM t'),
  same('SUM の DISTINCT の引数の括弧', 'SELECT SUM(DISTINCT t.a) FROM t', 'SELECT SUM(DISTINCT (t.a)) FROM t'),
  different('文字セットの指定 _binary', "SELECT t.id FROM t WHERE t.a = _binary'a'", "SELECT t.id FROM t WHERE t.a = 'a'"),
  different(
    'ウィンドウ枠',
    'SELECT SUM(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    'SELECT SUM(x) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t',
  ),
  different(
    'WINDOW 句の定義',
    'SELECT SUM(x) OVER w FROM t WINDOW w AS (ORDER BY id)',
    'SELECT SUM(x) OVER w FROM t WINDOW w AS (ORDER BY id DESC)',
  ),
  different('PARTITION 句', 'SELECT t.x FROM t PARTITION (p0)', 'SELECT t.x FROM t PARTITION (p1)'),
  different('テーブル名の大文字小文字（Linux の MySQL では別のテーブル）', 'SELECT u.id FROM Users u', 'SELECT u.id FROM users u'),
  same('!= と <>', 'SELECT a.id FROM a WHERE a.x != 1', 'SELECT a.id FROM a WHERE a.x <> 1'),
  same(
    '演算子のあいだの空白',
    'SELECT a.id FROM a WHERE a.x<>-1 AND a.y*-2 > 0',
    'SELECT a.id FROM a WHERE a.x <> -1 AND a.y * -2 > 0',
  ),
  same('コメントの有無', 'SELECT a.id FROM a /* c */ WHERE a.x = 1 -- t', 'SELECT a.id FROM a WHERE a.x = 1'),
  same('SELECT 修飾子', 'SELECT SQL_NO_CACHE a.id FROM a', 'SELECT a.id FROM a'),
  same(
    'インデックスヒントの違い',
    'SELECT a.id FROM a USE INDEX (i1) WHERE a.x = 1',
    'SELECT a.id FROM a FORCE INDEX (i2) WHERE a.x = 1',
  ),
  same('ロック句の有無', 'SELECT a.id FROM a WHERE a.x = 1 FOR UPDATE', 'SELECT a.id FROM a WHERE a.x = 1'),

  // --- 式の中のサブクエリ ---
  different(
    'SELECT 列のスカラーサブクエリの中身',
    'SELECT (SELECT MAX(x) FROM t WHERE t.a = 1) AS m FROM u',
    'SELECT (SELECT MIN(x) FROM t WHERE t.a = 2) AS m FROM u',
  ),
  different(
    'スカラーサブクエリの中で値だけを入れ替える',
    'SELECT (SELECT MAX(t.x) FROM t WHERE t.a = 1 AND t.b = 2) AS m FROM u',
    'SELECT (SELECT MAX(t.x) FROM t WHERE t.a = 2 AND t.b = 1) AS m FROM u',
  ),
  different(
    'SELECT 列の 2 つのスカラーサブクエリの入れ替え',
    'SELECT (SELECT MAX(t.x) FROM t) AS p, (SELECT MIN(t.x) FROM t) AS q FROM u',
    'SELECT (SELECT MIN(t.x) FROM t) AS p, (SELECT MAX(t.x) FROM t) AS q FROM u',
  ),
  different(
    '関数の引数のサブクエリの中身',
    'SELECT u.id FROM u WHERE COALESCE((SELECT MAX(x) FROM t WHERE t.a = 1), 0) > 1',
    'SELECT u.id FROM u WHERE COALESCE((SELECT MAX(x) FROM t WHERE t.a = 2), 0) > 1',
  ),
  different(
    'UPDATE の SET 右辺のサブクエリの中身',
    'UPDATE u SET u.x = (SELECT MAX(x) FROM t WHERE t.a = 1)',
    'UPDATE u SET u.x = (SELECT MAX(x) FROM t WHERE t.a = 2)',
  ),
  different(
    'JOIN ON のスカラーサブクエリの中身',
    'SELECT a.id FROM a JOIN b ON b.v = (SELECT MAX(t.x) FROM t)',
    'SELECT a.id FROM a JOIN b ON b.v = (SELECT MIN(t.x) FROM t)',
  ),
  same(
    '同じスカラーサブクエリを持つクエリの AND 並べ替え',
    'SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.uid = u.id) AS c FROM users u WHERE u.x = 1 AND u.y = 2',
    'SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.uid = u.id) AS c FROM users u WHERE u.y = 2 AND u.x = 1',
  ),

  // --- 入れ子のクエリ・UNION・CTE ---
  different(
    '派生テーブルの 2 本目の UNION ブランチ',
    'SELECT d.x FROM (SELECT t.x FROM t UNION ALL SELECT u.x FROM u) d',
    'SELECT d.x FROM (SELECT t.x FROM t UNION ALL SELECT v.x FROM v) d',
  ),
  different(
    'CTE 本体の 2 本目の UNION ブランチ',
    'WITH c AS (SELECT t.x FROM t UNION ALL SELECT u.x FROM u) SELECT c.x FROM c',
    'WITH c AS (SELECT t.x FROM t UNION ALL SELECT v.x FROM v) SELECT c.x FROM c',
  ),
  different(
    'IN サブクエリの 2 本目の UNION ブランチ',
    'SELECT a.id FROM a WHERE a.x IN (SELECT t.x FROM t UNION SELECT u.x FROM u)',
    'SELECT a.id FROM a WHERE a.x IN (SELECT t.x FROM t UNION SELECT v.x FROM v)',
  ),
  different(
    'CTE の列名リストの順序',
    'WITH c (p, q) AS (SELECT t.x, t.y FROM t) SELECT c.p FROM c',
    'WITH c (q, p) AS (SELECT t.x, t.y FROM t) SELECT c.p FROM c',
  ),
  different(
    '派生テーブルの LIMIT が返す行を決める ORDER BY',
    'SELECT d.x FROM (SELECT t.x FROM t ORDER BY t.x LIMIT 3) d',
    'SELECT d.x FROM (SELECT t.x FROM t ORDER BY t.x DESC LIMIT 3) d',
  ),
  different(
    'スカラーサブクエリの LIMIT が返す行を決める ORDER BY',
    'SELECT u.id FROM u WHERE u.x = (SELECT t.x FROM t ORDER BY t.y LIMIT 1)',
    'SELECT u.id FROM u WHERE u.x = (SELECT t.x FROM t ORDER BY t.y DESC LIMIT 1)',
  ),
  different(
    'UNION 全体の LIMIT',
    '(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 5',
    '(SELECT a FROM t) UNION (SELECT a FROM u) LIMIT 6',
  ),
  different(
    'UNION 全体の LIMIT が返す行を決める ORDER BY',
    'SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT 1',
    'SELECT a FROM t UNION SELECT a FROM u ORDER BY a DESC LIMIT 1',
  ),
  different(
    '両側を括弧で囲んだ UNION 全体の LIMIT',
    '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a LIMIT 2',
    '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a LIMIT 3',
  ),
  different(
    '両側を括弧で囲んだ UNION 全体の LIMIT が返す行を決める ORDER BY',
    '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a LIMIT 2',
    '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a DESC LIMIT 2',
  ),
  same(
    '同じ UNION を持つ派生テーブルの WHERE の並べ替え',
    'SELECT d.x FROM (SELECT t.x FROM t UNION ALL SELECT u.x FROM u) d WHERE d.x = 1 AND d.x < 5',
    'SELECT d.x FROM (SELECT t.x FROM t UNION ALL SELECT u.x FROM u) d WHERE d.x < 5 AND d.x = 1',
  ),

  // --- GROUP BY ---
  different('WITH ROLLUP の有無', 'SELECT a, COUNT(*) FROM t GROUP BY a WITH ROLLUP', 'SELECT a, COUNT(*) FROM t GROUP BY a'),
  different(
    'WITH ROLLUP の列順',
    'SELECT a, b, COUNT(*) FROM t GROUP BY a, b WITH ROLLUP',
    'SELECT a, b, COUNT(*) FROM t GROUP BY b, a WITH ROLLUP',
  ),
  same(
    'WITH ROLLUP の無い GROUP BY の並べ替え',
    'SELECT a.x, a.y, COUNT(*) FROM a GROUP BY a.x, a.y',
    'SELECT a.x, a.y, COUNT(*) FROM a GROUP BY a.y, a.x',
  ),

  // --- 出力列と UPDATE ---
  different(
    'SELECT * でテーブルの並びが違う（列の並びが変わる）',
    'SELECT * FROM a JOIN b ON a.id = b.id',
    'SELECT * FROM b JOIN a ON a.id = b.id',
  ),
  different(
    'SELECT * で USING と ON が違う（結合列が 1 つにまとまるか）',
    'SELECT * FROM a JOIN b USING (id)',
    'SELECT * FROM a JOIN b ON a.id = b.id',
  ),
  different(
    'SET の代入順（後ろの式が前の代入先を読む）',
    'UPDATE a SET a.x = a.x + 1, a.y = a.x',
    'UPDATE a SET a.y = a.x, a.x = a.x + 1',
  ),
  different(
    '複数テーブルの UPDATE で、同じ列名を別のテーブルに代入する SET の順序',
    'UPDATE a JOIN b ON a.id = b.id SET a.x = b.x, b.x = 1',
    'UPDATE a JOIN b ON a.id = b.id SET b.x = 1, a.x = b.x',
  ),
  same(
    '互いに読まない SET の並べ替え',
    'UPDATE a SET a.x = 1, a.y = 2 WHERE a.id = 3',
    'UPDATE a SET a.y = 2, a.x = 1 WHERE a.id = 3',
  ),

  // --- 等価性の証明（MySQL の `=` は推移律・反射律を満たさないことがある） ---
  different(
    '型が違うと推移律が成り立たない等式（推移律で導ける等式を足す）',
    'SELECT DISTINCT a.id FROM a JOIN b ON a.s = b.n JOIN c ON b.n = c.s',
    'SELECT DISTINCT a.id FROM a JOIN b ON a.s = b.n JOIN c ON b.n = c.s AND a.s = c.s',
  ),
  different(
    '自分自身との等式で結ぶ自己結合（id が NULL の行が消える）',
    'SELECT DISTINCT a.id FROM users a, users b WHERE a.id = b.id',
    'SELECT DISTINCT a.id FROM users a',
  ),
  different(
    'EXISTS の中の SELECT の列に書いた集約（行が無くても 1 行を返し、EXISTS が常に真になる）',
    'SELECT DISTINCT a.id FROM a WHERE EXISTS (SELECT 1 FROM o WHERE o.aid = a.id)',
    'SELECT DISTINCT a.id FROM a WHERE EXISTS (SELECT BIT_OR(o.x) FROM o WHERE o.aid = a.id)',
  ),
  { name: 'カンマ結合と CROSS JOIN', a: 'SELECT a.id FROM a, b', b: 'SELECT a.id FROM a CROSS JOIN b', expect: 'proven' },

  // --- 結合の組み立て ---
  same(
    'INNER JOIN の記述順の入れ替え',
    'SELECT a.id FROM a JOIN b ON b.aid = a.id JOIN c ON c.aid = a.id',
    'SELECT a.id FROM a JOIN c ON c.aid = a.id JOIN b ON b.aid = a.id',
  ),
  same(
    'INNER JOIN の ON 条件を別の ON へ移す',
    'SELECT a.id FROM a JOIN b ON b.aid = a.id AND b.k = 1 JOIN c ON c.bid = b.id',
    'SELECT a.id FROM a JOIN b ON b.aid = a.id JOIN c ON c.bid = b.id AND b.k = 1',
  ),
  same('列を明示した USING と ON', 'SELECT a.x FROM a JOIN b USING (id)', 'SELECT a.x FROM a JOIN b ON a.id = b.id'),
  same('LEFT と RIGHT の書き換え', LEFT, 'SELECT a.id FROM o RIGHT JOIN a ON a.id = o.aid'),
  same(
    'LEFT と RIGHT の書き換え（3 表）',
    'SELECT a.id FROM a JOIN x ON x.aid = a.id LEFT JOIN b ON b.xid = x.id',
    'SELECT a.id FROM b RIGHT JOIN x ON b.xid = x.id JOIN a ON x.aid = a.id',
  ),
  same(
    'LEFT JOIN を、行を残す側の内部結合より前に書く',
    'SELECT a.id FROM a JOIN x ON x.aid = a.id LEFT JOIN b ON b.xid = x.id',
    'SELECT a.id FROM x LEFT JOIN b ON b.xid = x.id JOIN a ON x.aid = a.id',
  ),
  same(
    '互いに参照しない LEFT JOIN の入れ替え',
    'SELECT a.id FROM a LEFT JOIN b ON b.aid = a.id LEFT JOIN c ON c.aid = a.id',
    'SELECT a.id FROM a LEFT JOIN c ON c.aid = a.id LEFT JOIN b ON b.aid = a.id',
  ),
  different(
    'LEFT JOIN で行を残す側の入れ替え',
    'SELECT a.id FROM a LEFT JOIN b ON b.aid = a.id',
    'SELECT a.id FROM b LEFT JOIN a ON b.aid = a.id',
  ),
  different(
    '自己結合の LEFT JOIN で行を残す側が逆',
    'SELECT u1.id FROM users u1 LEFT JOIN users u2 ON u1.mgr = u2.id',
    'SELECT u1.id FROM users u2 LEFT JOIN users u1 ON u1.mgr = u2.id',
  ),
  different(
    'RIGHT JOIN で行を残すのは右のテーブル、NULL で埋まるのは左の結合全体',
    'SELECT b.id FROM a JOIN x ON (a.id = x.aid OR a.k = 1) RIGHT JOIN b ON b.xid = x.id',
    'SELECT b.id FROM b LEFT JOIN x ON b.xid = x.id JOIN a ON (a.id = x.aid OR a.k = 1)',
  ),
  different(
    'RIGHT JOIN を LEFT JOIN + 後続の内部結合に書き換える（後続の内部結合で実質 INNER になる）',
    'SELECT b.id FROM a JOIN x ON x.aid = a.id RIGHT JOIN b ON b.xid = x.id',
    'SELECT b.id FROM b LEFT JOIN x ON b.xid = x.id JOIN a ON x.aid = a.id',
  ),
  different(
    'LEFT JOIN のあとの内部結合（未結合行を通す ON）を前に移す',
    'SELECT a.id FROM a LEFT JOIN b ON b.aid = a.id JOIN c ON (c.bid = b.id OR c.k = a.k)',
    'SELECT a.id FROM a JOIN c ON (c.k = a.k) LEFT JOIN b ON b.aid = a.id',
  ),

  // --- LEFT JOIN と実質 INNER（WHERE / ON が未結合行を通すなら INNER と同じにはならない） ---
  same('実質 INNER: 比較', `${LEFT} WHERE o.x = 1`, `${INNER} WHERE o.x = 1`),
  same('実質 INNER: IS NOT NULL', `${LEFT} WHERE o.id IS NOT NULL`, `${INNER} WHERE o.id IS NOT NULL`),
  same('実質 INNER: NOT (比較)', `${LEFT} WHERE NOT (o.x = 1)`, `${INNER} WHERE NOT (o.x = 1)`),
  same('実質 INNER: IN リスト', `${LEFT} WHERE o.x IN (1, 2)`, `${INNER} WHERE o.x IN (1, 2)`),
  same(
    '実質 INNER: INTERVAL を含む日付計算',
    `${LEFT} WHERE o.d < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    `${INNER} WHERE o.d < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
  ),
  same('実質 INNER: 後続の INNER JOIN', `${LEFT} JOIN p ON p.id = o.pid`, `${INNER} JOIN p ON p.id = o.pid`),
  same(
    '実質 INNER: 外部結合の連鎖（c の絞り込みが b にも及ぶ）',
    'SELECT a.id FROM a LEFT JOIN b ON b.aid = a.id LEFT JOIN c ON c.bid = b.id WHERE c.x = 1',
    'SELECT a.id FROM a JOIN b ON b.aid = a.id JOIN c ON c.bid = b.id WHERE c.x = 1',
  ),
  different('NOT (… AND …)', `${LEFT} WHERE NOT (o.x = 1 AND a.y = 2)`, `${INNER} WHERE NOT (o.x = 1 AND a.y = 2)`),
  different('ISNULL()', `${LEFT} WHERE ISNULL(o.x)`, `${INNER} WHERE ISNULL(o.x)`),
  different(
    'CASE WHEN … IS NULL',
    `${LEFT} WHERE CASE WHEN o.x IS NULL THEN 1 ELSE 0 END = 1`,
    `${INNER} WHERE CASE WHEN o.x IS NULL THEN 1 ELSE 0 END = 1`,
  ),
  different('IF(… IS NULL)', `${LEFT} WHERE IF(o.x IS NULL, 1, 0) = 1`, `${INNER} WHERE IF(o.x IS NULL, 1, 0) = 1`),
  // NULL を受け取っても NULL 以外を返す関数。NULL を返さない関数の一覧で除いていたので、一覧に無い関数を根拠にしていた
  different('QUOTE()（NULL を文字列の NULL にする）', `${LEFT} WHERE QUOTE(o.x) = 'NULL'`, `${INNER} WHERE QUOTE(o.x) = 'NULL'`),
  different('COERCIBILITY()', `${LEFT} WHERE COERCIBILITY(o.x) = 6`, `${INNER} WHERE COERCIBILITY(o.x) = 6`),
  different('DEFAULT()（列の既定値）', `${LEFT} WHERE DEFAULT(o.x) = 1`, `${INNER} WHERE DEFAULT(o.x) = 1`),
  different('利用者が作った関数', `${LEFT} WHERE my_func(o.x) = 1`, `${INNER} WHERE my_func(o.x) = 1`),
  different('スキーマ付きの関数（組み込みの関数と同じ名前）', `${LEFT} WHERE db.upper(o.x) = 'A'`, `${INNER} WHERE db.upper(o.x) = 'A'`),
  different('名前に日本語を含む関数', `${LEFT} WHERE 日F(o.x) = 1`, `${INNER} WHERE 日F(o.x) = 1`),
  same('実質 INNER: NULL を伝える関数', `${LEFT} WHERE UPPER(TRIM(o.x)) = 'A'`, `${INNER} WHERE UPPER(TRIM(o.x)) = 'A'`),
  same('実質 INNER: 関数の引数の外の参照', `${LEFT} WHERE my_func(a.y) = o.x`, `${INNER} WHERE my_func(a.y) = o.x`),
  different('IN リスト側の参照', `${LEFT} WHERE a.x IN (o.y, 1)`, `${INNER} WHERE a.x IN (o.y, 1)`),
  different('IS NOT TRUE', `${LEFT} WHERE (o.x = 1) IS NOT TRUE`, `${INNER} WHERE (o.x = 1) IS NOT TRUE`),
  different('NOT (… IS NOT NULL)', `${LEFT} WHERE NOT (o.id IS NOT NULL)`, `${INNER} WHERE NOT (o.id IS NOT NULL)`),
  different('NOT IN サブクエリ', `${LEFT} WHERE o.k NOT IN (SELECT x.k FROM x)`, `${INNER} WHERE o.k NOT IN (SELECT x.k FROM x)`),
  // サブクエリが 0 行なら、`NULL <> ALL (…)` は真、`NULL = ANY (…)` は偽になる。右辺が ALL のサブクエリかを見ずに、実質 INNER の根拠にしていた
  different('<> ALL サブクエリ', `${LEFT} WHERE o.k <> ALL (SELECT x.k FROM x)`, `${INNER} WHERE o.k <> ALL (SELECT x.k FROM x)`),
  different('> ALL サブクエリ', `${LEFT} WHERE o.k > ALL (SELECT x.k FROM x)`, `${INNER} WHERE o.k > ALL (SELECT x.k FROM x)`),
  different(
    'NOT (= ANY サブクエリ)',
    `${LEFT} WHERE NOT (o.k = ANY (SELECT x.k FROM x))`,
    `${INNER} WHERE NOT (o.k = ANY (SELECT x.k FROM x))`,
  ),
  same('実質 INNER: = ANY サブクエリ', `${LEFT} WHERE o.k = ANY (SELECT x.k FROM x)`, `${INNER} WHERE o.k = ANY (SELECT x.k FROM x)`),
  same('実質 INNER: NOT (IS NULL)', `${LEFT} WHERE NOT (o.id IS NULL)`, `${INNER} WHERE NOT (o.id IS NULL)`),
  same('実質 INNER: IS TRUE', `${LEFT} WHERE (o.x = 1) IS TRUE`, `${INNER} WHERE (o.x = 1) IS TRUE`),
  different('HAVING COUNT = 0', `${LEFT} GROUP BY a.id HAVING COUNT(o.id) = 0`, `${INNER} GROUP BY a.id HAVING COUNT(o.id) = 0`),
  different(
    '後続 INNER JOIN の ON が OR',
    `${LEFT} JOIN p ON p.id = o.pid OR p.aid = a.id`,
    `${INNER} JOIN p ON p.id = o.pid OR p.aid = a.id`,
  ),
  different(
    '後続 INNER JOIN の ON が COALESCE',
    `${LEFT} JOIN p ON p.id = COALESCE(o.pid, a.pid)`,
    `${INNER} JOIN p ON p.id = COALESCE(o.pid, a.pid)`,
  ),
  different(
    '後続 INNER JOIN の ON が IS NULL',
    `${LEFT} JOIN p ON p.aid = a.id AND o.id IS NULL`,
    `${INNER} JOIN p ON p.aid = a.id AND o.id IS NULL`,
  ),

  // --- 並び順 ---
  { name: 'ORDER BY の有無', a: 'SELECT a.id FROM a', b: 'SELECT a.id FROM a ORDER BY a.x   DESC', expect: 'order-only' },
  {
    name: 'ORDER BY の式と向き',
    a: 'SELECT a.id FROM a ORDER BY a.x\n  DESC, a.y',
    b: 'SELECT a.id FROM a ORDER BY a.y ASC',
    expect: 'order-only',
  },
  {
    name: '括弧で始まる ORDER BY の式',
    a: 'SELECT a.id FROM a ORDER BY (a.x + 1), a.y DESC',
    b: 'SELECT a.id FROM a',
    expect: 'order-only',
  },
  {
    name: 'UNION 全体の ORDER BY',
    a: 'SELECT a FROM t UNION SELECT a FROM u ORDER BY a',
    b: 'SELECT a FROM t UNION SELECT a FROM u ORDER BY a DESC',
    expect: 'order-only',
  },
  {
    name: '両側を括弧で囲んだ UNION 全体の ORDER BY',
    a: '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a',
    b: '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a DESC',
    expect: 'order-only',
  },
  // 括弧の無い最後のブランチの LIMIT は UNION 全体に掛かる。最後のブランチの LIMIT としても数えていた
  same(
    'UNION 全体の LIMIT（括弧の有無）',
    'SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT 3',
    '(SELECT a FROM t) UNION (SELECT a FROM u) ORDER BY a LIMIT 3',
  ),
  different(
    'UNION 全体の LIMIT と最後のブランチだけの LIMIT',
    'SELECT a FROM t UNION SELECT a FROM u ORDER BY a LIMIT 3',
    '(SELECT a FROM t) UNION (SELECT a FROM u ORDER BY a LIMIT 3)',
  ),
  // --- 前処理で書き換える構文（書き換えの前後で同じ結果になる） ---
  same(
    '複数テーブルの DELETE の USING の形と FROM の形',
    'DELETE FROM t1 USING t1 JOIN t2 ON t1.id = t2.id WHERE t2.x = 1',
    'DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id WHERE t2.x = 1',
  ),
  same(
    'DELETE の対象の .* の有無',
    'DELETE t1.*, t2.* FROM t1 JOIN t2 ON t1.id = t2.id',
    'DELETE t1, t2 FROM t1 JOIN t2 ON t1.id = t2.id',
  ),
  different(
    '複数テーブルの DELETE で、削除する対象が違う',
    'DELETE FROM t1 USING t1 JOIN t2 ON t1.id = t2.id',
    'DELETE FROM t2 USING t1 JOIN t2 ON t1.id = t2.id',
  ),
  same(
    '日本語の識別子を引用符で囲むかどうか',
    'SELECT ユーザー.名前 FROM ユーザー WHERE ユーザー.状態 = 1',
    'SELECT `ユーザー`.`名前` FROM `ユーザー` WHERE `ユーザー`.`状態` = 1',
  ),
  // --- UNION DISTINCT（UNION と同じ意味。MySQL 8.4 リファレンス 15.2.18） ---
  same('UNION DISTINCT と UNION', 'SELECT a.x FROM a UNION DISTINCT SELECT b.x FROM b', 'SELECT a.x FROM a UNION SELECT b.x FROM b'),
  different('UNION DISTINCT と UNION ALL', 'SELECT a.x FROM a UNION DISTINCT SELECT b.x FROM b', 'SELECT a.x FROM a UNION ALL SELECT b.x FROM b'),
  // --- スキーマ付きの関数（パーサーがスキーマを名前と別に持つので、表示で落としていた） ---
  different('スキーマだけが違う関数', 'SELECT db1.f(a.x) AS v FROM a', 'SELECT db2.f(a.x) AS v FROM a'),
  different('スキーマの有無だけが違う関数', 'SELECT a.id FROM a WHERE db1.f(a.x) = 1', 'SELECT a.id FROM a WHERE f(a.x) = 1'),
  // Unix の MySQL では、データベース名の大文字小文字を区別する（テーブル名と同じ）
  different('スキーマの大文字小文字だけが違う関数', 'SELECT db1.f(a.x) AS v FROM a', 'SELECT DB1.f(a.x) AS v FROM a'),
  same('関数名の大文字小文字だけが違う関数', 'SELECT db1.f(a.x) AS v FROM a', 'SELECT db1.F(a.x) AS v FROM a'),

  // --- || と OR（MySQL の既定では同じ意味。括弧の無い || は解析のエラーにしている） ---
  same('括弧で囲んだ比較を結ぶ || と OR', 'SELECT a.id FROM a WHERE (a.x = 1) || (a.y = 2)', 'SELECT a.id FROM a WHERE (a.x = 1) OR (a.y = 2)'),
  different('|| の片側だけが外部結合の列なら実質 INNER にしない', `${LEFT} WHERE (a.x = 1) || (o.b = 2)`, `${INNER} WHERE (a.x = 1) || (o.b = 2)`),

  // --- AND と OR の優先順位（SQL パーサーが同じ優先順位で結び付けていた） ---
  different(
    'AND は OR より先に結び付く',
    'SELECT t.a FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3',
    'SELECT t.a FROM t WHERE (t.a = 1 OR t.b = 2) AND t.c = 3',
  ),
  same(
    'AND の側を括弧で囲んでも同じ',
    'SELECT t.a FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3',
    'SELECT t.a FROM t WHERE t.a = 1 OR (t.b = 2 AND t.c = 3)',
  ),
  different(
    'ON の中の AND と OR の優先順位',
    'SELECT t.a FROM t JOIN u ON u.id = t.id OR u.k = 1 AND u.j = 2',
    'SELECT t.a FROM t JOIN u ON (u.id = t.id OR u.k = 1) AND u.j = 2',
  ),
];
