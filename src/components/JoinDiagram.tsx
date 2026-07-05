import { type MouseEvent, type ReactNode, useCallback } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { JoinFlowEdge } from './JoinFlowEdge';
import { SourceLinkContext, useSourceLink } from '../contexts/source-link-context';
import { useJoinFlowState } from '../hooks/useJoinFlowState';
import { effectiveInnerAnalysisByJoinId } from '../lib/join-effective-inner';
import {
  JOIN_EDGE_COLORS,
  MINIMAP_NODE_COLORS,
  minimapNodeColor,
  type JoinFlowNodeData,
} from '../lib/join-flow-layout';
import { sourceSelectableProps, toggleSourceSpan, type OnSourceSpanSelect } from '../lib/source-link';
import type { JoinEdge, ParsedQuery, SourceSpan, TableRef } from '../lib/types';

interface JoinDiagramProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact?: boolean;
  query?: ParsedQuery;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}

const JOIN_COLORS = JOIN_EDGE_COLORS;

function TableNode({ data: raw }: NodeProps) {
  const data = raw as JoinFlowNodeData;
  const { activeSourceSpan, onSourceSpanSelect } = useSourceLink();
  const selectable = onSourceSpanSelect
    ? sourceSelectableProps(data.sourceSpan, activeSourceSpan, onSourceSpanSelect, 'table-node nopan')
    : { className: 'table-node' };

  return (
    <div {...selectable}>
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
const edgeTypes = { joinEdge: JoinFlowEdge };

interface JoinDiagramFlowProps {
  tables: TableRef[];
  joins: JoinEdge[];
  resolveAliases: boolean;
  compact: boolean;
  query?: ParsedQuery;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}

function JoinDiagramFlow({
  tables,
  joins,
  resolveAliases,
  compact,
  query,
  activeSourceSpan = null,
  onSourceSpanSelect,
}: JoinDiagramFlowProps) {
  const effectiveInnerByJoin = query ? effectiveInnerAnalysisByJoinId(query) : new Map();
  const hasEffectiveInner = effectiveInnerByJoin.size > 0;

  const { flowNodes, flowEdges, onNodesChange, onEdgesChange } = useJoinFlowState(
    tables,
    joins,
    resolveAliases,
    query,
    compact,
  );

  const handleNodeClick = useCallback(
    (_event: MouseEvent, node: Node) => {
      if (!onSourceSpanSelect) return;
      const span = (node.data as JoinFlowNodeData).sourceSpan;
      toggleSourceSpan(span, activeSourceSpan, onSourceSpanSelect);
    },
    [activeSourceSpan, onSourceSpanSelect],
  );

  return (
    <div className={`join-diagram${compact ? ' join-diagram--compact' : ''}`}>
      <SourceLinkContextProvider
        activeSourceSpan={activeSourceSpan}
        onSourceSpanSelect={onSourceSpanSelect}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
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
      </SourceLinkContextProvider>

      {hasEffectiveInner && !compact && (
        <div className="join-diagram-legend" aria-label="JOIN 図の凡例">
          <span className="join-legend-line join-legend-line--effective-inner" aria-hidden />
          <span className="join-legend-text">
            破線の青 = 実質 INNER JOIN 相当（LEFT/RIGHT JOIN が後続条件で無効化）
          </span>
        </div>
      )}

      {joins.length > 0 && !compact && (
        <div className="join-conditions-panel">
          <h3>JOIN 条件</h3>
          <ul>
            {joins.map((j) => {
              const effectiveInner = effectiveInnerByJoin.has(j.id);
              const edgeColor = effectiveInner
                ? JOIN_COLORS['INNER JOIN']
                : JOIN_COLORS[j.type];
              const conditionProps = onSourceSpanSelect
                ? sourceSelectableProps(
                    j.sourceSpan,
                    activeSourceSpan,
                    onSourceSpanSelect,
                    'join-condition',
                  )
                : { className: 'join-condition' };
              return (
                <li key={j.id}>
                  <span
                    className={`join-type-badge${effectiveInner ? ' join-type-badge--effective-inner' : ''}`}
                    style={{ borderColor: edgeColor, color: edgeColor }}
                  >
                    {effectiveInner ? `${j.type} ≈INNER` : j.type}
                  </span>
                  {effectiveInner && (
                    <span className="join-effective-inner-tag">実質 INNER</span>
                  )}
                  <span className="join-tables">
                    {tables.find((t) => t.id === j.sourceId)?.displayName}
                    {' → '}
                    {tables.find((t) => t.id === j.targetId)?.displayName}
                  </span>
                  <code {...conditionProps}>{j.condition}</code>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceLinkContextProvider({
  activeSourceSpan,
  onSourceSpanSelect,
  children,
}: {
  activeSourceSpan: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  children: ReactNode;
}) {
  return (
    <SourceLinkContext.Provider value={{ activeSourceSpan, onSourceSpanSelect }}>
      {children}
    </SourceLinkContext.Provider>
  );
}

export function JoinDiagram({
  tables,
  joins,
  resolveAliases,
  compact = false,
  query,
  activeSourceSpan = null,
  onSourceSpanSelect,
}: JoinDiagramProps) {
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
      query={query}
      activeSourceSpan={activeSourceSpan}
      onSourceSpanSelect={onSourceSpanSelect}
    />
  );
}
