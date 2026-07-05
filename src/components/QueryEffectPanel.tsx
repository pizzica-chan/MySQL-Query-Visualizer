import type { ConditionEffectNode, QueryEffectSection } from '../lib/query-effect';
import { buildQueryEffect, buildUnionQueryEffect } from '../lib/query-effect';
import type { ParsedQuery } from '../lib/types';
import { EffectHighlightedText } from './EffectHighlightedText';

function ConditionEffectTree({
  node,
  query,
}: {
  node: ConditionEffectNode;
  query: ParsedQuery;
}) {
  if (node.type === 'leaf') {
    return (
      <div className="effect-condition-leaf">
        <EffectHighlightedText text={node.text ?? ''} query={query} />
      </div>
    );
  }

  return (
    <div className={`effect-condition-group effect-condition-group--${node.type}`}>
      <div className="effect-condition-group-label">{node.label}</div>
      <div className="effect-condition-group-body">
        {node.children?.map((child, index) => (
          <div key={child.id} className="effect-condition-group-item">
            {index > 0 && node.type !== 'not' && (
              <div className={`effect-condition-op effect-condition-op--${node.type}`}>
                {node.type.toUpperCase()}
              </div>
            )}
            <ConditionEffectTree node={child} query={query} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EffectSection({ section, query }: { section: QueryEffectSection; query: ParsedQuery }) {
  return (
    <div className={`query-effect-section query-effect-section--${section.kind}`}>
      {section.title && <h4 className="query-effect-section-title">{section.title}</h4>}
      {section.lines && section.lines.length > 0 && (
        <ul className="query-effect-lines">
          {section.lines.map((line, index) => (
            <li key={index} className="query-effect-line">
              <EffectHighlightedText text={line} query={query} />
            </li>
          ))}
        </ul>
      )}
      {section.conditionRoot && <ConditionEffectTree node={section.conditionRoot} query={query} />}
    </div>
  );
}

interface QueryEffectPanelProps {
  query: ParsedQuery;
  branchIndex?: number;
}

export function QueryEffectPanel({ query, branchIndex }: QueryEffectPanelProps) {
  const effect = buildQueryEffect(query);

  return (
    <section className={`query-effect query-effect--${effect.action}`}>
      <div className="query-effect-header">
        <span className={`query-effect-badge query-effect-badge--${effect.action}`}>
          {effect.actionLabel}
        </span>
        {branchIndex !== undefined && (
          <span className="query-effect-branch">ブランチ {branchIndex + 1}</span>
        )}
        <p className="query-effect-summary">
          <EffectHighlightedText text={effect.summary} query={query} />
        </p>
      </div>
      {effect.sections.length > 0 && (
        <div className="query-effect-sections">
          {effect.sections.map((section, index) => (
            <EffectSection key={`${section.kind}-${index}`} section={section} query={query} />
          ))}
        </div>
      )}
    </section>
  );
}

interface QueryEffectBannerProps {
  query: ParsedQuery;
}

export function QueryEffectBanner({ query }: QueryEffectBannerProps) {
  const unionEffect = buildUnionQueryEffect(query);

  if (unionEffect && query.unionBranches) {
    return (
      <div className="query-effect-banner">
        <div className="query-effect-banner-header">
          <h2 className="query-effect-banner-title">対象レコード</h2>
          <p className="query-effect-banner-desc">
            UNION の各 SELECT が返す行の条件です（ブランチごとに独立）
          </p>
        </div>
        {unionEffect.unionNotes.length > 0 && (
          <ul className="query-effect-lines query-effect-union-notes">
            {unionEffect.unionNotes.map((line, index) => (
              <li key={index} className="query-effect-line">
                <EffectHighlightedText text={line} query={query} />
              </li>
            ))}
          </ul>
        )}
        {unionEffect.branches.map((branch, index) => (
          <div key={`branch-${index}`} className="query-effect-banner-branch">
            {index > 0 && branch.operator && (
              <div className="union-connector">{branch.operator}</div>
            )}
            <QueryEffectPanel query={query.unionBranches![index]!.query} branchIndex={index} />
          </div>
        ))}
      </div>
    );
  }

  const actionWord =
    query.statementType === 'SELECT' ? '表示' : query.statementType === 'UPDATE' ? '更新' : '削除';

  return (
    <div className="query-effect-banner">
      <div className="query-effect-banner-header">
        <h2 className="query-effect-banner-title">対象レコード</h2>
        <p className="query-effect-banner-desc">この SQL で{actionWord}される行の条件</p>
      </div>
      <QueryEffectPanel query={query} />
    </div>
  );
}
