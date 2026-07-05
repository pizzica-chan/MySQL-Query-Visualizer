import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { truncateJoinCondition, computeJoinEdgeLabelOffset, type JoinFlowEdgeData } from '../lib/join-flow-layout';

export function JoinFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const edgeData = (data ?? {}) as JoinFlowEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const color = (style?.stroke as string | undefined) ?? '#64748b';
  const typeLines = [edgeData.joinType ?? 'JOIN'];
  if (edgeData.effectiveInner) typeLines.push('≈INNER');
  const condition = edgeData.condition?.trim() ?? '';
  const showCondition = !edgeData.compact && condition.length > 0;
  const labelOffset = computeJoinEdgeLabelOffset(
    sourceX,
    sourceY,
    targetX,
    targetY,
    44,
    edgeData.labelOffsetFlip ?? 1,
  );
  const labelPosX = labelX + labelOffset.x;
  const labelPosY = labelY + labelOffset.y;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="join-edge-labels nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPosX}px,${labelPosY}px)`,
            pointerEvents: 'none',
          }}
        >
          <div
            className={`join-edge-type-label${edgeData.effectiveInner ? ' join-edge-type-label--effective-inner' : ''}`}
            style={{ borderColor: color, color }}
          >
            {typeLines.map((line) => (
              <span key={line} className="join-edge-type-line">
                {line}
              </span>
            ))}
          </div>
          {showCondition && (
            <div className="join-edge-condition-label">{truncateJoinCondition(condition)}</div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
