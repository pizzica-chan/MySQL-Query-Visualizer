import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import type { JoinEdge, TableRef } from '../lib/types';
import { formatTableLabel } from '../lib/alias-resolver';

interface JoinDiagramProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact?: boolean;
}

const JOIN_COLORS: Record<string, string> = {
  'INNER JOIN': '#3b82f6',
  'LEFT JOIN': '#10b981',
  'RIGHT JOIN': '#f59e0b',
  'FULL JOIN': '#8b5cf6',
  'CROSS JOIN': '#ef4444',
  JOIN: '#3b82f6',
};

interface TableNodeData extends Record<string, unknown> {
  label: string;
  table: string;
  schema?: string;
  alias?: string;
  aliasNote?: string;
  isDerived?: boolean;
}

function TableNode({ data: raw }: NodeProps) {
  const data = raw as TableNodeData;
  return (
    <div className="table-node">
      <Handle type="target" position={Position.Left} className="table-handle" />
      <div className="table-node-header">{data.isDerived ? 'DERIVED' : 'TABLE'}</div>
      <div className="table-node-name">{data.table}</div>
      {data.schema && <div className="table-node-schema">{data.schema}</div>}
      {data.aliasNote && (
        <div className="table-node-alias">
          エイリアス: <span>{data.aliasNote}</span>
        </div>
      )}
      {!data.aliasNote && data.alias && (
        <div className="table-node-alias">
          AS <span>{data.alias}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="table-handle" />
    </div>
  );
}

const nodeTypes = { tableNode: TableNode };

function buildLayout(
  tables: TableRef[],
  joins: JoinEdge[],
  resolveAliases: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = tables.map((t, i) => {
    const label = formatTableLabel(t, resolveAliases);
    return {
      id: t.id,
      type: 'tableNode',
      position: { x: i * 280, y: 80 + (i % 2) * 60 },
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

export function JoinDiagram({ tables, joins, resolveAliases, compact = false }: JoinDiagramProps) {
  if (tables.length === 0) {
    return (
      <div className="empty-state">
        <p>FROM句にテーブルが見つかりません</p>
      </div>
    );
  }

  const { nodes, edges } = buildLayout(tables, joins, resolveAliases);

  return (
    <div className={`join-diagram${compact ? ' join-diagram--compact' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#334155" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor="#1e293b"
          maskColor="rgba(15, 23, 42, 0.75)"
          style={{ background: '#0f172a' }}
        />
      </ReactFlow>

      {joins.length > 0 && !compact && (
        <div className="join-conditions-panel">
          <h3>JOIN 条件</h3>
          <ul>
            {joins.map((j) => (
              <li key={j.id}>
                <span
                  className="join-type-badge"
                  style={{ borderColor: JOIN_COLORS[j.type], color: JOIN_COLORS[j.type] }}
                >
                  {j.type}
                </span>
                <span className="join-tables">
                  {tables.find((t) => t.id === j.sourceId)?.displayName}
                  {' → '}
                  {tables.find((t) => t.id === j.targetId)?.displayName}
                </span>
                <code className="join-condition">{j.condition}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
