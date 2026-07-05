import { useCallback, useEffect, useMemo, useState } from 'react';
import { JoinDiagram } from './components/JoinDiagram';
import { QueryEffectBanner } from './components/QueryEffectPanel';
import { QuerySummary } from './components/QuerySummary';
import { SqlEditor } from './components/SqlEditor';
import { SampleLoadButtons } from './components/SampleLoadButtons';
import { SubqueryDetail } from './components/SubqueryDetail';
import { WhereTree } from './components/WhereTree';
import { UnionJoinPanel, UnionPanel, UnionSummaryPanel, UnionWherePanel } from './components/UnionPanel';
import { applyAliasResolution } from './lib/alias-resolver';
import {
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  parseMySqlQuery,
} from './lib/parser';
import { collectAllNestedQueries, countNestedItems, hasUnion } from './lib/query-utils';
import type { ParsedQuery, SourceSpan } from './lib/types';
import type { OnSourceSpanSelect } from './lib/source-link';

type TabId = 'effect' | 'joins' | 'where' | 'summary' | 'nested';

const BASE_TABS: { id: TabId; label: string }[] = [
  { id: 'effect', label: '作用説明' },
  { id: 'summary', label: 'SQL構造' },
  { id: 'joins', label: 'JOIN 図' },
  { id: 'where', label: 'WHERE / HAVING' },
];

export default function App() {
  const [sql, setSql] = useState('');
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<TabId>('effect');
  const [resolveAliases, setResolveAliases] = useState(false);
  const [activeSourceSpan, setActiveSourceSpan] = useState<SourceSpan | null>(null);

  const handleSourceSpanSelect: OnSourceSpanSelect = useCallback((span) => {
    setActiveSourceSpan(span ?? null);
  }, []);

  const sourceLinkProps = {
    activeSourceSpan,
    onSourceSpanSelect: handleSourceSpanSelect,
  };

  const displayQuery = useMemo(
    () => (parsed ? applyAliasResolution(parsed, resolveAliases) : null),
    [parsed, resolveAliases],
  );

  const nestedInfo = useMemo(() => {
    if (!displayQuery) return { showTab: false, unionBranches: 0, subqueries: 0, otherNested: [] as ParsedQuery[] };
    const { unions, subqueries } = countNestedItems(displayQuery);
    const unionQuerySet = new Set(displayQuery.unionBranches?.map((b) => b.query) ?? []);
    const otherNested = collectAllNestedQueries(displayQuery).filter((q) => !unionQuerySet.has(q));
    return {
      showTab: unions > 1 || subqueries > 0,
      unionBranches: unions,
      subqueries,
      otherNested,
    };
  }, [displayQuery]);

  const tabs = useMemo(() => {
    if (!nestedInfo.showTab) return BASE_TABS;
    return [
      ...BASE_TABS,
      { id: 'nested' as const, label: 'UNION / サブクエリ' },
    ];
  }, [nestedInfo.showTab]);

  const runParse = useCallback(() => {
    const result = parseMySqlQuery(sql);
    if (result.success) {
      setParsed(result.query);
      setError(undefined);
    } else {
      setParsed(null);
      setError(result.error.message);
    }
  }, [sql]);

  useEffect(() => {
    const timer = setTimeout(runParse, 400);
    return () => clearTimeout(timer);
  }, [sql, runParse]);

  useEffect(() => {
    setActiveSourceSpan(null);
  }, [sql]);

  useEffect(() => {
    if (activeTab === 'nested' && !nestedInfo.showTab) {
      setActiveTab('effect');
    }
  }, [activeTab, nestedInfo.showTab]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">MySQL Query Visualizer</h1>
        </div>
      </header>

      <main className="app-main">
        <section className="panel panel--input">
          <SqlEditor
            value={sql}
            onChange={setSql}
            onLoadSample={() => setSql(SAMPLE_SQL)}
            onLoadUpdateSample={() => setSql(UPDATE_SAMPLE_SQL)}
            onLoadDeleteSample={() => setSql(DELETE_SAMPLE_SQL)}
            onLoadUnionSample={() => setSql(UNION_SAMPLE_SQL)}
            error={error}
            focusSpan={activeSourceSpan}
          />
        </section>

        <section className="panel panel--output">
          {!parsed && !error && (
            <div className="welcome-state">
              <p className="welcome-hint">左のエディタに SQL を入力するか、サンプルを読み込んでください。</p>
              <SampleLoadButtons
                highlightSelect
                onSelect={() => setSql(SAMPLE_SQL)}
                onUpdate={() => setSql(UPDATE_SAMPLE_SQL)}
                onUnion={() => setSql(UNION_SAMPLE_SQL)}
                onDelete={() => setSql(DELETE_SAMPLE_SQL)}
              />
            </div>
          )}

          {parsed && displayQuery && (
            <>
              <div className="display-options">
                <label className="option-toggle">
                  <input
                    type="checkbox"
                    checked={resolveAliases}
                    onChange={(e) => setResolveAliases(e.target.checked)}
                  />
                  <span>エイリアスを実テーブル名で表示</span>
                </label>
              </div>
              <nav className="tab-bar">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`tab${activeTab === tab.id ? ' tab--active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div className="tab-content">
                {activeTab === 'effect' && <QueryEffectBanner query={displayQuery} />}
                <div
                  className={`tab-pane${activeTab === 'joins' ? '' : ' tab-pane--hidden'}`}
                  aria-hidden={activeTab !== 'joins'}
                >
                  {hasUnion(displayQuery) && displayQuery.unionBranches ? (
                    <UnionJoinPanel
                      branches={displayQuery.unionBranches}
                      resolveAliases={resolveAliases}
                      isActive={activeTab === 'joins'}
                      {...sourceLinkProps}
                    />
                  ) : (
                    <JoinDiagram
                      tables={displayQuery.tables}
                      joins={displayQuery.joins}
                      resolveAliases={resolveAliases}
                      query={displayQuery}
                      isActive={activeTab === 'joins'}
                      {...sourceLinkProps}
                    />
                  )}
                </div>
                {activeTab === 'where' &&
                  (hasUnion(displayQuery) && displayQuery.unionBranches ? (
                    <UnionWherePanel
                      branches={displayQuery.unionBranches}
                      resolveAliases={resolveAliases}
                      {...sourceLinkProps}
                    />
                  ) : (
                    <div className="where-panel">
                      <WhereTree
                        root={displayQuery.where}
                        title="WHERE"
                        resolveAliases={resolveAliases}
                        {...sourceLinkProps}
                      />
                      {displayQuery.having && (
                        <div className="having-section">
                          <WhereTree
                            root={displayQuery.having}
                            title="HAVING"
                            resolveAliases={resolveAliases}
                            {...sourceLinkProps}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                {activeTab === 'summary' &&
                  (hasUnion(displayQuery) && displayQuery.unionBranches ? (
                    <UnionSummaryPanel
                      branches={displayQuery.unionBranches}
                      resolveAliases={resolveAliases}
                      {...sourceLinkProps}
                    />
                  ) : (
                    <QuerySummary
                      query={displayQuery}
                      resolveAliases={resolveAliases}
                      {...sourceLinkProps}
                    />
                  ))}
                {activeTab === 'nested' && (
                  <div className="nested-tab">
                    {hasUnion(displayQuery) && displayQuery.unionBranches && (
                      <UnionPanel
                        branches={displayQuery.unionBranches}
                        resolveAliases={resolveAliases}
                      />
                    )}
                    {nestedInfo.otherNested.length > 0 && (
                      <section className="nested-section">
                        <h3>サブクエリ ({nestedInfo.otherNested.length})</h3>
                        <p className="nested-section-desc">
                          WHERE / HAVING / FROM 句内のサブクエリを個別に解析しています
                        </p>
                        {nestedInfo.otherNested.map((nested, index) => (
                          <SubqueryDetail
                            key={`${nested.tables.map((t) => t.id).join('-')}-${index}`}
                            query={nested}
                            title={`サブクエリ ${index + 1}`}
                            resolveAliases={resolveAliases}
                          />
                        ))}
                      </section>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {error && !parsed && (
            <div className="error-state">
              <h2>解析エラー</h2>
              <p className="error-message">{error}</p>
              <p className="error-hint">
                MySQL 形式の SELECT / UPDATE / DELETE 文を入力してください。
                INSERT 文や構文エラーには対応していません。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
