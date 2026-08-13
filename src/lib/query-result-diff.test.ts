import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import {
  buildResultDiffSummary,
  compareQueryResults,
  detectReviewHints,
  normalizeExpr,
  partitionDiffCategories,
  resultSetSignature,
} from './query-result-diff';

function mustParse(sql: string) {
  const result = parseMySqlQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  return result.query;
}

describe('normalizeExpr', () => {
  it('空白と大文字小文字を揃える', () => {
    expect(normalizeExpr('  Foo.Bar  =  1 ')).toBe('foo.bar = 1');
  });

  it('バッククォートを除去する', () => {
    expect(normalizeExpr('`users`.`id`')).toBe('users.id');
  });
});

describe('compareQueryResults', () => {
  it('同一クエリ（空白・改行のみ違い）は差分なし', () => {
    const a = mustParse('SELECT id, name FROM users WHERE active = 1');
    const b = mustParse(`SELECT
      id,
      name
    FROM users
    WHERE active = 1`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.equalIncludingOrder).toBe(true);
    expect(diff.categories.every((c) => c.status === 'same')).toBe(true);
  });

  it('エイリアスのみ違いでも結果集合は同じと推定', () => {
    const a = mustParse('SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id');
    const b = mustParse(
      'SELECT users.id FROM users INNER JOIN orders ON users.id = orders.user_id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(resultSetSignature(a)).toBe(resultSetSignature(b));
  });

  it('INNER JOIN の記述順入れ替えは結果集合として同じ', () => {
    const a = mustParse(`SELECT
      o.id,
      u.name,
      p.amount
    FROM orders o
    INNER JOIN users u ON o.user_id = u.id
    INNER JOIN payments p ON p.order_id = o.id
    WHERE o.status = 'paid'`);
    const b = mustParse(`SELECT
      o.id,
      u.name,
      p.amount
    FROM users u
    INNER JOIN orders o ON o.user_id = u.id
    INNER JOIN payments p ON p.order_id = o.id
    WHERE o.status = 'paid'`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('same');
  });

  it('STRAIGHT JOIN と INNER JOIN は結果集合として同じ', () => {
    const a = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT u.id FROM users u STRAIGHT_JOIN orders o ON u.id = o.user_id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('same');
  });

  it('SELECT STRAIGHT_JOIN ヒント付き JOIN も INNER JOIN と結果集合として同じ', () => {
    const a = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT STRAIGHT_JOIN u.id FROM users u JOIN orders o ON u.id = o.user_id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('same');
  });

  it('STRAIGHT JOIN のテーブル順入れ替えでも結果集合は同等', () => {
    const a = mustParse(
      'SELECT u.id FROM users u STRAIGHT_JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT u.id FROM orders o STRAIGHT_JOIN users u ON u.id = o.user_id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
  });

  it('LEFT JOIN の保全側入れ替えは結果が異なると判定する', () => {
    const a = mustParse(
      'SELECT u.id, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT u.id, o.id FROM orders o LEFT JOIN users u ON o.user_id = u.id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('different');
  });

  it('同じ LEFT JOIN（エイリアスのみ違い）は一致する', () => {
    const a = mustParse(
      'SELECT u.id, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT users.id, orders.id FROM users LEFT JOIN orders ON users.id = orders.user_id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('same');
  });

  it('JOIN 条件だけ変更すると joins が different', () => {
    const a = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.active = 1',
    );
    const b = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.customer_id WHERE u.active = 1',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    const joins = diff.categories.find((c) => c.id === 'joins');
    expect(joins?.status).toBe('different');
    const othersDifferent = diff.categories.filter(
      (c) => c.status === 'different' && c.id !== 'joins',
    );
    expect(othersDifferent.map((c) => c.id)).not.toContain('where');
  });

  it('SELECT 列の追加で columns が different', () => {
    const a = mustParse('SELECT id FROM users');
    const b = mustParse('SELECT id, name FROM users');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'columns')?.status).toBe('different');
  });

  it('ORDER BY のみ違い: 結果セットは同じ・並び順は異なる', () => {
    const a = mustParse('SELECT id, name FROM users ORDER BY id');
    const b = mustParse('SELECT id, name FROM users ORDER BY name');

    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.equalIncludingOrder).toBe(false);
    expect(diff.categories.find((c) => c.id === 'orderBy')?.status).toBe('different');

    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('order-only');
    expect(summary.resultSet.label).toBe('同じ');
    expect(summary.order.label).toBe('異なる');

    const parts = partitionDiffCategories(diff.categories);
    expect(parts.resultSetDifferent).toHaveLength(0);
    expect(parts.orderDifferent).toHaveLength(1);
  });

  it('ORDER BY が同じなら equalIncludingOrder も true', () => {
    const a = mustParse('SELECT id FROM users ORDER BY id DESC');
    const b = mustParse('SELECT id FROM users ORDER BY id DESC');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.equalIncludingOrder).toBe(true);

    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('same');
    expect(summary.resultSet.label).toBe('同じ');
    expect(summary.order.label).toBe('同じ');
  });

  it('ORDER BY なし同士は並び順が指定なし', () => {
    const a = mustParse('SELECT id FROM users');
    const b = mustParse('SELECT id FROM users');
    const diff = compareQueryResults(a, b);
    const summary = buildResultDiffSummary(diff);
    expect(summary.order.status).toBe('not-specified');
    expect(summary.order.label).toBe('指定なし');
  });

  it('LIMIT ありで ORDER BY のみ違うと結果セットも異なる扱い', () => {
    const a = mustParse('SELECT id FROM users ORDER BY id LIMIT 1');
    const b = mustParse('SELECT id FROM users ORDER BY name LIMIT 1');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.equalIncludingOrder).toBe(false);
    expect(diff.categories.find((c) => c.id === 'orderBy')?.status).toBe('different');
    expect(diff.categories.find((c) => c.id === 'limit')?.status).toBe('same');

    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('different');
    expect(summary.resultSet.label).toBe('異なる');
    expect(summary.order.label).toBe('異なる');
    expect(summary.note).toMatch(/LIMIT/);
  });

  it('OFFSET ありで ORDER BY のみ違うと結果セットも異なる扱い', () => {
    const a = mustParse('SELECT id FROM users ORDER BY id LIMIT 10 OFFSET 5');
    const b = mustParse('SELECT id FROM users ORDER BY name LIMIT 10 OFFSET 5');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.equalIncludingOrder).toBe(false);
  });

  it('UNION ALL と UNION は union 差分', () => {
    const a = mustParse('SELECT id FROM users UNION SELECT id FROM admins');
    const b = mustParse('SELECT id FROM users UNION ALL SELECT id FROM admins');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'union')?.status).toBe('different');
  });

  it('WHERE の AND 順序入れ替えは同一扱い', () => {
    const a = mustParse('SELECT id FROM users WHERE active = 1 AND role = "admin"');
    const b = mustParse('SELECT id FROM users WHERE role = "admin" AND active = 1');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'where')?.status).toBe('same');
  });

  it('WHERE 条件の値が違えば where が different', () => {
    const a = mustParse('SELECT id FROM users WHERE active = 1');
    const b = mustParse('SELECT id FROM users WHERE active = 0');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'where')?.status).toBe('different');
  });

  it('AND 配下の値の違いも where 差分として検出する', () => {
    const a = mustParse('SELECT id FROM users WHERE active = 1 AND role = 2');
    const b = mustParse('SELECT id FROM users WHERE active = 1 AND role = 3');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    const where = diff.categories.find((c) => c.id === 'where');
    expect(where?.status).toBe('different');
    expect(where?.details.length).toBeGreaterThan(0);
    expect(where?.details.some((d) => d.includes('role'))).toBe(true);
  });

  it('GROUP BY の列順入れ替えは同一扱い', () => {
    const a = mustParse('SELECT role, COUNT(*) AS c FROM users GROUP BY role, active');
    const b = mustParse('SELECT role, COUNT(*) AS c FROM users GROUP BY active, role');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'groupBy')?.status).toBe('same');
  });

  it('RIGHT JOIN と等価な LEFT JOIN は一致する', () => {
    const a = mustParse(
      'SELECT u.id, o.id FROM users u RIGHT JOIN orders o ON u.id = o.user_id',
    );
    const b = mustParse(
      'SELECT u.id, o.id FROM orders o LEFT JOIN users u ON o.user_id = u.id',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.categories.find((c) => c.id === 'joins')?.status).toBe('same');
  });

  it('LIMIT の違いを検出する', () => {
    const a = mustParse('SELECT id FROM users LIMIT 10');
    const b = mustParse('SELECT id FROM users LIMIT 20');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'limit')?.status).toBe('different');
  });

  it('DISTINCT の有無を検出する', () => {
    const a = mustParse('SELECT id FROM users');
    const b = mustParse('SELECT DISTINCT id FROM users');
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.categories.find((c) => c.id === 'distinct')?.status).toBe('different');
  });

  it('EXISTS ↔ JOIN+DISTINCT は結果異なるまま要確認ヒントを出す', () => {
    const existsSql = mustParse(`SELECT u.id, u.name
FROM users u
WHERE u.active = 1
  AND EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.user_id = u.id
      AND o.status = 'paid'
  )`);
    const joinSql = mustParse(`SELECT DISTINCT
  u.id,
  u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE u.active = 1
  AND o.status = 'paid'`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(true);
    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('review-needed');
    expect(summary.resultSet.status).toBe('different');
  });

  it('NOT EXISTS ↔ JOIN+DISTINCT には要確認ヒントを出さない', () => {
    const notExistsSql = mustParse(`SELECT u.id, u.name
FROM users u
WHERE u.active = 1
  AND NOT EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.user_id = u.id
      AND o.status = 'paid'
  )`);
    const joinSql = mustParse(`SELECT DISTINCT
  u.id,
  u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE u.active = 1
  AND o.status = 'paid'`);
    const diff = compareQueryResults(notExistsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('WHERE→ON 配置違いは要確認ヒントを出す', () => {
    const a = mustParse(`SELECT
  u.id,
  u.name,
  o.id AS order_id,
  o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid'
  AND o.total >= 1000`);
    const b = mustParse(`SELECT
  u.id,
  u.name,
  o.id AS order_id,
  o.total
FROM users u
INNER JOIN orders o
  ON u.id = o.user_id
 AND o.status = 'paid'
 AND o.total >= 1000`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(true);
    expect(buildResultDiffSummary(diff).tone).toBe('review-needed');
  });

  it('CROSS JOIN ON の WHERE→ON 配置違いでも要確認ヒントを出す', () => {
    const a = mustParse(
      "SELECT u.id FROM users u CROSS JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid'",
    );
    const b = mustParse(
      "SELECT u.id FROM users u CROSS JOIN orders o ON u.id = o.user_id AND o.status = 'paid'",
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(true);
  });

  it('3 表 JOIN の WHERE→ON 配置違いでも要確認ヒントを出す', () => {
    const a = mustParse(`SELECT u.id, p.name
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'paid'
  AND p.active = 1`);
    const b = mustParse(`SELECT u.id, p.name
FROM users u
INNER JOIN orders o ON u.id = o.user_id AND o.status = 'paid'
INNER JOIN products p ON o.product_id = p.id AND p.active = 1`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(true);
    expect(buildResultDiffSummary(diff).tone).toBe('review-needed');
  });

  it('JOIN 結合構造が違うと WHERE→ON ヒントを出さない', () => {
    const a = mustParse(`SELECT u.id, p.name
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'paid'`);
    const b = mustParse(`SELECT u.id, p.name
FROM users u
INNER JOIN orders o ON u.id = o.user_id AND o.status = 'paid'
INNER JOIN products p ON u.id = p.seller_id`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('JOIN 条件ミスは要確認ヒントを出さない', () => {
    const a = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.active = 1',
    );
    const b = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.customer_id WHERE u.active = 1',
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints).toHaveLength(0);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('EXISTS と JOIN で絞り込み値が違うとヒントを出さない', () => {
    const existsSql = mustParse(`SELECT u.id FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid'
)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE o.status = 'pending'`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
  });

  it('EXISTS と JOIN で結合先テーブルが違うとヒントを出さない', () => {
    const existsSql = mustParse(`SELECT u.id FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o WHERE o.user_id = u.id
)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id FROM users u
INNER JOIN payments p ON p.user_id = u.id`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
  });

  it('EXISTS 内に GROUP BY があると JOIN+DISTINCT ヒントを出さない', () => {
    const existsSql = mustParse(`SELECT u.id FROM users u
WHERE EXISTS (
  SELECT o.user_id
  FROM orders o
  WHERE o.user_id = u.id
  GROUP BY o.user_id
  HAVING COUNT(*) > 1
)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id FROM users u
INNER JOIN orders o ON o.user_id = u.id`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('EXISTS 内に LIMIT があると JOIN+DISTINCT ヒントを出さない', () => {
    const existsSql = mustParse(`SELECT u.id FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o WHERE o.user_id = u.id LIMIT 1
)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id FROM users u
INNER JOIN orders o ON o.user_id = u.id`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
  });

  it('WHERE→ON に加えて LIMIT が違うとヒントを出さない', () => {
    const a = mustParse(`SELECT u.id, o.id AS order_id
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid'
LIMIT 10`);
    const b = mustParse(`SELECT u.id, o.id AS order_id
FROM users u
INNER JOIN orders o ON u.id = o.user_id AND o.status = 'paid'
LIMIT 20`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('WHERE→ON に加えて GROUP BY が違うとヒントを出さない', () => {
    const a = mustParse(`SELECT u.role, COUNT(*) AS c
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid'
GROUP BY u.role`);
    const b = mustParse(`SELECT u.role, COUNT(*) AS c
FROM users u
INNER JOIN orders o ON u.id = o.user_id AND o.status = 'paid'
GROUP BY u.role, u.active`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(false);
  });

  it('バッククォート付き列でも EXISTS↔JOIN ヒントを出す', () => {
    const existsSql = mustParse(`SELECT \`u\`.\`id\`, \`u\`.\`name\`
FROM users u
WHERE \`u\`.\`active\` = 1
  AND EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid'
  )`);
    const joinSql = mustParse(`SELECT DISTINCT \`u\`.\`id\`, \`u\`.\`name\`
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE \`u\`.\`active\` = 1 AND o.status = 'paid'`);
    const hints = detectReviewHints(existsSql, joinSql);
    expect(hints.map((h) => h.id)).toEqual(['exists-vs-distinct-join']);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(true);
    expect(buildResultDiffSummary(diff).tone).toBe('review-needed');
  });

  it('NOT (EXISTS (...)) には EXISTS↔JOIN ヒントを出さない', () => {
    const notExistsSql = mustParse(`SELECT u.id, u.name
FROM users u
WHERE u.active = 1
  AND NOT (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.user_id = u.id AND o.status = 'paid'
    )
  )`);
    const joinSql = mustParse(`SELECT DISTINCT u.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE u.active = 1 AND o.status = 'paid'`);
    const diff = compareQueryResults(notExistsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('スキーマ修飾テーブルでも EXISTS↔JOIN ヒントを出す', () => {
    const existsSql = mustParse(`SELECT u.id
FROM mydb.users u
WHERE EXISTS (SELECT 1 FROM mydb.orders o WHERE o.user_id = u.id)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id
FROM mydb.users u
INNER JOIN mydb.orders o ON o.user_id = u.id`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(true);
  });

  it('DISTINCT CROSS JOIN でも EXISTS↔JOIN ヒントを出す', () => {
    const existsSql = mustParse(`SELECT u.id
FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`);
    const joinSql = mustParse(`SELECT DISTINCT u.id
FROM users u
CROSS JOIN orders o ON o.user_id = u.id`);
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(true);
  });

  it('WHERE の OR を ON の AND に崩しただけの差分には where-to-on ヒントを出さない', () => {
    const a = mustParse(
      "SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid' OR o.total > 100",
    );
    const b = mustParse(
      "SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id AND o.status = 'paid' WHERE o.total > 100",
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('EXISTS が OR 配下にあるときは EXISTS↔JOIN ヒントを出さない', () => {
    const existsSql = mustParse(
      'SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) OR u.active = 1',
    );
    const joinSql = mustParse(
      'SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.active = 1',
    );
    const diff = compareQueryResults(existsSql, joinSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'exists-vs-distinct-join')).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('ON 側に OR がある WHERE→ON にはヒントを出さない', () => {
    const a = mustParse(
      "SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.status = 'paid' OR o.total > 100",
    );
    const b = mustParse(
      "SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id AND (o.status = 'paid' OR o.total > 100)",
    );
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'where-to-on')).toBe(false);
  });

  it('LEFT JOIN + WHERE（右表列）と INNER JOIN は結果セット同等とみなす', () => {
    const leftSql = mustParse(`SELECT u.id, u.name, o.id AS order_id, o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid' AND o.total >= 1000`);
    const innerSql = mustParse(`SELECT u.id, u.name, o.id AS order_id, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid' AND o.total >= 1000`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.matchedViaEffectiveInner).toBe(true);
    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('same');
    expect(summary.effectiveInnerNote).toContain('実質 INNER JOIN');
    expect(diff.reviewHints).toHaveLength(0);
  });

  it('CTE 内の LEFT JOIN + WHERE（右表列）と INNER JOIN も結果セット同等とみなす', () => {
    const leftSql = mustParse(`WITH paid AS (
  SELECT u.id, o.total
  FROM users u
  LEFT JOIN orders o ON u.id = o.user_id
  WHERE o.status = 'paid'
)
SELECT id, total FROM paid`);
    const innerSql = mustParse(`WITH paid AS (
  SELECT u.id, o.total
  FROM users u
  INNER JOIN orders o ON u.id = o.user_id
  WHERE o.status = 'paid'
)
SELECT id, total FROM paid`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.matchedViaEffectiveInner).toBe(true);
    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('same');
    expect(summary.effectiveInnerNote).toContain('実質 INNER JOIN');
  });

  it('派生テーブル内の LEFT JOIN + WHERE（右表列）と INNER JOIN も結果セット同等とみなす', () => {
    const leftSql = mustParse(`SELECT p.id, p.total
FROM (
  SELECT u.id, o.total
  FROM users u
  LEFT JOIN orders o ON u.id = o.user_id
  WHERE o.status = 'paid'
) p`);
    const innerSql = mustParse(`SELECT p.id, p.total
FROM (
  SELECT u.id, o.total
  FROM users u
  INNER JOIN orders o ON u.id = o.user_id
  WHERE o.status = 'paid'
) p`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.matchedViaEffectiveInner).toBe(true);
    expect(buildResultDiffSummary(diff).effectiveInnerNote).toContain('実質 INNER JOIN');
  });

  it('RIGHT JOIN + WHERE（左表列）と INNER JOIN は結果セット同等とみなす', () => {
    const rightSql = mustParse(`SELECT u.id, o.id AS order_id
FROM users u
RIGHT JOIN orders o ON u.id = o.user_id
WHERE u.active = 1`);
    const innerSql = mustParse(`SELECT u.id, o.id AS order_id
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE u.active = 1`);
    const diff = compareQueryResults(rightSql, innerSql);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.matchedViaEffectiveInner).toBe(true);
    expect(buildResultDiffSummary(diff).effectiveInnerNote).toContain('実質 INNER JOIN');
  });

  it('LEFT JOIN のみと INNER JOIN は同等とみなさない', () => {
    const leftSql = mustParse(
      'SELECT u.id, o.id AS order_id FROM users u LEFT JOIN orders o ON u.id = o.user_id',
    );
    const innerSql = mustParse(
      'SELECT u.id, o.id AS order_id FROM users u INNER JOIN orders o ON u.id = o.user_id',
    );
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.matchedViaEffectiveInner).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('LEFT JOIN + WHERE（右表 IS NULL）と INNER JOIN は同等とみなさない', () => {
    const leftSql = mustParse(
      'SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL',
    );
    const innerSql = mustParse(
      'SELECT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id',
    );
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(false);
  });

  it('LEFT JOIN + WHERE IFNULL（右表）と INNER JOIN は同等とみなさない', () => {
    const leftSql = mustParse(`SELECT u.id, o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE IFNULL(o.total, 0) = 0`);
    const innerSql = mustParse(`SELECT u.id, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE IFNULL(o.total, 0) = 0`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.matchedViaEffectiveInner).toBe(false);
    expect(buildResultDiffSummary(diff).tone).toBe('different');
  });

  it('LEFT JOIN + WHERE COALESCE（右表）と INNER JOIN は同等とみなさない', () => {
    const leftSql = mustParse(`SELECT u.id, o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE COALESCE(o.total, 0) = 0`);
    const innerSql = mustParse(`SELECT u.id, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE COALESCE(o.total, 0) = 0`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.matchedViaEffectiveInner).toBe(false);
  });

  it('LIMIT あり・ORDER BY なしで JOIN 記述順だけ違うと要確認', () => {
    const a = mustParse(`SELECT o.id, u.name, p.amount
FROM orders o
INNER JOIN users u ON o.user_id = u.id
INNER JOIN payments p ON p.order_id = o.id
WHERE o.status = 'paid'
LIMIT 10`);
    const b = mustParse(`SELECT o.id, u.name, p.amount
FROM users u
INNER JOIN orders o ON o.user_id = u.id
INNER JOIN payments p ON p.order_id = o.id
WHERE o.status = 'paid'
LIMIT 10`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(true);
    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('review-needed');
    expect(summary.title).toMatch(/LIMIT あり/);
    expect(summary.resultSet.label).toBe('要確認');
    expect(summary.limitWithoutOrderWarning).toMatch(/問題ないと判断せず/);
    expect(summary.body).toMatch(/カテゴリ一覧には出ない/);
  });

  it('実質 INNER 正規化後に JOIN 記述順だけ違う + LIMIT（ORDER BY なし）も要確認', () => {
    const a = mustParse(`SELECT o.id, u.name
FROM orders o
LEFT JOIN users u ON o.user_id = u.id
WHERE u.active = 1
LIMIT 10`);
    const b = mustParse(`SELECT o.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE u.active = 1
LIMIT 10`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(true);
    const hint = diff.reviewHints.find((h) => h.id === 'limit-without-order');
    expect(hint?.message).toMatch(/JOIN の記述順/);
    expect(buildResultDiffSummary(diff).tone).toBe('review-needed');
    expect(buildResultDiffSummary(diff).body).not.toMatch(/構文上の差分はありません/);
  });

  it('LIMIT あり・ORDER BY なしでも JOIN 記述順が同じなら構文同等だが要確認', () => {
    const sql = `SELECT o.id FROM orders o INNER JOIN users u ON o.user_id = u.id LIMIT 10`;
    const a = mustParse(sql);
    const b = mustParse(sql);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(true);
    const summary = buildResultDiffSummary(diff);
    expect(summary.tone).toBe('review-needed');
    expect(summary.resultSet.label).toBe('要確認');
    expect(summary.resultSet.status).toBe('uncertain');
    expect(summary.limitWithoutOrderWarning).toMatch(/問題ないと判断せず/);
    expect(summary.body).toMatch(/構文上の差分はありません/);
  });

  it('ORDER BY なしの LIMIT + OFFSET も要確認（OFFSET 経路）', () => {
    const sql = 'SELECT id FROM users LIMIT 10 OFFSET 5';
    const a = mustParse(sql);
    const b = mustParse(sql);
    const diff = compareQueryResults(a, b);
    expect(diff.limitWithoutOrderActive).toBe(true);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(true);
    expect(buildResultDiffSummary(diff).tone).toBe('review-needed');
  });

  it('ORDER BY なしで JOIN 記述順だけ違い + OFFSET ありも要確認', () => {
    const a = mustParse(`SELECT o.id, u.name
FROM orders o
INNER JOIN users u ON o.user_id = u.id
LIMIT 10 OFFSET 5`);
    const b = mustParse(`SELECT o.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LIMIT 10 OFFSET 5`);
    const diff = compareQueryResults(a, b);
    expect(diff.limitWithoutOrderActive).toBe(true);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(true);
    expect(buildResultDiffSummary(diff).body).toMatch(/JOIN の記述順/);
  });

  it('LIMIT なしの JOIN 記述順入れ替えは従来どおり同等', () => {
    const a = mustParse(`SELECT o.id, u.name
FROM orders o
INNER JOIN users u ON o.user_id = u.id
WHERE o.status = 'paid'`);
    const b = mustParse(`SELECT o.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE o.status = 'paid'`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.reviewHints).toHaveLength(0);
    expect(buildResultDiffSummary(diff).tone).toBe('same');
  });

  it('JOIN 記述順差があっても LIMIT 値が違うと JOIN 順ヒントは出さない', () => {
    const a = mustParse(`SELECT o.id, u.name
FROM orders o
INNER JOIN users u ON o.user_id = u.id
LIMIT 10`);
    const b = mustParse(`SELECT o.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LIMIT 20`);
    const diff = compareQueryResults(a, b);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(false);
    expect(diff.categories.find((c) => c.id === 'limit')?.status).toBe('different');
  });

  it('片側だけ ORDER BY がある JOIN 記述順差では JOIN 順ヒントは出さない', () => {
    const a = mustParse(`SELECT o.id, u.name
FROM orders o
INNER JOIN users u ON o.user_id = u.id
LIMIT 10`);
    const b = mustParse(`SELECT o.id, u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
ORDER BY o.id
LIMIT 10`);
    const diff = compareQueryResults(a, b);
    expect(diff.reviewHints.some((h) => h.id === 'limit-without-order')).toBe(false);
    expect(diff.categories.find((c) => c.id === 'orderBy')?.status).toBe('different');
  });

  it('HAVING 単独の実質 INNER（常に真になりうる条件）では INNER と同等扱いにしない', () => {
    const leftSql = mustParse(`SELECT a.id, COUNT(b.id) AS cnt
FROM table_a a
LEFT JOIN table_b b ON b.a_id = a.id
GROUP BY a.id
HAVING COUNT(b.id) >= 0`);
    const innerSql = mustParse(`SELECT a.id, COUNT(b.id) AS cnt
FROM table_a a
INNER JOIN table_b b ON b.a_id = a.id
GROUP BY a.id
HAVING COUNT(b.id) >= 0`);
    const diff = compareQueryResults(leftSql, innerSql);
    expect(diff.equalForResultSet).toBe(false);
    expect(diff.matchedViaEffectiveInner).toBe(false);
    expect(buildResultDiffSummary(diff).tone).not.toBe('same');
    expect(buildResultDiffSummary(diff).effectiveInnerNote).toBeUndefined();
  });
});
