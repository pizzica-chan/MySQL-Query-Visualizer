import type { DiffCategoryResult } from '../lib/query-result-diff';
import {
  buildResultDiffSummary,
  partitionDiffCategories,
  type QueryResultDiff,
} from '../lib/query-result-diff';

interface QueryResultDiffPanelProps {
  diff: QueryResultDiff | null;
  errorA?: string;
  errorB?: string;
  hasSqlA: boolean;
  hasSqlB: boolean;
  /** デバウンス待ちなど、入力済みだが解析結果がまだ揃っていない */
  pending?: boolean;
}

function DiffCategoryList({ categories }: { categories: DiffCategoryResult[] }) {
  return (
    <ul className="result-diff-list">
      {categories.map((cat) => (
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
  );
}

function SameCategoryList({ categories }: { categories: DiffCategoryResult[] }) {
  if (categories.length === 0) return null;
  return (
    <ul className="result-diff-same-list">
      {categories.map((cat) => (
        <li key={cat.id} className="result-diff-same-item">
          <span className="result-diff-item-label">{cat.label}</span>
          <span className="result-diff-badge result-diff-badge--same">一致</span>
        </li>
      ))}
    </ul>
  );
}

export function QueryResultDiffPanel({
  diff,
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

  const summary = buildResultDiffSummary(diff);
  const { resultSetDifferent, orderDifferent, resultSetSame, orderSame } = partitionDiffCategories(
    diff.categories,
  );
  const hasAnySame = resultSetSame.length > 0 || orderSame.length > 0;
  const proofStatus = diff.equivalenceProof?.status ?? 'not-proven';
  const syntaxDiffTitle =
    proofStatus === 'proven-equivalent'
      ? '構文の差分（結果セットへの影響なしと証明済み）'
      : proofStatus === 'proven-equivalent-set-only'
        ? '構文の差分（重複行の扱い以外は影響なしと証明済み）'
        : '結果セットに影響する差分';

  return (
    <div className="result-diff">
      <p className="result-diff-disclaimer">
        実データは使いません。SQL 構文の構造比較による推定です。意味的に等価でも構文が違う場合は差分と出ることがあります（INNER
        相当の JOIN・AND・= だけで書かれた範囲に限り、等価性を証明できることがあります）。
      </p>

      <div className={`result-diff-summary result-diff-summary--${summary.tone}`} role="status">
        <h2 className="result-diff-summary-title">{summary.title}</h2>
        <dl className="result-diff-summary-rows">
          <div className="result-diff-summary-row">
            <dt className="result-diff-summary-row-label">結果セット</dt>
            <dd
              className={`result-diff-summary-row-value result-diff-summary-row-value--${summary.resultSet.status}`}
            >
              {summary.resultSet.label}
            </dd>
          </div>
          <div className="result-diff-summary-row">
            <dt className="result-diff-summary-row-label">並び順</dt>
            <dd
              className={`result-diff-summary-row-value result-diff-summary-row-value--${summary.order.status}`}
            >
              {summary.order.label}
            </dd>
          </div>
        </dl>
        <p className="result-diff-summary-body">
          {summary.body}
          {summary.note ? ` ${summary.note}` : ''}
        </p>
        {summary.proofNote && <p className="result-diff-proof-note">{summary.proofNote}</p>}
        {summary.effectiveInnerNote && (
          <p className="result-diff-effective-inner-note">{summary.effectiveInnerNote}</p>
        )}
        {summary.limitWithoutOrderWarning && (
          <p className="result-diff-limit-warning" role="alert">
            <strong>注意:</strong> {summary.limitWithoutOrderWarning}
          </p>
        )}
      </div>

      {summary.hints.length > 0 && (
        <section className="result-diff-section result-diff-hints">
          <h3 className="result-diff-section-title">要確認ヒント</h3>
          <ul className="result-diff-hint-list">
            {summary.hints.map((hint) => (
              <li key={hint.id} className="result-diff-hint">
                <div className="result-diff-hint-title">{hint.title}</div>
                <p className="result-diff-hint-message">{hint.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {resultSetDifferent.length > 0 && (
        <section className="result-diff-section">
          <h3 className="result-diff-section-title">{syntaxDiffTitle}</h3>
          <DiffCategoryList categories={resultSetDifferent} />
        </section>
      )}

      {orderDifferent.length > 0 && (
        <section className="result-diff-section">
          <h3 className="result-diff-section-title">並び順の差分</h3>
          <DiffCategoryList categories={orderDifferent} />
        </section>
      )}

      <section className="result-diff-section">
        <h3 className="result-diff-section-title">一致</h3>
        {!hasAnySame ? (
          <p className="result-diff-empty">一致しているカテゴリはありません。</p>
        ) : (
          <>
            {resultSetSame.length > 0 && (
              <>
                {resultSetDifferent.length > 0 || orderDifferent.length > 0 ? (
                  <p className="result-diff-subsection-label">結果セット</p>
                ) : null}
                <SameCategoryList categories={resultSetSame} />
              </>
            )}
            {orderSame.length > 0 && (
              <>
                {resultSetSame.length > 0 ? (
                  <p className="result-diff-subsection-label">並び順</p>
                ) : null}
                <SameCategoryList categories={orderSame} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
