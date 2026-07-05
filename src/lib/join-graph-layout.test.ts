import { describe, expect, it } from 'vitest';
import { applyAliasResolution } from './alias-resolver';
import { parseMySqlQuery, SAMPLE_SQL } from './parser';
import {
  computeJoinLayoutParent,
  computeJoinNodePositions,
  getTableIdsReferencedInJoin,
  resolveJoinDisplaySource,
  resolveJoinLayoutAnchor,
} from './join-graph-layout';
import { buildJoinFlowLayout } from './join-flow-layout';

describe('join-graph-layout', () => {
  it('1テーブルから複数JOINする星型を同じ深さに配置する', () => {
    const result = parseMySqlQuery(`
      SELECT *
      FROM orders o
      INNER JOIN users u ON o.user_id = u.id
      INNER JOIN products p ON o.product_id = p.id
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { tables, joins } = result.query;
    expect(joins).toHaveLength(2);

    const parent = computeJoinLayoutParent(tables, joins);
    expect(parent.get(joins[1]!.targetId)).toBe(tables[0]!.id);

    const positions = computeJoinNodePositions(tables, joins);
    const uPos = positions.get(joins[0]!.targetId)!;
    const pPos = positions.get(joins[1]!.targetId)!;
    expect(uPos.x).toBe(pPos.x);
    expect(uPos.y).not.toBe(pPos.y);
  });

  it('SAMPLE_SQL の hot は users から分岐する', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const users = result.query.tables.find((t) => t.alias === 'u')!;
    const hot = result.query.tables.find((t) => t.alias === 'hot')!;
    const hotJoin = result.query.joins.find((j) => j.targetId === hot.id)!;

    expect(resolveJoinLayoutAnchor(hotJoin, result.query.tables)).toBe(users.id);

    const { edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );
    const hotEdge = edges.find((e) => e.id === hotJoin.id);
    expect(hotEdge?.source).toBe(users.id);
    expect(hotEdge?.target).toBe(hot.id);
  });

  it('getTableIdsReferencedInJoin は ON 条件の両側を拾う', () => {
    const tables = [
      { id: 't-o', table: 'orders', alias: 'o', displayName: 'o' },
      { id: 't-u', table: 'users', alias: 'u', displayName: 'u' },
    ];
    const join = {
      id: 'j1',
      type: 'INNER JOIN' as const,
      sourceId: 't-o',
      targetId: 't-u',
      condition: 'o.user_id = u.id',
      conditionParts: { left: 'o.user_id', operator: '=', right: 'u.id' },
    };

    expect(getTableIdsReferencedInJoin(join, tables).sort()).toEqual(['t-o', 't-u']);
    expect(resolveJoinDisplaySource(join, computeJoinLayoutParent(tables, [join]))).toBe('t-o');
  });

  it('同一テーブルを2回JOINしてもエイリアス解決後も星型レイアウトを保つ', () => {
    const result = parseMySqlQuery(`
      SELECT *
      FROM orders o
      INNER JOIN users u1 ON o.buyer_id = u1.id
      INNER JOIN users u2 ON o.seller_id = u2.id
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    const orders = resolved.tables[0]!;
    const u1 = resolved.tables.find((t) => t.alias === 'u1')!;
    const u2 = resolved.tables.find((t) => t.alias === 'u2')!;
    const joinU1 = resolved.joins[0]!;
    const joinU2 = resolved.joins[1]!;

    expect(joinU1.condition).toContain('users.');
    expect(joinU1.layoutCondition).toBe('o.buyer_id = u1.id');
    expect(getTableIdsReferencedInJoin(joinU2, resolved.tables).sort()).toEqual([orders.id, u2.id].sort());

    const parent = computeJoinLayoutParent(resolved.tables, resolved.joins);
    expect(parent.get(u1.id)).toBe(orders.id);
    expect(parent.get(u2.id)).toBe(orders.id);

    const { edges } = buildJoinFlowLayout(resolved.tables, resolved.joins, true, resolved);
    expect(edges.find((e) => e.id === joinU1.id)?.source).toBe(orders.id);
    expect(edges.find((e) => e.id === joinU2.id)?.source).toBe(orders.id);

    const positions = computeJoinNodePositions(resolved.tables, resolved.joins);
    expect(positions.get(u1.id)!.x).toBe(positions.get(u2.id)!.x);
    expect(positions.get(u1.id)!.y).not.toBe(positions.get(u2.id)!.y);
  });
});
