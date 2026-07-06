import type { QueryEffectSection } from '../lib/query-effect';
import { buildQueryEffect, buildUnionQueryEffect } from '../lib/query-effect';
import type { ParsedQuery } from '../lib/types';
import { EffectHighlightedText } from './EffectHighlightedText';
import {
  QueryEffectSectionView,
  type QueryEffectSourceLinkProps,
} from './QueryEffectViews';

interface SourceLinkProps extends QueryEffectSourceLinkProps {}

function EffectSection({
  section,
  query,
  sourceLink,
}: {
  section: QueryEffectSection;
  query: ParsedQuery;
  sourceLink: SourceLinkProps;
}) {
  return <QueryEffectSectionView section={section} query={query} sourceLink={sourceLink} />;
}

interface QueryEffectPanelProps extends SourceLinkProps {
  query: ParsedQuery;
  branchIndex?: number;
}

export function QueryEffectPanel({
  query,
  branchIndex,
  activeSourceSpan = null,
  onSourceSpanSelect,
  resolveAliases = false,
}: QueryEffectPanelProps) {
  const effect = buildQueryEffect(query);
  const sourceLink = { activeSourceSpan, onSourceSpanSelect, resolveAliases };

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
            <EffectSection
              key={`${section.kind}-${index}`}
              section={section}
              query={query}
              sourceLink={sourceLink}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface QueryEffectBannerProps extends SourceLinkProps {
  query: ParsedQuery;
}

export function QueryEffectBanner({
  query,
  activeSourceSpan = null,
  onSourceSpanSelect,
  resolveAliases = false,
}: QueryEffectBannerProps) {
  const unionEffect = buildUnionQueryEffect(query);
  const sourceLinkProps = { activeSourceSpan, onSourceSpanSelect, resolveAliases };

  if (unionEffect && query.unionBranches) {
    return (
      <div className="query-effect-banner">
        <div className="query-effect-banner-header">
          <h2 className="query-effect-banner-title">作用説明</h2>
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
            <QueryEffectPanel
              query={query.unionBranches![index]!.query}
              branchIndex={index}
              {...sourceLinkProps}
            />
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
        <h2 className="query-effect-banner-title">作用説明</h2>
        <p className="query-effect-banner-desc">
          この SQL で{actionWord}される行の条件
        </p>
      </div>
      <QueryEffectPanel query={query} {...sourceLinkProps} />
    </div>
  );
}
