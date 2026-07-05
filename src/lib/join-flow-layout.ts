import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import { effectiveInnerAnalysisByJoinId } from './join-effective-inner';
import type { JoinEdge, ParsedQuery, TableRef } from './types';
import { formatTableLabel } from './alias-resolver';

/** React Flow ミニマップ用 — 背景と区別できる控えめな色 */
export const MINIMAP_NODE_COLORS = {
  table: '#6b9fd4',
  derived: '#d4b06a',
  stroke: '#626c7e',
} as const;

export const JOIN_EDGE_COLORS: Record<string, string> = {
  'INNER JOIN': '#6b9fd4',
  'LEFT JOIN': '#7db88a',
  'RIGHT JOIN': '#d4b06a',
  'FULL JOIN': '#a89fd4',
  'CROSS JOIN': '#d47a7a',
  JOIN: '#6b9fd4',
};

const JOIN_COLORS = JOIN_EDGE_COLORS;

export interface JoinFlowEdgeData extends Record<string, unknown> {
  condition: string;
  joinType: string;
  effectiveInner?: boolean;
  compact?: boolean;
}

export const EFFECTIVE_INNER_EDGE_STYLE = {
  strokeDasharray: '7 4',
} as const;

export function isEffectiveInnerJoin(
  joinId: string,
  effectiveInnerByJoinId: Map<string, { joinId: string }>,
): boolean {
  return effectiveInnerByJoinId.has(joinId);
}

const JOIN_EDGE_CONDITION_MAX_LEN = 56;

export function truncateJoinCondition(condition: string, maxLength = JOIN_EDGE_CONDITION_MAX_LEN): string {
  const trimmed = condition.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

/** 図上の JOIN 種別ラベル（ON 条件は別ボックス — JoinFlowEdge） */
export function formatJoinEdgeLabel(join: JoinEdge, effectiveInner: boolean): string {
  const lines: string[] = [join.type];
  if (effectiveInner) lines.push('≈INNER');
  return lines.join('\n');
}

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
  query?: ParsedQuery,
  compact = false,
): string {
  const effectiveInnerKey = query
    ? [...effectiveInnerAnalysisByJoinId(query).keys()].sort().join(',')
    : '';
  return `${tables.map((t) => t.id).join('|')}:${joins.map((j) => j.id).join('|')}:${resolveAliases}:${effectiveInnerKey}:${compact}`;
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
  query?: ParsedQuery,
  compact = false,
): { nodes: Node[]; edges: Edge[] } {
  const effectiveInnerByJoinId = query ? effectiveInnerAnalysisByJoinId(query) : new Map();

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
    const effectiveInner = isEffectiveInnerJoin(j.id, effectiveInnerByJoinId);
    const baseColor = JOIN_COLORS[j.type] ?? '#64748b';
    const color = effectiveInner ? (JOIN_COLORS['INNER JOIN'] ?? baseColor) : baseColor;
    return {
      id: j.id,
      type: 'joinEdge',
      source: j.sourceId,
      target: j.targetId,
      // animated は React Flow が path に stroke-dasharray を付ける — 実質 INNER のみ
      animated: effectiveInner,
      style: {
        stroke: color,
        strokeWidth: effectiveInner ? 2.5 : 2,
        ...(effectiveInner ? EFFECTIVE_INNER_EDGE_STYLE : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      data: {
        condition: j.condition,
        joinType: j.type,
        effectiveInner,
        compact,
      } satisfies JoinFlowEdgeData,
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
