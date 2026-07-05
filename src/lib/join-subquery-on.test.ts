import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import {
  formatJoinTableLink,
  getTableIdsReferencedInJoin,
  resolveJoinLayoutSources,
} from './join-graph-layout';
import { buildQueryEffect } from './query-effect';

describe('JOIN ON サブクエリ', () => {
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

  it('対象レコードタブの JOIN 説明がサブクエリ ON でも破綻しない', () => {
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
});
