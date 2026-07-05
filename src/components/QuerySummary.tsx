import type { DeleteTarget, ParsedQuery, SourceSpan, TableRef } from '../lib/types';
import { countNestedItems, formatUnionBranches, hasUnion, isUpdateTargetTable } from '../lib/query-utils';
import { sourceSelectableProps, type OnSourceSpanSelect } from '../lib/source-link';

interface QuerySummaryProps {
  query: ParsedQuery;
  resolveAliases: boolean;
  compact?: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}

function isDeleteTargetTable(table: TableRef, targets: DeleteTarget[] | undefined): boolean {
  if (!targets?.length) return false;
  return targets.some(
    (d) =>
      d.name === table.alias ||
      d.name === table.table ||
      d.name === table.displayName ||
      d.label === table.displayName,
  );
}

export function QuerySummary({
  query,
  resolveAliases,
  compact = false,
  activeSourceSpan = null,
  onSourceSpanSelect,
}: QuerySummaryProps) {
  const isSelect = query.statementType === 'SELECT';
  const isUpdate = query.statementType === 'UPDATE';
  const isDelete = query.statementType === 'DELETE';
  const { unions, subqueries } = countNestedItems(query);
  const selectProps = (span: SourceSpan | undefined, className: string) =>
    onSourceSpanSelect
      ? sourceSelectableProps(span, activeSourceSpan, onSourceSpanSelect, className)
      : { className };

  return (
    <div className="query-summary">
      <section className="summary-section">
        <h3>SQL構造</h3>
        <dl className="summary-grid">
          <dt>文の種類</dt>
          <dd>
            {query.statementType}
            {isSelect && query.distinct ? ' DISTINCT' : ''}
          </dd>
          <dt>テーブル数</dt>
          <dd>{query.tables.length}</dd>
          <dt>JOIN数</dt>
          <dd>{query.joins.length}</dd>
          {isUpdate && (
            <>
              <dt>SET</dt>
              <dd>{query.setClauses?.length ?? 0} 列</dd>
            </>
          )}
          {isDelete && (
            <>
              <dt>削除対象</dt>
              <dd>{query.deleteTargets?.length ?? 0} 件</dd>
            </>
          )}
          <dt>WHERE</dt>
          <dd {...selectProps(query.where?.sourceSpan, query.where ? 'summary-dd-link' : '')}>
            {query.where ? 'あり' : 'なし'}
          </dd>
          {isSelect && (
            <>
              <dt>GROUP BY</dt>
              <dd>{query.groupBy.length > 0 ? `${query.groupBy.length} 列` : 'なし'}</dd>
              <dt>HAVING</dt>
              <dd {...selectProps(query.having?.sourceSpan, query.having ? 'summary-dd-link' : '')}>
                {query.having ? 'あり' : 'なし'}
              </dd>
            </>
          )}
          <dt>ORDER BY</dt>
          <dd>{query.orderBy.length > 0 ? `${query.orderBy.length} 列` : 'なし'}</dd>
          <dt>LIMIT</dt>
          <dd {...selectProps(query.limitSpan, query.limit ? 'summary-dd-link' : '')}>
            {query.limit ?? 'なし'}
          </dd>
          {query.offset && (
            <>
              <dt>OFFSET</dt>
              <dd {...selectProps(query.offsetSpan, 'summary-dd-link')}>{query.offset}</dd>
            </>
          )}
          {isSelect && hasUnion(query) && (
            <>
              <dt>UNION</dt>
              <dd>{unions} ブランチ</dd>
            </>
          )}
          {(subqueries > 0 || unions > 1) && (
            <>
              <dt>サブクエリ</dt>
              <dd>{subqueries} 件</dd>
            </>
          )}
        </dl>
        {isSelect && hasUnion(query) && (
          <p className="summary-union-flow">{formatUnionBranches(query.unionBranches)}</p>
        )}
      </section>

      {isUpdate && query.setClauses && query.setClauses.length > 0 && (
        <section className="summary-section">
          <h3>SET 句 ({query.setClauses.length})</h3>
          <ul className="column-list set-clause-list">
            {query.setClauses.map((set, i) => (
              <li key={i}>
                <code>{set.label}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isDelete && query.deleteTargets && query.deleteTargets.length > 0 && (
        <section className="summary-section">
          <h3>DELETE 対象 ({query.deleteTargets.length})</h3>
          <ul className="tag-list">
            {query.deleteTargets.map((target, i) => (
              <li key={i} className="tag tag--delete">{target.label}</li>
            ))}
          </ul>
        </section>
      )}

      {!compact && (
        <section className="summary-section">
          <h3>テーブル一覧</h3>
          <div className="table-cards">
            {query.tables.map((t) => (
              <div key={t.id} {...selectProps(t.sourceSpan, 'table-card')}>
                <div className="table-card-name">{t.table}</div>
                {t.schema && <div className="table-card-meta">schema: {t.schema}</div>}
                {t.isDerived && (
                  <div className="table-card-meta table-card-meta--derived">派生テーブル（サブクエリ）</div>
                )}
                {t.alias && (
                  <div className="table-card-meta">
                    エイリアス: <strong>{t.alias}</strong>
                    {resolveAliases ? '（実名表示中）' : ''}
                  </div>
                )}
                {isUpdate && isUpdateTargetTable(t, query) && (
                  <div className="table-card-meta table-card-meta--target">更新対象</div>
                )}
                {isDelete && isDeleteTargetTable(t, query.deleteTargets) && (
                  <div className="table-card-meta table-card-meta--delete">削除対象</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isSelect && !compact && (
        <section className="summary-section">
          <h3>SELECT 列 ({query.columns.length})</h3>
          <ul className="column-list">
            {query.columns.map((col, i) => (
              <li key={i} {...selectProps(col.sourceSpan, 'column-list-item')}>
                <code>{col.expression}</code>
                {col.alias && <span className="column-alias"> AS {col.alias}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isSelect && !compact && query.groupBy.length > 0 && (
        <section className="summary-section">
          <h3>GROUP BY</h3>
          <ul className="tag-list">
            {query.groupBy.map((g, i) => (
              <li key={i} {...selectProps(g.sourceSpan, 'tag')}>{g.text}</li>
            ))}
          </ul>
        </section>
      )}

      {!compact && query.orderBy.length > 0 && (
        <section className="summary-section">
          <h3>ORDER BY</h3>
          <ul className="tag-list">
            {query.orderBy.map((o, i) => (
              <li key={i} {...selectProps(o.sourceSpan, 'tag tag--order')}>{o.text}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
