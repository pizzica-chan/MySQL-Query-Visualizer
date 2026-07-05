import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useSourceLink } from '../contexts/source-link-context';
import { sourceSelectableProps } from '../lib/source-link';
import {
  truncateJoinCondition,
  computeJoinEdgeLabelOffset,
  type JoinFlowEdgeData,
} from '../lib/join-flow-layout';

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
  const { activeSourceSpan, onSourceSpanSelect } = useSourceLink();
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
  const showCondition =
    !edgeData.compact && !edgeData.isFanInConnector && condition.length > 0;
  const showTypeLabel = !edgeData.isFanInConnector;
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
  const interactive = Boolean(onSourceSpanSelect && edgeData.sourceSpan);
  const typeLabelClass = `join-edge-type-label${
    edgeData.effectiveInner ? ' join-edge-type-label--effective-inner' : ''
  }`;
  const labelColorStyle = { borderColor: color, color };
  const typeLabelProps = interactive
    ? sourceSelectableProps(
        edgeData.sourceSpan,
        activeSourceSpan,
        onSourceSpanSelect!,
        `${typeLabelClass} nopan`,
      )
    : { className: typeLabelClass };
  const conditionLabelProps = interactive
    ? sourceSelectableProps(
        edgeData.sourceSpan,
        activeSourceSpan,
        onSourceSpanSelect!,
        'join-edge-condition-label nopan',
      )
    : { className: 'join-edge-condition-label' };

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        {showTypeLabel && (
        <div
          className={`join-edge-labels nodrag nopan${interactive ? ' join-edge-labels--interactive' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPosX}px,${labelPosY}px)`,
          }}
        >
          <div {...typeLabelProps} style={labelColorStyle}>
            {typeLines.map((line) => (
              <span key={line} className="join-edge-type-line">
                {line}
              </span>
            ))}
          </div>
          {showCondition && (
            <div {...conditionLabelProps}>{truncateJoinCondition(condition)}</div>
          )}
        </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
