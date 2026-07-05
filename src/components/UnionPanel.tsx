import type { ReactNode } from 'react';
import type { ParsedQuery, SourceSpan, UnionBranch } from '../lib/types';
import type { OnSourceSpanSelect } from '../lib/source-link';
import { JoinDiagram } from './JoinDiagram';
import { QuerySummary } from './QuerySummary';
import { SubqueryDetail } from './SubqueryDetail';
import { WhereTree } from './WhereTree';

interface UnionPanelProps {
  branches: UnionBranch[];
  resolveAliases: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
  isActive?: boolean;
}

interface NestedPanelProps {
  query: ParsedQuery;
  resolveAliases: boolean;
}

interface UnionBranchShellProps {
  branches: UnionBranch[];
  title: string;
  description: string;
  singleBranch: (branch: UnionBranch) => ReactNode;
  renderBranch: (branch: UnionBranch, index: number) => ReactNode;
}

function UnionBranchShell({
  branches,
  title,
  description,
  singleBranch,
  renderBranch,
}: UnionBranchShellProps) {
  if (branches.length <= 1) {
    const branch = branches[0];
    if (!branch) return null;
    return singleBranch(branch);
  }

  return (
    <div className="union-panel">
      <div className="union-panel-header">
        <h3>
          {title} ({branches.length})
        </h3>
        <p>{description}</p>
      </div>
      {branches.map((branch, index) => (
        <div key={branch.id} className="union-branch">
          {index > 0 && branch.operator && (
            <div className="union-connector">{branch.operator}</div>
          )}
          {renderBranch(branch, index)}
        </div>
      ))}
    </div>
  );
}

function BranchSectionTitle({ index }: { index: number }) {
  return <h4 className="union-branch-section-title">ブランチ {index + 1}</h4>;
}

function BranchWherePanel({
  query,
  resolveAliases,
  activeSourceSpan,
  onSourceSpanSelect,
}: {
  query: ParsedQuery;
  resolveAliases: boolean;
  activeSourceSpan?: SourceSpan | null;
  onSourceSpanSelect?: OnSourceSpanSelect;
}) {
  return (
    <div className="where-panel">
      <WhereTree
        root={query.where}
        title="WHERE"
        nested
        resolveAliases={resolveAliases}
        activeSourceSpan={activeSourceSpan}
        onSourceSpanSelect={onSourceSpanSelect}
      />
      {query.having && (
        <div className="having-section">
          <WhereTree
            root={query.having}
            title="HAVING"
            nested
            resolveAliases={resolveAliases}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
          />
        </div>
      )}
    </div>
  );
}

export function UnionJoinPanel({
  branches,
  resolveAliases,
  activeSourceSpan,
  onSourceSpanSelect,
  isActive = true,
}: UnionPanelProps) {
  return (
    <UnionBranchShell
      branches={branches}
      title="UNION 全ブランチ"
      description="各 SELECT の FROM / JOIN を個別に表示しています"
      singleBranch={(branch) => (
        <JoinDiagram
          tables={branch.query.tables}
          joins={branch.query.joins}
          resolveAliases={resolveAliases}
          query={branch.query}
          activeSourceSpan={activeSourceSpan}
          onSourceSpanSelect={onSourceSpanSelect}
          isActive={isActive}
        />
      )}
      renderBranch={(branch, index) => (
        <div className="union-branch-section">
          <BranchSectionTitle index={index} />
          <JoinDiagram
            tables={branch.query.tables}
            joins={branch.query.joins}
            resolveAliases={resolveAliases}
            query={branch.query}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
            isActive={isActive}
          />
        </div>
      )}
    />
  );
}

export function UnionWherePanel({
  branches,
  resolveAliases,
  activeSourceSpan,
  onSourceSpanSelect,
}: UnionPanelProps) {
  return (
    <UnionBranchShell
      branches={branches}
      title="UNION 全ブランチ"
      description="各 SELECT の WHERE / HAVING を個別に表示しています"
      singleBranch={(branch) => (
        <BranchWherePanel
          query={branch.query}
          resolveAliases={resolveAliases}
          activeSourceSpan={activeSourceSpan}
          onSourceSpanSelect={onSourceSpanSelect}
        />
      )}
      renderBranch={(branch, index) => (
        <div className="union-branch-section">
          <BranchSectionTitle index={index} />
          <BranchWherePanel
            query={branch.query}
            resolveAliases={resolveAliases}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
          />
        </div>
      )}
    />
  );
}

export function UnionSummaryPanel({
  branches,
  resolveAliases,
  activeSourceSpan,
  onSourceSpanSelect,
}: UnionPanelProps) {
  return (
    <UnionBranchShell
      branches={branches}
      title="UNION 全ブランチ"
      description="各 SELECT の概要を個別に表示しています"
      singleBranch={(branch) => (
        <QuerySummary
          query={branch.query}
          resolveAliases={resolveAliases}
          activeSourceSpan={activeSourceSpan}
          onSourceSpanSelect={onSourceSpanSelect}
        />
      )}
      renderBranch={(branch, index) => (
        <div className="union-branch-section">
          <BranchSectionTitle index={index} />
          <QuerySummary
            query={branch.query}
            resolveAliases={resolveAliases}
            activeSourceSpan={activeSourceSpan}
            onSourceSpanSelect={onSourceSpanSelect}
          />
        </div>
      )}
    />
  );
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
