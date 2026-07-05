import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type { JoinEdge, TableRef } from './types';
import { formatTableLabel } from './alias-resolver';

/** React Flow ミニマップ用 — 背景 (#1e293b) と区別できる色 */
export const MINIMAP_NODE_COLORS = {
  table: '#3b82f6',
  derived: '#8b5cf6',
  stroke: '#94a3b8',
} as const;

const JOIN_COLORS: Record<string, string> = {
  'INNER JOIN': '#3b82f6',
  'LEFT JOIN': '#10b981',
  'RIGHT JOIN': '#f59e0b',
  'FULL JOIN': '#8b5cf6',
  'CROSS JOIN': '#ef4444',
  JOIN: '#3b82f6',
};

export interface JoinFlowNodeData extends Record<string, unknown> {
  label: string;
  table: string;
  schema?: string;
  alias?: string;
  aliasNote?: string;
  isDerived?: boolean;
}

/** JOIN 図のレイアウト変更検知用 — useEffect の依存はこれだけに限定する */
export function computeJoinLayoutKey(
  tables: TableRef[],
  joins: JoinEdge[],
  resolveAliases: boolean,
): string {
  return `${tables.map((t) => t.id).join('|')}:${joins.map((j) => j.id).join('|')}:${resolveAliases}`;
}

export function minimapNodeColor(node: Node): string {
  const data = node.data as JoinFlowNodeData;
  return data.isDerived ? MINIMAP_NODE_COLORS.derived : MINIMAP_NODE_COLORS.table;
}

/** JOIN 図のノード・エッジを生成（純粋関数 — コンポーネント外でテスト可能） */
export function buildJoinFlowLayout(
  tables: TableRef[],
  joins: JoinEdge[],
  resolveAliases: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = tables.map((t, i) => {
    const label = formatTableLabel(t, resolveAliases);
    const hasExtraLine = Boolean(t.schema || t.alias || label.aliasNote);
    return {
      id: t.id,
      type: 'tableNode',
      position: { x: i * 280, y: 80 + (i % 2) * 60 },
      // ミニマップ表示に必須（onNodesChange による計測前のフォールバック）
      width: 176,
      height: hasExtraLine ? 108 : 88,
      data: {
        label: label.primary,
        table: t.table,
        schema: t.schema,
        alias: t.alias,
        aliasNote: label.aliasNote,
        isDerived: t.isDerived,
      },
    };
  });

  const edges: Edge[] = joins.map((j) => {
    const color = JOIN_COLORS[j.type] ?? '#64748b';
    return {
      id: j.id,
      source: j.sourceId,
      target: j.targetId,
      label: j.type,
      animated: j.type === 'INNER JOIN' || j.type === 'JOIN',
      style: { stroke: color, strokeWidth: 2 },
      labelStyle: { fill: color, fontWeight: 600, fontSize: 11 },
      labelBgStyle: { fill: '#0f172a', fillOpacity: 0.85 },
      labelBgPadding: [6, 4] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      data: { condition: j.condition },
    };
  });

  return { nodes, edges };
}

/** ミニマップ表示の前提条件（回帰テスト用） */
export function assertJoinFlowLayoutReady(nodes: Node[]): void {
  if (nodes.length === 0) return;
  for (const node of nodes) {
    if (!node.width || !node.height) {
      throw new Error(`node ${node.id} missing width/height for minimap`);
    }
    if (node.width <= 0 || node.height <= 0) {
      throw new Error(`node ${node.id} has invalid dimensions`);
    }
  }
}
