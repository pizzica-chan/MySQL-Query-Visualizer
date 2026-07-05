import { JoinDiagram } from './JoinDiagram';
import { QuerySummary } from './QuerySummary';
import { WhereTree } from './WhereTree';
import type { ParsedQuery } from '../lib/types';

interface SubqueryDetailProps {
  query: ParsedQuery;
  title: string;
  resolveAliases: boolean;
  compact?: boolean;
}

export function SubqueryDetail({
  query,
  title,
  resolveAliases,
  compact = false,
}: SubqueryDetailProps) {
  return (
    <div className={`subquery-detail${compact ? ' subquery-detail--compact' : ''}`}>
      <div className="subquery-detail-header">
        <h4>{title}</h4>
        <span className="subquery-detail-meta">
          {query.tables.length} テーブル · {query.joins.length} JOIN
          {query.where ? ' · WHEREあり' : ''}
        </span>
      </div>

      {query.tables.length > 0 && (
        <div className="subquery-detail-section">
          <JoinDiagram
            tables={query.tables}
            joins={query.joins}
            resolveAliases={resolveAliases}
            compact
          />
        </div>
      )}

      {query.where && (
        <div className="subquery-detail-section">
          <WhereTree root={query.where} title="WHERE" nested />
        </div>
      )}

      {!compact && (
        <div className="subquery-detail-section">
          <QuerySummary query={query} resolveAliases={resolveAliases} compact />
        </div>
      )}
    </div>
  );
}
