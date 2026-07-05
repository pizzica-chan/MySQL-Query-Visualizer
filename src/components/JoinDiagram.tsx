import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useJoinFlowState } from '../hooks/useJoinFlowState';
import { MINIMAP_NODE_COLORS, JOIN_EDGE_COLORS, minimapNodeColor, type JoinFlowNodeData } from '../lib/join-flow-layout';
import type { JoinEdge, TableRef } from '../lib/types';

interface JoinDiagramProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact?: boolean;
}

const JOIN_COLORS = JOIN_EDGE_COLORS;

function TableNode({ data: raw }: NodeProps) {
  const data = raw as JoinFlowNodeData;
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

interface JoinDiagramFlowProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact: boolean;
}

/** フックを使う内部コンポーネント — 条件分岐の後に置き、Rules of Hooks を守る */
function JoinDiagramFlow({ tables, joins, resolveAliases, compact }: JoinDiagramFlowProps) {
  const { flowNodes, flowEdges, onNodesChange, onEdgesChange } = useJoinFlowState(
    tables,
    joins,
    resolveAliases,
  );

  return (
    <div className={`join-diagram${compact ? ' join-diagram--compact' : ''}`}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background color="#3a4049" gap={20} />
        <Controls showInteractive={false} />
        {compact ? (
          <MiniMap
            nodeColor={minimapNodeColor}
            nodeStrokeColor={MINIMAP_NODE_COLORS.stroke}
            nodeBorderRadius={2}
            maskColor="rgba(26, 29, 35, 0.65)"
            style={{ background: '#282c34', width: 72, height: 48 }}
            className="join-minimap join-minimap--compact"
            zoomable={false}
            pannable={false}
          />
        ) : (
          <MiniMap
            nodeColor={minimapNodeColor}
            nodeStrokeColor={MINIMAP_NODE_COLORS.stroke}
            nodeBorderRadius={2}
            maskColor="rgba(26, 29, 35, 0.65)"
            style={{ background: '#282c34' }}
            className="join-minimap"
          />
        )}
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

export function JoinDiagram({ tables, joins, resolveAliases, compact = false }: JoinDiagramProps) {
  if (tables.length === 0) {
    return (
      <div className="empty-state">
        <p>FROM句にテーブルが見つかりません</p>
      </div>
    );
  }

  return (
    <JoinDiagramFlow
      tables={tables}
      joins={joins}
      resolveAliases={resolveAliases}
      compact={compact}
    />
  );
}
