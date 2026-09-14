import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { buildQueryEffect } from './query-effect';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { collectAllNestedQueries } from './query-utils';
import { applyAliasResolution } from './alias-resolver';
import { buildJoinFlowLayout } from './join-flow-layout';
import { compareQueryResults } from './query-result-diff';
import type { ConditionNode, ParsedQuery, SourceSpan } from './types';

interface Case {
  name: string;
  sql: string;
  /** 期待値（分かる範囲で明示し、構造の取りこぼしを検出する） */
  want?: { tables?: number; joins?: number; nested?: number; branches?: number; ctes?: number };
}

const CASES: Case[] = [];
const add = (c: Case) => CASES.push(c);

// ---------------------------------------------------------------------------
// 1. 多段 JOIN + 深いサブクエリ
// ---------------------------------------------------------------------------
add({
  name: '10 テーブル多段 JOIN + 派生テーブル 2 つ',
  want: { tables: 10, joins: 9 },
  sql: `SELECT u.id, o.order_no, p.product_name, c.category_name, w.warehouse_name,
       s.qty, pay.paid_at, cp.coupon_cd, hot.order_cnt, rk.rnk
FROM users u
INNER JOIN orders o          ON o.user_id = u.id
LEFT  JOIN order_items oi    ON oi.order_id = o.id
INNER JOIN products p        ON p.id = oi.product_id
LEFT  JOIN categories c      ON c.id = p.category_id
LEFT  JOIN stocks s          ON s.product_id = p.id AND s.warehouse_id = 1
LEFT  JOIN warehouses w      ON w.id = s.warehouse_id
LEFT  JOIN payments pay      ON pay.order_id = o.id AND pay.status = 'paid'
INNER JOIN (SELECT user_id, COUNT(*) order_cnt FROM orders GROUP BY user_id HAVING COUNT(*) >= 3) hot
       ON hot.user_id = u.id
LEFT  JOIN (SELECT id AS order_id, RANK() OVER (PARTITION BY user_id ORDER BY total DESC) rnk, coupon_cd
              FROM orders) rk
       ON rk.order_id = o.id
WHERE u.status = 'active'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC`,
});

add({
  name: '4 段ネストした相関サブクエリ',
  want: { nested: 4 },
  sql: `SELECT e.id, e.name
FROM employees e
WHERE EXISTS (
  SELECT 1 FROM orders o
  WHERE o.emp_id = e.id
    AND o.total > (
      SELECT AVG(o2.total) FROM orders o2
      WHERE o2.dept_id = e.dept_id
        AND o2.product_id IN (
          SELECT p.id FROM products p
          WHERE p.category_id IN (
            SELECT c.id FROM categories c WHERE c.active = 1
          )
        )
    )
)`,
});

add({
  name: 'FROM 句に 3 段ネストした派生テーブル',
  sql: `SELECT lvl1.* FROM (
  SELECT lvl2.dept_id, SUM(lvl2.sal) total FROM (
    SELECT lvl3.dept_id, lvl3.sal FROM (
      SELECT dept_id, sal FROM employees WHERE retired = 0
    ) lvl3 WHERE lvl3.sal > 1000
  ) lvl2 GROUP BY lvl2.dept_id
) lvl1 WHERE lvl1.total > 10000`,
});

// ---------------------------------------------------------------------------
// 2. WITH 句（MySQL 8）
// ---------------------------------------------------------------------------
add({
  name: '3 つの CTE が連鎖参照する',
  want: { ctes: 3 },
  sql: `WITH base AS (
  SELECT o.id AS order_id, o.user_id, o.total, o.created_at
  FROM orders o WHERE o.status = 'completed'
), per_user AS (
  SELECT b.user_id, COUNT(*) cnt, SUM(b.total) amt FROM base b GROUP BY b.user_id
), ranked AS (
  SELECT p.user_id, p.cnt, p.amt, RANK() OVER (ORDER BY p.amt DESC) rnk FROM per_user p
)
SELECT u.name, r.cnt, r.amt, r.rnk
FROM ranked r
INNER JOIN users u ON u.id = r.user_id
WHERE r.rnk <= 100
ORDER BY r.rnk`,
});

add({
  name: 'CTE + UNION ALL + 各ブランチに JOIN',
  want: { branches: 3 },
  sql: `WITH target_users AS (SELECT id FROM users WHERE status = 'active')
SELECT 'order' AS kind, o.id AS id, u.name
  FROM orders o INNER JOIN users u ON u.id = o.user_id
 WHERE o.user_id IN (SELECT id FROM target_users)
UNION ALL
SELECT 'return', r.id, u.name
  FROM returns r INNER JOIN users u ON u.id = r.user_id
 WHERE EXISTS (SELECT 1 FROM target_users t WHERE t.id = r.user_id)
UNION ALL
SELECT 'inquiry', q.id, u.name
  FROM inquiries q LEFT JOIN users u ON u.id = q.user_id
 WHERE q.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
ORDER BY 1, 2`,
});

// ---------------------------------------------------------------------------
// 3. MySQL 固有の JOIN / ヒント / 修飾子
// ---------------------------------------------------------------------------
add({
  name: 'STRAIGHT_JOIN + 索引ヒント + PARTITION 指定',
  want: { tables: 3, joins: 2 },
  sql: `SELECT STRAIGHT_JOIN SQL_NO_CACHE u.id, o.order_no, p.product_name
FROM users u USE INDEX (idx_status)
STRAIGHT_JOIN orders o FORCE INDEX (idx_user) ON o.user_id = u.id
INNER JOIN products p IGNORE INDEX (idx_cat) ON p.id = o.product_id
WHERE u.status = 'active'`,
});

add({
  name: 'NATURAL JOIN と USING の混在',
  want: { tables: 3, joins: 2 },
  sql: `SELECT * FROM users NATURAL JOIN profiles JOIN orders USING (user_id) WHERE orders.total > 0`,
});

add({
  name: 'カンマ結合 5 テーブル（旧式）',
  want: { tables: 5 },
  sql: `SELECT e.id, d.name, m.name manager, b.bonus, g.grade_name
FROM employees e, departments d, employees m, bonuses b, grades g
WHERE e.dept_id = d.id
  AND e.manager_id = m.id
  AND e.id = b.emp_id
  AND e.grade_cd = g.grade_cd
  AND d.location IN ('tokyo','osaka')
  AND (e.sal > 3000 OR e.job = 'manager')
ORDER BY d.name, e.id`,
});

// ---------------------------------------------------------------------------
// 4. 巨大・深い WHERE 条件
// ---------------------------------------------------------------------------
add({
  name: '7 段ネストした AND/OR/NOT',
  sql: `SELECT id FROM t
WHERE (
  a = 1
  AND (
    b = 2
    OR (
      c = 3
      AND NOT (
        d = 4
        OR (
          e = 5
          AND (f BETWEEN 1 AND 10 OR g IN (1,2,3))
        )
      )
    )
  )
)
AND NOT (h IS NULL OR i NOT IN (SELECT j FROM u WHERE u.k = t.k))
AND (l LIKE 'x%' ESCAPE '!' OR m NOT LIKE '%y')`,
});

add({
  name: '大量の IN リスト（200 要素）',
  sql: `SELECT id FROM t WHERE cd IN (${Array.from({ length: 200 }, (_, i) => i + 1).join(', ')})`,
});

add({
  name: '30 個の AND 条件',
  sql: `SELECT id FROM t WHERE ${Array.from({ length: 30 }, (_, i) => `c${i} = ${i}`).join(' AND ')}`,
});

// ---------------------------------------------------------------------------
// 5. 分析関数・集約の入れ子（MySQL 8）
// ---------------------------------------------------------------------------
add({
  name: 'CASE を含む集約 + 分析関数 + 副問合せ',
  sql: `SELECT d.id,
       SUM(CASE WHEN e.job = 'clerk' THEN e.sal ELSE 0 END) clerk_sal,
       ROUND(AVG(CASE WHEN e.hired_at > DATE_SUB(NOW(), INTERVAL 365 DAY) THEN e.sal END), 2) new_avg,
       RANK() OVER (ORDER BY SUM(e.sal) DESC) dept_rank,
       (SELECT COUNT(*) FROM employees x WHERE x.dept_id = d.id) emp_cnt
FROM departments d
INNER JOIN employees e ON e.dept_id = d.id
WHERE d.active = 1
GROUP BY d.id
HAVING SUM(e.sal) > (SELECT AVG(sal) * 10 FROM employees)
ORDER BY dept_rank`,
});

add({
  name: '分析関数の入れ子（派生テーブル 2 段 + LIMIT）',
  sql: `SELECT * FROM (
  SELECT inner1.*, ROW_NUMBER() OVER (PARTITION BY inner1.dept_id ORDER BY inner1.total DESC) rn
  FROM (
    SELECT e.dept_id, e.id AS emp_id, SUM(o.total) OVER (PARTITION BY e.id) total
    FROM employees e LEFT JOIN orders o ON o.emp_id = e.id
  ) inner1
) x WHERE x.rn <= 3
ORDER BY dept_id, rn
LIMIT 50`,
});

add({
  name: 'GROUP_CONCAT + JSON 演算子',
  sql: `SELECT u.id, GROUP_CONCAT(o.order_no ORDER BY o.created_at SEPARATOR ',') orders,
       u.profile->'$.age' AS age, u.profile->>'$.name' AS nm
FROM users u LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id`,
});

// ---------------------------------------------------------------------------
// 6. UPDATE / DELETE の複雑形（MySQL の複数テーブル操作）
// ---------------------------------------------------------------------------
add({
  name: 'UPDATE: 3 テーブル JOIN + 複数 SET + ORDER/LIMIT',
  want: { tables: 3, joins: 2 },
  sql: `UPDATE LOW_PRIORITY IGNORE users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
SET u.status = 'inactive', u.updated_at = NOW(), o.closed = 1, oi.shipped = 1
WHERE u.last_login_at < '2023-01-01'
  AND (o.status IN ('pending','hold') OR u.email LIKE '%@deprecated.example')
ORDER BY o.updated_at DESC
LIMIT 500`,
});

add({
  name: 'UPDATE: SET の値が相関サブクエリ',
  sql: `UPDATE employees e
SET e.dept_id = (SELECT d.id FROM departments d WHERE d.code = e.dept_code),
    e.updated_at = NOW()
WHERE EXISTS (SELECT 1 FROM departments d WHERE d.code = e.dept_code)
  AND e.retired = 0`,
});

add({
  name: 'DELETE: 複数テーブル + 相関 EXISTS + NOT IN',
  want: { tables: 3, joins: 2 },
  sql: `DELETE u, oi FROM users u
INNER JOIN orders o ON o.user_id = u.id
INNER JOIN order_items oi ON oi.order_id = o.id
WHERE u.status = 'deleted'
  AND EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id AND a.action = 'purge')
  AND o.id NOT IN (SELECT s.order_id FROM shipments s WHERE s.shipped_at IS NOT NULL)
ORDER BY o.created_at ASC
LIMIT 1000`,
});

// ---------------------------------------------------------------------------
// 7. 集合演算 / 極端な形
// ---------------------------------------------------------------------------
add({
  name: 'UNION ALL 4 ブランチ（各ブランチに JOIN と副問合せ）',
  want: { branches: 4 },
  sql: `SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE o.total > (SELECT AVG(total) FROM orders)
UNION ALL
SELECT u.id FROM users u INNER JOIN returns r ON r.user_id = u.id
UNION ALL
SELECT g.id FROM guest_users g WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = g.id)
UNION
SELECT a.id FROM archived_users a
ORDER BY 1`,
});

add({
  name: '20 テーブル連鎖 JOIN',
  want: { tables: 20, joins: 19 },
  sql: `SELECT t0.id FROM t0 ${Array.from(
    { length: 19 },
    (_, i) => `INNER JOIN t${i + 1} ON t${i + 1}.id = t${i}.id`,
  ).join(' ')} WHERE t0.flg = 1`,
});

add({
  name: '選択列 100 個',
  sql: `SELECT ${Array.from({ length: 100 }, (_, i) => `c${i}`).join(', ')} FROM t`,
});

add({
  name: 'スカラー副問合せを 5 個並べた SELECT リスト',
  sql: `SELECT d.id,
  (SELECT COUNT(*) FROM employees e WHERE e.dept_id = d.id) c1,
  (SELECT MAX(sal) FROM employees e WHERE e.dept_id = d.id) c2,
  (SELECT MIN(sal) FROM employees e WHERE e.dept_id = d.id) c3,
  (SELECT AVG(sal) FROM employees e WHERE e.dept_id = d.id) c4,
  (SELECT SUM(sal) FROM employees e WHERE e.dept_id = d.id) c5
FROM departments d`,
});

add({
  name: 'バッククォート識別子 + ヒント + 文字列エスケープの全部入り',
  sql: "SELECT STRAIGHT_JOIN `u`.`id`, `d`.`dept name`, IFNULL(`b`.`bonus`, 0) bonus\n" +
    "FROM `my db`.`Employee Master` `u` USE INDEX (`idx_emp`)\n" +
    "STRAIGHT_JOIN `departments` `d` ON `d`.`id` = `u`.`dept_id`\n" +
    "LEFT JOIN `bonuses` `b` ON `b`.`emp_id` = `u`.`id`\n" +
    "WHERE `u`.`note` != 'it\\'s fine' AND `u`.`name` LIKE '%O''Brien%'\n" +
    "ORDER BY `d`.`dept name` DESC\n" +
    'LIMIT 10, 20',
});

// ---------------------------------------------------------------------------
// 8. 作りは悪いが MySQL では動く SQL
// ---------------------------------------------------------------------------
add({
  name: '悪い: 整形なし・1 行詰め込み・大文字小文字バラバラ',
  sql: `select U.ID,u.name,D.dept_name,ifnull(B.BONUS,0) from USERS U,departments d,BONUSES b where U.DEPT_ID=d.ID and u.ID=B.user_id and U.STATUS='active' and D.ACTIVE=1 order by 1,2`,
});

add({
  name: '悪い: WHERE 1=1 とぶら下げ AND',
  sql: `SELECT *
  FROM users u
 WHERE 1 = 1
   AND 1 = 1
   AND u.dept_id = 10
   AND ('X' = 'X')
   AND u.sal > 0`,
});

add({
  name: '悪い: 無意味な括弧の多重ネスト',
  sql: `SELECT ((((a)))) AS a, (((b + c))) AS bc
  FROM t
 WHERE ((((((status = 1)))))) AND (((type = 2) AND ((flg = 3))))`,
});

add({
  name: '悪い: エイリアスを付けず全部テーブル名で修飾',
  sql: `SELECT users.id, users.name, departments.dept_name
  FROM users, departments
 WHERE users.dept_id = departments.id
   AND users.sal > (SELECT AVG(users.sal) FROM users)`,
});

add({
  name: '悪い: IN の代わりに OR を 12 個並べる',
  sql: `SELECT id FROM t
 WHERE cd = '01' OR cd = '02' OR cd = '03' OR cd = '04' OR cd = '05' OR cd = '06'
    OR cd = '07' OR cd = '08' OR cd = '09' OR cd = '10' OR cd = '11' OR cd = '12'`,
});

add({
  name: '悪い: 同じスカラー副問合せを 4 回書く',
  sql: `SELECT d.id,
       (SELECT COUNT(*) FROM users u WHERE u.dept_id = d.id) cnt,
       (SELECT COUNT(*) FROM users u WHERE u.dept_id = d.id) / 2 half,
       CASE WHEN (SELECT COUNT(*) FROM users u WHERE u.dept_id = d.id) > 10 THEN 'big' ELSE 'small' END sz
  FROM departments d
 WHERE (SELECT COUNT(*) FROM users u WHERE u.dept_id = d.id) > 0`,
});

add({
  name: '悪い: 結合条件の欠落で直積になる',
  want: { tables: 3 },
  sql: `SELECT u.id, d.dept_name, g.grade_name
  FROM users u, departments d, grades g
 WHERE u.dept_id = d.id
   AND u.sal > 1000`,
});

add({
  name: '悪い: 索引が効かない関数付き結合条件',
  sql: `SELECT a.id
  FROM t_a a, t_b b
 WHERE IFNULL(a.key_cd, '0') = IFNULL(b.key_cd, '0')
   AND DATE_FORMAT(a.created_at, '%Y%m%d') = DATE_FORMAT(b.created_at, '%Y%m%d')
   AND UPPER(TRIM(a.name)) = UPPER(TRIM(b.name))`,
});

add({
  name: '悪い: 暗黙の型変換（数値列に文字列リテラル）',
  sql: `SELECT * FROM users WHERE id = '1001' AND dept_id = '10' AND created_at > '2020-01-01'`,
});

add({
  name: '悪い: 意味のない DISTINCT と GROUP BY の併用',
  sql: `SELECT DISTINCT u.dept_id, COUNT(*) cnt
  FROM users u
 GROUP BY u.dept_id
 ORDER BY 2 DESC, 1 ASC`,
});

add({
  name: '悪い: 3 重ネストの無駄な派生テーブル',
  sql: `SELECT x.id FROM (
  SELECT y.id FROM (
    SELECT z.id FROM (
      SELECT id FROM users
    ) z
  ) y
) x
WHERE x.id IN (SELECT id FROM (SELECT id FROM users WHERE sal > 1000) w)`,
});

add({
  name: '悪い: UNION（重複排除が不要な場面）を 5 ブランチ',
  want: { branches: 5 },
  sql: `SELECT id, '1' kind FROM t1
UNION
SELECT id, '2' FROM t2
UNION
SELECT id, '3' FROM t3
UNION
SELECT id, '4' FROM t4
UNION
SELECT id, '5' FROM t5`,
});

add({
  name: '悪い: コメントと空行だらけ・末尾セミコロン・# コメント',
  sql: `-- ユーザー一覧
# 作成: 2010/04/01
-- 修正: 2015/07/20  ★ 条件追加

SELECT   /* ユーザーID */ u.id

       , u.name   -- 氏名

  FROM   users  u   # ユーザーマスタ

 WHERE   u.retired = 0   -- 0:在職 1:退職

   AND   u.dept_id = 10   -- 営業部

 ORDER BY u.id;`,
});

add({
  name: '悪い: 予約語っぽい別名・重複する列別名',
  sql: 'SELECT u.id AS `NO`, u.name AS name, d.dept_name AS name2, u.sal AS `VALUE`\n' +
    '  FROM users u JOIN departments d ON d.id = u.dept_id',
});

add({
  name: '悪い: HAVING だけで GROUP BY なし',
  sql: `SELECT COUNT(*) FROM users HAVING COUNT(*) > 0`,
});

add({
  name: '悪い: ORDER BY に列番号と式を混在',
  sql: `SELECT dept_id, SUM(sal) s, COUNT(*) c FROM users GROUP BY dept_id ORDER BY 2 DESC, COUNT(*) ASC, 1`,
});

add({
  name: '悪い: 自己結合 3 回（別名 u1/u2/u3）',
  want: { tables: 3, joins: 2 },
  sql: `SELECT u1.name, u2.name mgr, u3.name mgr2
  FROM users u1
  LEFT JOIN users u2 ON u2.id = u1.manager_id
  LEFT JOIN users u3 ON u3.id = u2.manager_id`,
});

add({
  name: '悪い: NOT IN にサブクエリ（NULL で結果が消える定番の罠）',
  sql: `SELECT u.id FROM users u
 WHERE u.dept_id NOT IN (SELECT d.id FROM departments d WHERE d.closed = 1)
   AND u.manager_id NOT IN (SELECT m.id FROM managers m)`,
});

add({
  name: '悪い: 文字列連結で条件を組む',
  sql: `SELECT * FROM t WHERE CONCAT(a, '-', b) = 'x-y' AND CONCAT(SUBSTRING(cd,1,2), SUBSTRING(cd,5,2)) = '0101'`,
});

add({
  name: '悪い: ORDER BY RAND() と ORDER BY なし LIMIT',
  sql: `SELECT u.id, o.order_no
  FROM users u INNER JOIN orders o ON o.user_id = u.id
 WHERE u.status = 'active'
 ORDER BY RAND()
 LIMIT 10`,
});

add({
  name: '悪い: 極端に長い 1 行（改行なし）',
  sql: `SELECT a.c1,a.c2,a.c3,b.c1,b.c2,c.c1,c.c2,d.c1 FROM t_a a INNER JOIN t_b b ON b.id=a.id AND b.sub_id=a.sub_id AND b.flg=1 INNER JOIN t_c c ON c.id=b.id AND c.kbn='01' LEFT JOIN t_d d ON d.id=c.id WHERE a.del_flg=0 AND a.created_at>='2024-01-01' AND (b.status='A' OR b.status='B' OR b.status='C') AND IFNULL(c.amount,0)>0 ORDER BY a.c1,a.c2,b.c1`,
});

add({
  name: '悪い: タブとスペースが混在した不揃いインデント',
  sql: "SELECT\tu.id,\n  \tu.name,\n\t  d.dept_name\nFROM\tusers u\n\tINNER JOIN departments d\n\t\tON\td.id\t=\tu.dept_id\nWHERE\tu.sal\t>\t1000",
});

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

function allQueries(query: ParsedQuery): ParsedQuery[] {
  const out: ParsedQuery[] = [query];
  for (const t of query.tables) if (t.derivedQuery) out.push(...allQueries(t.derivedQuery));
  for (const c of query.ctes ?? []) out.push(...allQueries(c.query));
  for (const b of query.unionBranches ?? []) out.push(...allQueries(b.query));
  const walk = (n: ConditionNode | undefined): void => {
    if (!n) return;
    if (n.nestedQuery) out.push(...allQueries(n.nestedQuery));
    for (const c of n.children ?? []) walk(c);
  };
  walk(query.where);
  walk(query.having);
  return out;
}

function collectSpans(query: ParsedQuery): Array<{ what: string; span: SourceSpan }> {
  const spans: Array<{ what: string; span: SourceSpan }> = [];
  const push = (what: string, span?: SourceSpan) => {
    if (span) spans.push({ what, span });
  };
  for (const q of allQueries(query)) {
    for (const t of q.tables) push(`table:${t.table}`, t.sourceSpan);
    for (const j of q.joins) push(`join:${j.condition.slice(0, 20)}`, j.sourceSpan);
    for (const c of q.columns) push(`col:${c.expression.slice(0, 20)}`, c.sourceSpan);
    for (const g of q.groupBy) push(`group:${g.text.slice(0, 15)}`, g.sourceSpan);
    for (const o of q.orderBy) push(`order:${o.text.slice(0, 15)}`, o.sourceSpan);
    push('limit', q.limitSpan);
    push('offset', q.offsetSpan);
    push('straightJoin', q.straightJoinHintSpan);
    const walk = (n: ConditionNode | undefined): void => {
      if (!n) return;
      push(`cond:${n.label.slice(0, 20)}`, n.sourceSpan);
      for (const c of n.children ?? []) walk(c);
    };
    walk(q.where);
    walk(q.having);
  }
  return spans;
}

function displayTexts(query: ParsedQuery): string[] {
  const texts: string[] = [];
  for (const q of allQueries(query)) {
    texts.push(
      ...q.columns.map((c) => c.expression),
      ...q.groupBy.map((g) => g.text),
      ...q.orderBy.map((o) => o.text),
      ...q.joins.map((j) => j.condition),
      ...(q.setClauses ?? []).map((s) => s.label),
      q.where?.label ?? '',
      q.having?.label ?? '',
    );
  }
  const effect = buildQueryEffect(query, 'japanese');
  for (const s of effect.sections) texts.push(...(s.lines ?? []).map((l) => l.text));
  texts.push(effect.summary, buildQueryEffect(query, 'sql').summary);
  return texts;
}

describe('複雑な SQL / 作りの悪い SQL', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { sql, want } = testCase;

    const started = Date.now();
    const result = parseMySqlQuery(sql);
    const elapsed = Date.now() - started;

    expect(result.success, result.success ? '' : result.error.message).toBe(true);
    if (!result.success) return;
    const query = result.query;

    // 構造的不変条件（表示側が前提にしている形が崩れていないか）
    expect(() => assertParseInvariants(query, testCase.name)).not.toThrow();

    // 取りこぼしの検出
    if (want?.tables != null) expect(query.tables).toHaveLength(want.tables);
    if (want?.joins != null) expect(query.joins).toHaveLength(want.joins);
    if (want?.branches != null) expect(query.unionBranches ?? []).toHaveLength(want.branches);
    if (want?.ctes != null) expect(query.ctes ?? []).toHaveLength(want.ctes);
    if (want?.nested != null) {
      expect(collectAllNestedQueries(query).length).toBeGreaterThanOrEqual(want.nested);
    }

    // 位置情報が元 SQL の範囲に収まり、潰れていないか
    for (const { what, span } of collectSpans(query)) {
      expect(span.start, what).toBeGreaterThanOrEqual(0);
      expect(span.end, what).toBeLessThanOrEqual(sql.length);
      expect(span.end, what).toBeGreaterThan(span.start);
    }

    // 表示テキストへ内部データが漏れていないか
    const texts = displayTexts(query).join(' | ');
    expect(texts).not.toMatch(/"type"|tableList|columnList|\[object Object\]/);
    expect(texts).not.toMatch(/WHEN\s+THEN/);

    // 後続処理（エイリアス解決・JOIN 図レイアウト）が落ちないか
    expect(() => {
      const resolved = applyAliasResolution(query, true, { keepSelfJoinAliases: true });
      buildJoinFlowLayout(resolved.tables, resolved.joins, true, resolved);
    }).not.toThrow();

    // 解析が現実的な時間で終わるか（入力のたびに走るため）
    expect(elapsed).toBeLessThan(500);
  });

  it('自分自身との比較は「同じ」になる', () => {
    for (const { name, sql } of CASES) {
      const a = parseMySqlQuery(sql);
      const b = parseMySqlQuery(sql);
      if (!a.success || !b.success) continue;
      const diff = compareQueryResults(a.query, b.query);
      expect(diff.equalForResultSet, name).toBe(true);
      expect(diff.equalIncludingOrder, name).toBe(true);
    }
  });
});

/**
 * 比較モードで最も高くつく誤りは「違うのに同じと言う」こと。
 * 複雑な SQL でも偽陽性が出ないことを確かめる
 */
describe('複雑な SQL の比較で偽陽性を出さない', () => {
  const pairs: Array<{ name: string; a: string; b: string }> = [
    {
      name: '多段 JOIN の 1 本だけ LEFT → INNER',
      a: `SELECT u.id FROM users u LEFT JOIN orders o ON o.user_id = u.id LEFT JOIN items i ON i.order_id = o.id WHERE u.status = 'active'`,
      b: `SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id LEFT JOIN items i ON i.order_id = o.id WHERE u.status = 'active'`,
    },
    {
      name: '深いネストの最内 WHERE だけ違う',
      a: `SELECT id FROM t WHERE x IN (SELECT y FROM u WHERE z IN (SELECT w FROM v WHERE q = 1))`,
      b: `SELECT id FROM t WHERE x IN (SELECT y FROM u WHERE z IN (SELECT w FROM v WHERE q = 2))`,
    },
    {
      name: '自己結合の別名を入れ替える（実テーブルは同じ）',
      a: `SELECT u1.name FROM users u1 LEFT JOIN users u2 ON u2.id = u1.manager_id WHERE u1.status = 'a'`,
      b: `SELECT u1.name FROM users u1 LEFT JOIN users u2 ON u1.id = u2.manager_id WHERE u1.status = 'a'`,
    },
    {
      name: 'ON と WHERE の移動（外部結合では意味が変わる）',
      a: `SELECT u.id FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.total > 100`,
      b: `SELECT u.id FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE o.total > 100`,
    },
    {
      name: 'GROUP BY の列が 1 つ足りない',
      a: `SELECT a, b, COUNT(*) FROM t GROUP BY a, b`,
      b: `SELECT a, b, COUNT(*) FROM t GROUP BY a`,
    },
    {
      name: 'UNION ALL → UNION（重複排除の有無）',
      a: `SELECT id FROM t1 UNION ALL SELECT id FROM t2`,
      b: `SELECT id FROM t1 UNION SELECT id FROM t2`,
    },
    {
      name: 'LIMIT の値が違う',
      a: `SELECT id FROM t ORDER BY id LIMIT 10`,
      b: `SELECT id FROM t ORDER BY id LIMIT 20`,
    },
    {
      name: 'NOT IN → IN',
      a: `SELECT id FROM t WHERE cd NOT IN (SELECT cd FROM u)`,
      b: `SELECT id FROM t WHERE cd IN (SELECT cd FROM u)`,
    },
    {
      name: '3 段ネストの派生テーブルの最内フィルタが違う',
      a: `SELECT x.id FROM (SELECT y.id FROM (SELECT id FROM t WHERE flg = 0) y) x`,
      b: `SELECT x.id FROM (SELECT y.id FROM (SELECT id FROM t WHERE flg = 1) y) x`,
    },
    {
      name: 'HAVING の閾値が違う',
      a: `SELECT dept, COUNT(*) FROM t GROUP BY dept HAVING COUNT(*) > 5`,
      b: `SELECT dept, COUNT(*) FROM t GROUP BY dept HAVING COUNT(*) > 6`,
    },
  ];

  it.each(pairs.map((p) => [p.name, p] as const))('%s は「同じ」と言わない', (_name, pair) => {
    const a = parseMySqlQuery(pair.a);
    const b = parseMySqlQuery(pair.b);
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;

    const diff = compareQueryResults(a.query, b.query);
    expect(diff.equalForResultSet, `${pair.name}: 結果セットを同じと誤判定`).toBe(false);
  });

  it('整形しただけの SQL は「同じ」と判定できる', () => {
    const messy = `select U.ID,u.name from USERS U inner join ORDERS O on O.user_id=U.ID where U.STATUS='active' and O.TOTAL>100 order by 1`;
    const tidy = `SELECT u.id,
       u.name
  FROM users u
 INNER JOIN orders o
    ON o.user_id = u.id
 WHERE u.status = 'active'
   AND o.total > 100
 ORDER BY 1`;
    const a = parseMySqlQuery(messy);
    const b = parseMySqlQuery(tidy);
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;

    const diff = compareQueryResults(a.query, b.query);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.equalIncludingOrder).toBe(true);
  });
});
