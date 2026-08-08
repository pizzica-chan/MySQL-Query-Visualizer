import type { QueryResultDiff } from '../lib/query-result-diff';

interface QueryResultDiffPanelProps {
  diff: QueryResultDiff | null;
  compareOrderBy: boolean;
  errorA?: string;
  errorB?: string;
  hasSqlA: boolean;
  hasSqlB: boolean;
  /** デバウンス待ちなど、入力済みだが解析結果がまだ揃っていない */
  pending?: boolean;
}

function summaryMessage(
  diff: QueryResultDiff,
  compareOrderBy: boolean,
): { tone: 'same' | 'order-only' | 'different'; title: string; body: string } {
  if (compareOrderBy) {
    if (diff.equalIncludingOrder) {
      return {
        tone: 'same',
        title: '結果は同じと推定',
        body: '構文上、出力列・結合・条件・並び順を含め結果に影響する差分は見つかっていません。',
      };
    }
    if (diff.equalForResultSet) {
      return {
        tone: 'order-only',
        title: '行の集合は同じと推定（並びが異なる）',
        body: 'ORDER BY 以外は一致しています。行順の比較がオンのため、結果は異なると判定しています。',
      };
    }
    return {
      tone: 'different',
      title: '結果が異なる可能性あり',
      body: '構文上、実行結果に影響しうる差分があります。下のカテゴリを確認してください。',
    };
  }

  if (diff.equalForResultSet) {
    if (!diff.equalIncludingOrder) {
      return {
        tone: 'order-only',
        title: '行の集合は同じと推定（並びのみ異なる可能性）',
        body: 'ORDER BY 以外は一致しています。行順の比較はオフのため、結果集合としては同じとみなしています。',
      };
    }
    return {
      tone: 'same',
      title: '結果は同じと推定',
      body: '構文上、出力列・結合・条件など結果集合に影響する差分は見つかっていません。',
    };
  }

  return {
    tone: 'different',
    title: '結果が異なる可能性あり',
    body: '構文上、実行結果に影響しうる差分があります。下のカテゴリを確認してください。',
  };
}

export function QueryResultDiffPanel({
  diff,
  compareOrderBy,
  errorA,
  errorB,
  hasSqlA,
  hasSqlB,
  pending = false,
}: QueryResultDiffPanelProps) {
  if (!hasSqlA && !hasSqlB) {
    return (
      <div className="welcome-state">
        <p className="welcome-hint">
          左に比較したい SQL を 2 本入力してください。チューニング前後のクエリで、結果が変わりそうな構文差分を確認できます。
        </p>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="welcome-state">
        <p className="welcome-hint">解析中…</p>
      </div>
    );
  }

  if (errorA || errorB) {
    return (
      <div className="error-state">
        <h2>解析エラー</h2>
        {errorA && (
          <p className="error-message">
            <strong>SQL A:</strong> {errorA}
          </p>
        )}
        {errorB && (
          <p className="error-message">
            <strong>SQL B:</strong> {errorB}
          </p>
        )}
        <p className="error-hint">両方の SQL が正しく解析できると差分を表示します。</p>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="welcome-state">
        <p className="welcome-hint">両方の SQL を入力すると差分を表示します。</p>
      </div>
    );
  }

  const summary = summaryMessage(diff, compareOrderBy);
  const different = diff.categories.filter((c) => c.status === 'different');
  const same = diff.categories.filter((c) => c.status === 'same');

  return (
    <div className="result-diff">
      <p className="result-diff-disclaimer">
        実データは使いません。SQL 構文の構造比較による推定です。意味的に等価でも構文が違う場合は差分と出ることがあります。
      </p>

      <div className={`result-diff-summary result-diff-summary--${summary.tone}`} role="status">
        <h2 className="result-diff-summary-title">{summary.title}</h2>
        <p className="result-diff-summary-body">{summary.body}</p>
      </div>

      {different.length > 0 && (
        <section className="result-diff-section">
          <h3 className="result-diff-section-title">差分あり</h3>
          <ul className="result-diff-list">
            {different.map((cat) => (
              <li key={cat.id} className="result-diff-item result-diff-item--different">
                <div className="result-diff-item-header">
                  <span className="result-diff-item-label">{cat.label}</span>
                  <span className="result-diff-badge result-diff-badge--different">差分</span>
                </div>
                {cat.details.length > 0 && (
                  <ul className="result-diff-details">
                    {cat.details.map((detail, i) => (
                      <li key={`${cat.id}-${i}`}>{detail}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="result-diff-section">
        <h3 className="result-diff-section-title">一致</h3>
        {same.length === 0 ? (
          <p className="result-diff-empty">一致しているカテゴリはありません。</p>
        ) : (
          <ul className="result-diff-same-list">
            {same.map((cat) => (
              <li key={cat.id} className="result-diff-same-item">
                <span className="result-diff-item-label">{cat.label}</span>
                <span className="result-diff-badge result-diff-badge--same">一致</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
