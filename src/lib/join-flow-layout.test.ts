import { describe, expect, it } from 'vitest';
import { parseMySqlQuery, SAMPLE_SQL } from './parser';
import {
  assertJoinFlowLayoutReady,
  buildJoinFlowLayout,
  computeJoinLayoutKey,
  minimapNodeColor,
  MINIMAP_NODE_COLORS,
} from './join-flow-layout';

describe('join-flow-layout', () => {
  const sampleTables = [
    { id: 'tbl-1', table: 'users', alias: 'u', displayName: 'u' },
    { id: 'tbl-2', table: 'orders', alias: 'o', displayName: 'o' },
  ];
  const sampleJoins = [
    {
      id: 'join-1',
      type: 'INNER JOIN' as const,
      sourceId: 'tbl-1',
      targetId: 'tbl-2',
      condition: 'o.user_id = u.id',
    },
  ];

  it('computeJoinLayoutKey が同入力で同じキーを返す', () => {
    const a = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const b = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    expect(a).toBe(b);
    expect(a).not.toBe(computeJoinLayoutKey(sampleTables, sampleJoins, true));
  });

  it('全ノードに width/height がある（ミニマップ前提）', () => {
    const { nodes } = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    expect(() => assertJoinFlowLayoutReady(nodes)).not.toThrow();
    expect(nodes.every((n) => (n.width ?? 0) > 0 && (n.height ?? 0) > 0)).toBe(true);
  });

  it('派生テーブルはミニマップ色が異なる', () => {
    const derived = {
      id: 'tbl-d',
      table: 'hot',
      alias: 'hot',
      displayName: 'hot (派生)',
      isDerived: true,
    };
    const { nodes } = buildJoinFlowLayout([derived], [], false);
    expect(minimapNodeColor(nodes[0]!)).toBe(MINIMAP_NODE_COLORS.derived);
    expect(minimapNodeColor({ data: { isDerived: false } } as never)).toBe(
      MINIMAP_NODE_COLORS.table,
    );
  });

  it('ミニマップ色が背景と同色にならない', () => {
    expect(MINIMAP_NODE_COLORS.table).not.toBe('#282c34');
    expect(MINIMAP_NODE_COLORS.derived).not.toBe('#1a1d23');
  });

  it('SAMPLE_SQL 解析結果で JOIN 図レイアウトが生成できる', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { nodes, edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );
    expect(nodes.length).toBe(6);
    expect(edges.length).toBe(5);
    expect(() => assertJoinFlowLayoutReady(nodes)).not.toThrow();
  });

  it('SAMPLE_SQL で実質 INNER JOIN の LEFT JOIN エッジを破線・≈INNER ラベルで示す', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
      result.query,
    );

    const oiJoin = result.query.joins.find((j) => j.condition.includes('oi.order_id'));
    expect(oiJoin).toBeDefined();

    const oiEdge = edges.find((e) => e.id === oiJoin!.id);
    expect(oiEdge?.data?.effectiveInner).toBe(true);
    expect(oiEdge?.label).toContain('≈INNER');
    expect(oiEdge?.style?.strokeDasharray).toBe('7 4');
    expect(oiEdge?.animated).toBe(true);

    const cJoin = result.query.joins.find((j) => j.condition.includes('p.category_id'));
    const cEdge = edges.find((e) => e.id === cJoin!.id);
    expect(cEdge?.data?.effectiveInner).toBeFalsy();
  });

  it('query 未指定時は実質 INNER JOIN 表示を付けない', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false);
    expect(edges.every((e) => !e.data?.effectiveInner)).toBe(true);
  });

  it('layoutKey が変わらない限り buildJoinFlowLayout の node id 列は安定', () => {
    const key = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const a = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    const b = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    expect(computeJoinLayoutKey(sampleTables, sampleJoins, false)).toBe(key);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
  });

  describe('実質 INNER JOIN のエッジ表示', () => {
    it('computeJoinLayoutKey は query 指定時に effectiveInner 状態を反映する', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const withoutQuery = computeJoinLayoutKey(result.query.tables, result.query.joins, false);
      const withQuery = computeJoinLayoutKey(result.query.tables, result.query.joins, false, result.query);
      expect(withoutQuery).not.toBe(withQuery);
    });

    it('WHERE のみでも query 指定時は effectiveInner エッジになる', () => {
      const result = parseMySqlQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const leftJoin = result.query.joins.find((j) => j.type === 'LEFT JOIN')!;
      const edge = edges.find((e) => e.id === leftJoin.id);

      expect(edge?.data?.effectiveInner).toBe(true);
      expect(edge?.label).toContain('≈INNER');
      expect(edge?.style?.stroke).toBe('#6b9fd4');
    });

    it('通常の INNER JOIN エッジは effectiveInner にならない', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const innerJoin = result.query.joins.find((j) => j.type === 'INNER JOIN' && j.condition.includes('o.user_id'))!;
      const edge = edges.find((e) => e.id === innerJoin.id);

      expect(edge?.data?.effectiveInner).toBe(false);
      expect(edge?.label).toBe('INNER JOIN');
      expect(edge?.style?.strokeDasharray).toBeUndefined();
    });

    it('SAMPLE_SQL では effectiveInner な LEFT JOIN は1本のみ', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { edges } = buildJoinFlowLayout(result.query.tables, result.query.joins, false, result.query);
      const effectiveEdges = edges.filter((e) => e.data?.effectiveInner);
      expect(effectiveEdges).toHaveLength(1);
      expect(effectiveEdges[0]?.label).toContain('LEFT JOIN');
    });
  });
});
