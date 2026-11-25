import { useState } from 'react';
import type { DiffCategoryResult } from '../lib/query-result-diff';
import { IconAlert, IconApprox, IconDiff, IconShieldCheck } from './Icons';
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

/**
 * 実データで結果を突き合わせる確認用の SQL。コピーして利用者が自分の DB で実行する（このアプリはどこにも送らない）。
 * 構文の違いが見つからないだけのときや要確認のときは、最初から開いておく
 */
function VerificationSqlSection({ sql, open }: { sql: string; open: boolean }) {
  // どの SQL をコピーしたときの知らせかも持つ。SQL を書き換えたあとに「コピーしました」を残すと、今の SQL をコピーしたように読める
  const [copyResult, setCopyResult] = useState<{ sql: string; message: string } | null>(null);
  const copyStatus = copyResult?.sql === sql ? copyResult.message : null;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopyResult({ sql, message: 'コピーしました' });
    } catch {
      // クリップボードを使えない環境では、下の SQL を選んで手でコピーしてもらう
      setCopyResult({ sql, message: 'コピーできませんでした。SQL を選んでコピーしてください' });
    }
  };
  return (
    <details className="result-diff-section result-diff-verify" open={open}>
      <summary className="result-diff-section-title">確認用の SQL（実データで結果を突き合わせる）</summary>
      <p className="result-diff-verify-text">
        2 本の SQL の結果を、EXCEPT ALL で突き合わせます。両方とも 0 行なら、実行したときのデータでは同じ行が同じ数だけ返っています（並び順は比べません）。
        ほかのデータでも同じになるとは限りません。値は列の照合順序で比べるので、大文字と小文字を区別しない照合順序では、'abc' と 'ABC' のような値を同じとみなすことがあります。MySQL 8.0.31 以降で実行できます。
      </p>
      <div className="result-diff-verify-actions">
        <button type="button" className="btn btn--ghost" onClick={handleCopy}>
          SQL をコピー
        </button>
        <span className="result-diff-verify-status" role="status">
          {copyStatus}
        </span>
      </div>
      <pre className="result-diff-verify-sql">
        <code>{sql}</code>
      </pre>
    </details>
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
  // 判定の見出しのアイコン。証明済み・構文の違いなし・要確認・異なるで形を変え、色だけに頼らずに見分けられるようにする
  const SummaryIcon =
    summary.tone === 'different'
      ? IconDiff
      : summary.tone === 'same'
        ? IconShieldCheck
        : summary.tone === 'no-diff'
          ? IconApprox
          : IconAlert;
  const proofStatus = diff.equivalenceProof?.status ?? 'not-proven';
  const syntaxDiffTitle =
    proofStatus === 'proven-equivalent'
      ? '構文の差分（結果セットへの影響なしと証明済み）'
      : proofStatus === 'proven-equivalent-set-only'
        ? '構文の差分（重複行の扱い以外は影響なしと証明済み）'
        : '結果セットに影響する差分';

  return (
    <div className="result-diff">
      <div className={`result-diff-summary result-diff-summary--${summary.tone}`} role="status">
        <h2 className="result-diff-summary-title">
          <span className="result-diff-summary-icon">
            <SummaryIcon size={20} />
          </span>
          {summary.title}
        </h2>
        <dl className="result-diff-summary-rows">
          <div className="result-diff-summary-row">
            <dt className="result-diff-summary-row-label">結果セット</dt>
            <dd className={`result-diff-summary-row-value result-diff-summary-row-value--${summary.resultSet.status}`}>
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

      {diff.verificationSql && (
        <VerificationSqlSection sql={diff.verificationSql} open={summary.tone !== 'same' && summary.tone !== 'different'} />
      )}

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

      <p className="result-diff-disclaimer">
        実データは使わず、SQL の構文を比べます。「同じ（証明済み）」と出すのは、INNER 相当の JOIN・AND・= だけで書かれた範囲で、
        結果が同じことを証明できたときだけです。意味が同じでも書き方が違うと、差分と出ることがあります。
      </p>
    </div>
  );
}
