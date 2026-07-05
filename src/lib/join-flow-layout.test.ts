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
    expect(MINIMAP_NODE_COLORS.table).not.toBe('#1e293b');
    expect(MINIMAP_NODE_COLORS.derived).not.toBe('#0f172a');
  });

  it('SAMPLE_SQL 解析結果で JOIN 図レイアウトが生成できる', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { nodes, edges } = buildJoinFlowLayout(
      result.query.tables,
      result.query.joins,
      false,
    );
    expect(nodes.length).toBe(6);
    expect(edges.length).toBe(5);
    expect(() => assertJoinFlowLayoutReady(nodes)).not.toThrow();
  });

  it('layoutKey が変わらない限り buildJoinFlowLayout の node id 列は安定', () => {
    const key = computeJoinLayoutKey(sampleTables, sampleJoins, false);
    const a = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    const b = buildJoinFlowLayout(sampleTables, sampleJoins, false);
    expect(computeJoinLayoutKey(sampleTables, sampleJoins, false)).toBe(key);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
  });
});
