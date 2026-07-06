import { useCallback, useEffect, useMemo, useState } from 'react';
import { JoinDiagram } from './components/JoinDiagram';
import { QueryEffectBanner } from './components/QueryEffectPanel';
import { SqlEditor } from './components/SqlEditor';
import { SampleLoadButtons } from './components/SampleLoadButtons';
import { SubqueryDetail } from './components/SubqueryDetail';
import { UnionJoinPanel } from './components/UnionPanel';
import { applyAliasResolution } from './lib/alias-resolver';
import {
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  parseMySqlQuery,
} from './lib/parser';
import { collectSubqueryRefsExcludingUnionBranches, hasUnion, type SubqueryRef } from './lib/query-utils';
import type { ParsedQuery, SourceSpan } from './lib/types';
import type { OnSourceSpanSelect } from './lib/source-link';

type TabId = 'structure' | 'narrative' | 'joins' | 'nested';

const BASE_TABS: { id: TabId; label: string }[] = [
  { id: 'structure', label: 'SQL構造' },
  { id: 'narrative', label: '作用説明' },
  { id: 'joins', label: 'JOIN 図' },
];

export default function App() {
  const [sql, setSql] = useState('');
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<TabId>('structure');
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
    if (!displayQuery) return { showTab: false, subqueries: [] as SubqueryRef[] };
    const subqueries = collectSubqueryRefsExcludingUnionBranches(displayQuery);
    return {
      showTab: subqueries.length > 0,
      subqueries,
    };
  }, [displayQuery]);

  const tabs = useMemo(() => {
    if (!nestedInfo.showTab) return BASE_TABS;
    return [
      ...BASE_TABS,
      { id: 'nested' as const, label: 'サブクエリ' },
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
      setActiveTab('structure');
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
                {activeTab === 'structure' && (
                  <QueryEffectBanner
                    query={displayQuery}
                    variant="structure"
                    resolveAliases={resolveAliases}
                    {...sourceLinkProps}
                  />
                )}
                {activeTab === 'narrative' && (
                  <QueryEffectBanner query={displayQuery} variant="narrative" resolveAliases={resolveAliases} />
                )}
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
                {activeTab === 'nested' && nestedInfo.showTab && (
                  <div className="nested-tab">
                    <section className="nested-section">
                      <h3>サブクエリ ({nestedInfo.subqueries.length})</h3>
                      <p className="nested-section-desc">
                        WHERE / EXISTS / IN / FROM 句内のサブクエリを個別に解析しています
                      </p>
                      <div className="nested-subquery-list">
                        {nestedInfo.subqueries.map(({ query, title }, index) => (
                          <SubqueryDetail
                            key={`${query.tables.map((t) => t.id).join('-')}-${title}-${index}`}
                            query={query}
                            title={title}
                            resolveAliases={resolveAliases}
                            {...sourceLinkProps}
                          />
                        ))}
                      </div>
                    </section>
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
                MySQL 形式の SELECT / UPDATE / DELETE 文を入力してください。INSERT など上記以外の文種は未対応です。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
