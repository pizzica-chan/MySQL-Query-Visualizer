import type { ParsedQuery, UnionBranch } from '../lib/types';
import { SubqueryDetail } from './SubqueryDetail';

interface UnionPanelProps {
  branches: UnionBranch[];
  resolveAliases: boolean;
}

interface NestedPanelProps {
  query: ParsedQuery;
  resolveAliases: boolean;
}

export function UnionPanel({ branches, resolveAliases }: UnionPanelProps) {
  if (branches.length <= 1) {
    return (
      <div className="empty-state">
        <p>UNION は含まれていません</p>
      </div>
    );
  }

  return (
    <div className="union-panel">
      <div className="union-panel-header">
        <h3>UNION ブランチ ({branches.length})</h3>
        <p>各 SELECT を個別に解析しています</p>
      </div>
      {branches.map((branch, index) => (
        <div key={branch.id} className="union-branch">
          {index > 0 && branch.operator && (
            <div className="union-connector">{branch.operator}</div>
          )}
          <SubqueryDetail
            query={branch.query}
            title={`ブランチ ${index + 1}`}
            resolveAliases={resolveAliases}
          />
        </div>
      ))}
    </div>
  );
}

export function NestedQueriesPanel({ query, resolveAliases }: NestedPanelProps) {
  const derivedTables = query.tables.filter((t) => t.isDerived && t.derivedQuery);

  return (
    <div className="nested-panel">
      {derivedTables.length > 0 && (
        <section className="nested-section">
          <h3>派生テーブル ({derivedTables.length})</h3>
          {derivedTables.map((t) => (
            <SubqueryDetail
              key={t.id}
              query={t.derivedQuery!}
              title={`${t.alias ?? t.table} (FROM句サブクエリ)`}
              resolveAliases={resolveAliases}
            />
          ))}
        </section>
      )}
    </div>
  );
}
