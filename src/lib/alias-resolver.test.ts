import { describe, expect, it } from 'vitest';
import { applyAliasResolution, buildAliasMap, resolveAliasesInText } from './alias-resolver';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { parseMySqlQuery, SAMPLE_SQL, UNION_SAMPLE_SQL } from './parser';
import { collectAllNestedQueries } from './query-utils';

describe('alias-resolver', () => {
  const tables = [
    {
      id: 't1',
      table: 'users',
      alias: 'u',
      displayName: 'u',
    },
    {
      id: 't2',
      table: 'orders',
      alias: 'o',
      displayName: 'o',
    },
  ];

  it('buildAliasMap がエイリアス→実名を構築する', () => {
    const map = buildAliasMap(tables);
    expect(map.get('u')).toBe('users');
    expect(map.get('o')).toBe('orders');
  });

  it('resolveAliasesInText が qualified 名を置換する', () => {
    const map = buildAliasMap(tables);
    expect(resolveAliasesInText('u.id = o.user_id', map)).toBe('users.id = orders.user_id');
    expect(resolveAliasesInText('u.email LIKE %@example.com', map)).toBe(
      'users.email LIKE %@example.com',
    );
  });

  it('部分一致しない（user_id の u は置換しない）', () => {
    const map = buildAliasMap(tables);
    expect(resolveAliasesInText('o.user_id', map)).toBe('orders.user_id');
  });

  it('スキーマ付きテーブルのエイリアスを解決する', () => {
    const map = buildAliasMap([
      { id: 't1', schema: 'mydb', table: 'users', alias: 'u', displayName: 'u' },
    ]);
    expect(resolveAliasesInText('u.id', map)).toBe('mydb.users.id');
  });

  it('派生テーブルのエイリアスは buildAliasMap に含めない', () => {
    const map = buildAliasMap([
      { id: 't1', table: 'subq', alias: 't', displayName: 't (派生)', isDerived: true },
      { id: 't2', table: 'orders', alias: 'o', displayName: 'o' },
    ]);
    expect(map.has('t')).toBe(false);
    expect(map.get('o')).toBe('orders');
  });

  it('applyAliasResolution が解析結果全体を変換する', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);

    expect(resolved.tables[0]?.displayName).toBe('users');
    expect(resolved.joins[0]?.condition).toContain('users.');
    expect(resolved.joins[0]?.condition).toContain('orders.');
    expect(
      resolved.columns.every((c) => !/^u\./.test(c.expression) && !/^o\./.test(c.expression)),
    ).toBe(true);
    expect(() => assertParseInvariants(resolved, 'resolved SAMPLE')).not.toThrow();
  });

  it('enabled=false のとき元のクエリを返す', () => {
    const result = parseMySqlQuery('SELECT u.id FROM users u');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, false);
    expect(resolved.tables[0]?.displayName).toBe('u');
    expect(resolved).toBe(result.query);
  });

  it('WHERE 内サブクエリにも再帰的に適用する', () => {
    const result = parseMySqlQuery(
      'SELECT id FROM users u WHERE u.id IN (SELECT o.user_id FROM orders o WHERE o.total > 0)',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    const nested = resolved.where?.nestedQuery;
    expect(nested?.tables[0]?.displayName).toBe('orders');
    expect(nested?.where?.label).toContain('orders.');
  });

  it('派生テーブル内クエリにも再帰的に適用する', () => {
    const result = parseMySqlQuery(
      'SELECT t.id FROM (SELECT u.id FROM users u WHERE u.status = 1) t',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    const derived = resolved.tables.find((t) => t.isDerived);
    expect(derived?.derivedQuery?.where?.label).toContain('users.');
    expect(derived?.displayName).toContain('派生');
  });

  it('UNION 各ブランチにも再帰的に適用する', () => {
    const result = parseMySqlQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    const branch2 = resolved.unionBranches?.[2]?.query;
    expect(branch2?.tables[0]?.displayName).toBe('guest_users');
    const branch2Labels = branch2?.where
      ? [branch2.where.label, ...(branch2.where.children ?? []).map((c) => c.label)]
      : [];
    expect(branch2Labels.some((l) => l.includes('guest_users.'))).toBe(true);

    const nested = collectAllNestedQueries(resolved);
    const ordersSub = nested.find(
      (q) =>
        q.tables.some((t) => t.table === 'orders') &&
        q.where?.label.includes('user_id'),
    );
    expect(ordersSub?.where?.label).toContain('orders.');
  });

  it('UPDATE の SET 句テーブルエイリアスを解決する', () => {
    const result = parseMySqlQuery(
      "UPDATE users u INNER JOIN orders o ON o.user_id = u.id SET u.status = 'x', o.closed = 1",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    expect(resolved.setClauses?.every((s) => !s.table || !['u', 'o'].includes(s.table))).toBe(true);
    expect(resolved.setClauses?.some((s) => s.table === 'users')).toBe(true);
    expect(resolved.setClauses?.some((s) => s.table === 'orders')).toBe(true);
  });

  it('DELETE の deleteTargets エイリアスを解決する', () => {
    const result = parseMySqlQuery(
      'DELETE u, o FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.status = 0',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    expect(resolved.deleteTargets?.map((d) => d.name).sort().join(',')).toBe('orders,users');
  });
});
