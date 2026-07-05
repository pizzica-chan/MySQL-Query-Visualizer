import { useCallback, useEffect, useMemo, useState } from 'react';
import { JoinDiagram } from './components/JoinDiagram';
import { QuerySummary } from './components/QuerySummary';
import { SqlEditor } from './components/SqlEditor';
import { SubqueryDetail } from './components/SubqueryDetail';
import { WhereTree } from './components/WhereTree';
import { UnionPanel } from './components/UnionPanel';
import { applyAliasResolution } from './lib/alias-resolver';
import {
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  parseMySqlQuery,
} from './lib/parser';
import { collectAllNestedQueries, countNestedItems, hasUnion } from './lib/query-utils';
import type { ParsedQuery } from './lib/types';

type TabId = 'joins' | 'where' | 'summary' | 'nested';

const BASE_TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'joins', label: 'JOIN 図', icon: '🔗' },
  { id: 'where', label: 'WHERE / HAVING', icon: '🌳' },
  { id: 'summary', label: '概要', icon: '📋' },
];

export default function App() {
  const [sql, setSql] = useState('');
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<TabId>('joins');
  const [resolveAliases, setResolveAliases] = useState(false);

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
      { id: 'nested' as const, label: 'UNION / サブクエリ', icon: '📦' },
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
    if (activeTab === 'nested' && !nestedInfo.showTab) {
      setActiveTab('joins');
    }
  }, [activeTab, nestedInfo.showTab]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-brand">
            <div className="app-logo">SQL</div>
            <div>
              <h1>MySQL Query Visualizer</h1>
              <p>複雑な JOIN・WHERE・UNION・サブクエリを視覚的に理解する</p>
            </div>
          </div>
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
          />
        </section>

        <section className="panel panel--output">
          {!parsed && !error && (
            <div className="welcome-state">
              <div className="welcome-icon">⚡</div>
              <h2>SQLを貼り付けて解析</h2>
              <p>
                MySQL の SELECT / UPDATE / DELETE を解析します。JOIN 図・WHERE ツリーに加え、
                UNION の各ブランチと IN / EXISTS / 派生テーブルのサブクエリも展開表示します。
              </p>
              <div className="welcome-actions">
                <button type="button" className="btn btn--primary" onClick={() => setSql(SAMPLE_SQL)} title="SELECTサンプルを読み込む">
                  SELECT
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setSql(UNION_SAMPLE_SQL)} title="UNIONサンプルを読み込む">
                  UNION
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setSql(UPDATE_SAMPLE_SQL)} title="UPDATEサンプルを読み込む">
                  UPDATE
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setSql(DELETE_SAMPLE_SQL)} title="DELETEサンプルを読み込む">
                  DELETE
                </button>
              </div>
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
                    <span className="tab-icon">{tab.icon}</span>
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div className="tab-content">
                {activeTab === 'joins' && (
                  <JoinDiagram
                    tables={displayQuery.tables}
                    joins={displayQuery.joins}
                    resolveAliases={resolveAliases}
                  />
                )}
                {activeTab === 'where' && (
                  <div className="where-panel">
                    <WhereTree root={displayQuery.where} title="WHERE" resolveAliases={resolveAliases} />
                    {displayQuery.having && (
                      <div className="having-section">
                        <WhereTree root={displayQuery.having} title="HAVING" resolveAliases={resolveAliases} />
                      </div>
                    )}
                  </div>
                )}
                {activeTab === 'summary' && (
                  <QuerySummary query={displayQuery} resolveAliases={resolveAliases} />
                )}
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
              <div className="error-icon">!</div>
              <h2>解析できませんでした</h2>
              <p>{error}</p>
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
