import { describe, expect, it } from 'vitest';
import { applyAliasResolution } from './alias-resolver';
import { buildJoinFlowLayout } from './join-flow-layout';
import {
  computeJoinLayoutParent,
  formatJoinTableLink,
  getTableIdsReferencedInJoin,
  resolveJoinLayoutAnchor,
  resolveJoinLayoutSources,
} from './join-graph-layout';
import { formatJoinConditionLabel } from './join-condition';
import { parseMySqlQuery } from './parser';
import { buildQueryEffect } from './query-effect';

describe('JOIN ON サブクエリ', () => {
  const SUBQUERY_ON_SQL = [
    `SELECT u.id FROM users u JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)`,
    `SELECT u.id FROM users u JOIN orders o ON EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.user_id = u.id)`,
    `SELECT u.id FROM users u JOIN orders o ON NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)`,
    `SELECT u.id FROM users u JOIN orders o ON o.id = (SELECT MAX(x.id) FROM order_items x WHERE x.order_id = o.id)`,
    `SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id AND o.id IN (SELECT order_id FROM order_items WHERE product_id = 1)`,
  ] as const;

  it('ON 条件に JSON 文字列が露出しない（表示バグの回帰防止）', () => {
    for (const sql of SUBQUERY_ON_SQL) {
      const result = parseMySqlQuery(sql);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const condition = result.query.joins[0]?.condition ?? '';
      expect(condition).not.toMatch(/^\s*\{/);
      expect(condition).not.toContain('"type"');
      expect(condition).not.toContain('"left"');
      expect(condition).not.toContain('"right"');
      expect(condition.length).toBeGreaterThan(0);
      expect(condition).not.toBe('(subquery)');
    }
  });

  it('IN サブクエリを含む ON でも参照テーブルを正しく解決する', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON o.user_id = u.id AND o.id IN (SELECT order_id FROM order_items WHERE product_id = 1)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    const u = tables.find((t) => t.alias === 'u')!;
    const o = tables.find((t) => t.alias === 'o')!;
    const join = joins[0]!;

    expect(getTableIdsReferencedInJoin(join, tables).sort()).toEqual([o.id, u.id].sort());
    expect(resolveJoinLayoutSources(join, tables)).toEqual([u.id]);
    expect(formatJoinTableLink(join, tables)).toBe('u → o');
  });

  it('相関 IN サブクエリで外側テーブル参照を拾う', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    const u = tables.find((t) => t.alias === 'u')!;
    const o = tables.find((t) => t.alias === 'o')!;
    const join = joins[0]!;

    expect(getTableIdsReferencedInJoin(join, tables).sort()).toEqual([o.id, u.id].sort());
    expect(resolveJoinLayoutSources(join, tables)).toEqual([u.id]);
  });

  it('EXISTS サブクエリを含む ON でも参照テーブルを正しく解決する', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.user_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    const u = tables.find((t) => t.alias === 'u')!;
    const o = tables.find((t) => t.alias === 'o')!;
    const join = joins[0]!;

    expect(getTableIdsReferencedInJoin(join, tables).sort()).toEqual([o.id, u.id].sort());
    expect(resolveJoinLayoutSources(join, tables)).toEqual([u.id]);
  });

  it('作用説明タブの JOIN 説明がサブクエリ ON でも破綻しない', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    const scope = effect.sections.find((s) => s.kind === 'scope');
    const joinLine = scope?.lines?.find((l) => l.includes('IN (SELECT'));
    expect(joinLine).toBeDefined();
    expect(joinLine).toContain('u.id');
    expect(joinLine).toContain('o.user_id');
  });

  it('作用説明タブの JOIN 説明にも JSON が露出しない', () => {
    for (const sql of SUBQUERY_ON_SQL) {
      const result = parseMySqlQuery(sql);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const scopeLines =
        buildQueryEffect(result.query).sections.find((s) => s.kind === 'scope')?.lines ?? [];
      const joinLines = scopeLines.filter((l) => l.includes('JOIN') || l.includes('EXISTS') || l.includes(' IN '));
      expect(joinLines.length).toBeGreaterThan(0);
      for (const line of joinLines) {
        expect(line).not.toMatch(/^\s*\{/);
        expect(line).not.toContain('"type"');
      }
    }
  });

  it('解析時に conditionRoot が付与され condition もサブクエリ WHERE を含む', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const join = result.query.joins[0]!;
    expect(join.conditionRoot).toBeDefined();
    expect(join.condition).toContain('WHERE b.ref_id = u.id');
    expect(join.condition).toBe(formatJoinConditionLabel(join.conditionRoot!));
  });

  it('3テーブル JOIN でサブクエリ ON が中間テーブルではなく相関元に接続する', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN line_items li ON li.user_id = u.id
      JOIN orders o ON o.id IN (SELECT order_id FROM order_items x WHERE x.user_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    const u = tables.find((t) => t.alias === 'u')!;
    const o = tables.find((t) => t.alias === 'o')!;
    const oJoin = joins.find((j) => j.targetId === o.id)!;

    expect(resolveJoinLayoutSources(oJoin, tables)).toEqual([u.id]);
    expect(resolveJoinLayoutAnchor(oJoin, tables)).toBe(u.id);

    const parent = computeJoinLayoutParent(tables, joins);
    expect(parent.get(o.id)).toBe(u.id);

    const { edges } = buildJoinFlowLayout(tables, joins, false, result.query);
    const oEdge = edges.find((e) => e.id === oJoin.id);
    expect(oEdge?.source).toBe(u.id);
    expect(oEdge?.target).toBe(o.id);
  });

  it('エイリアス解決 ON でも JOIN 図の接続とリンク表記が維持される', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON o.user_id IN (SELECT user_id FROM banned b WHERE b.ref_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    const join = resolved.joins[0]!;
    const u = resolved.tables.find((t) => t.alias === 'u')!;

    expect(resolveJoinLayoutSources(join, resolved.tables)).toEqual([u.id]);
    expect(formatJoinTableLink(join, resolved.tables)).toMatch(/users.*→.*orders/);

    const { edges } = buildJoinFlowLayout(resolved.tables, resolved.joins, true, resolved);
    expect(edges[0]?.source).toBe(u.id);
  });

  it('NOT EXISTS を含む ON でも参照テーブルを解決する', () => {
    const result = parseMySqlQuery(`
      SELECT u.id
      FROM users u
      JOIN orders o ON NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.user_id = u.id)
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    const u = tables.find((t) => t.alias === 'u')!;
    const o = tables.find((t) => t.alias === 'o')!;
    const join = joins[0]!;

    expect(join.condition).toContain('NOT EXISTS');
    expect(getTableIdsReferencedInJoin(join, tables).sort()).toEqual([o.id, u.id].sort());
    expect(resolveJoinLayoutSources(join, tables)).toEqual([u.id]);
  });
});
