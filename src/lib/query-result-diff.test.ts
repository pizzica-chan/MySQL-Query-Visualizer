import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import {
  compareQueryResults,
  normalizeExpr,
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

  it('ORDER BY のみ違い: compareOrderBy false なら集合一致、true なら不一致', () => {
    const a = mustParse('SELECT id, name FROM users ORDER BY id');
    const b = mustParse('SELECT id, name FROM users ORDER BY name');

    const ignoreOrder = compareQueryResults(a, b, { compareOrderBy: false });
    expect(ignoreOrder.equalForResultSet).toBe(true);
    expect(ignoreOrder.equalIncludingOrder).toBe(false);
    expect(ignoreOrder.categories.find((c) => c.id === 'orderBy')?.status).toBe('different');

    const withOrder = compareQueryResults(a, b, { compareOrderBy: true });
    expect(withOrder.equalForResultSet).toBe(true);
    expect(withOrder.equalIncludingOrder).toBe(false);
    expect(withOrder.categories.find((c) => c.id === 'orderBy')?.status).toBe('different');
  });

  it('ORDER BY が同じなら equalIncludingOrder も true', () => {
    const a = mustParse('SELECT id FROM users ORDER BY id DESC');
    const b = mustParse('SELECT id FROM users ORDER BY id DESC');
    const diff = compareQueryResults(a, b, { compareOrderBy: true });
    expect(diff.equalForResultSet).toBe(true);
    expect(diff.equalIncludingOrder).toBe(true);
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
});
