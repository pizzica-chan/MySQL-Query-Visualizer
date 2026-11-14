import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { RESULT_DIFF_PAIRS, type ResultDiffPair } from './fixtures/result-diff-pairs';
import { buildResultDiffSummary, compareQueryResults, normalizeExpr } from './query-result-diff';

function mustParse(sql: string) {
  const result = parseMySqlQuery(sql);
  if (!result.success) throw new Error(`${result.error.message}: ${sql}`);
  return result.query;
}

describe('normalizeExpr — 文字列リテラル', () => {
  it('文字列リテラルの大文字小文字・空白・バッククォートは変えない', () => {
    expect(normalizeExpr("T.Name  =  'It''s  `A`'")).toBe("t.name = 'It''s  `A`'");
    expect(normalizeExpr('T.Name = "A  B"')).toBe('t.name = "A  B"');
  });

  it('バッククォート識別子は中の空白を保ったまま小文字にする', () => {
    expect(normalizeExpr('T.`First  Name`')).toBe('t.first  name');
  });
});

/**
 * 反例集のすべてのペアで、比較の判定が期待どおりかを確かめる。
 * 反例は fixtures/result-diff-pairs.ts に足す。
 */
describe('compareQueryResults — 反例集', () => {
  const byExpectation = (expectation: ResultDiffPair['expect']) =>
    RESULT_DIFF_PAIRS.filter((pair) => pair.expect === expectation).map((pair) => [pair.name, pair] as const);

  it.each(byExpectation('different'))('結果が変わりうるので「同じ」としない: %s', (_name, pair) => {
    const diff = compareQueryResults(mustParse(pair.a), mustParse(pair.b));
    expect(diff.equalForResultSet).toBe(false);
    expect(buildResultDiffSummary(diff).resultSet.status).not.toBe('same');
    expect(diff.matchedViaEffectiveInner).toBe(false);
  });

  it.each(byExpectation('same'))('結果を変えない書き換えは差分にしない: %s', (_name, pair) => {
    const diff = compareQueryResults(mustParse(pair.a), mustParse(pair.b));
    expect(diff.categories.filter((c) => c.status === 'different')).toEqual([]);
    expect(diff.equalForResultSet).toBe(true);
  });

  it.each(byExpectation('proven'))('等価性の証明で「同じ」とする: %s', (_name, pair) => {
    const diff = compareQueryResults(mustParse(pair.a), mustParse(pair.b));
    expect(diff.categories.some((c) => c.id === 'other')).toBe(false);
    expect(buildResultDiffSummary(diff).resultSet.status).toBe('same');
  });

  it.each(byExpectation('order-only'))('並び順の差分にとどめる: %s', (_name, pair) => {
    const diff = compareQueryResults(mustParse(pair.a), mustParse(pair.b));
    expect(diff.equalForResultSet).toBe(true);
    expect(buildResultDiffSummary(diff).tone).toBe('order-only');
  });
});

describe('compareQueryResults — カテゴリ比較が扱わない記述', () => {
  it('過不足のある字句を「その他の記述」に出す', () => {
    const diff = compareQueryResults(
      mustParse('SELECT t.x FROM t PARTITION (p0)'),
      mustParse('SELECT t.x FROM t PARTITION (p1)'),
    );
    const other = diff.categories.find((c) => c.id === 'other');
    expect(other?.status).toBe('different');
    expect(other?.details).toContain('A のみ: p0');
    expect(other?.details).toContain('B のみ: p1');
  });

  it('差分が無いときは「その他の記述」カテゴリを出さない', () => {
    const diff = compareQueryResults(
      mustParse('SELECT t.x FROM t WHERE t.a = 1'),
      mustParse('select t.x from t where t.a = 1'),
    );
    expect(diff.categories.some((c) => c.id === 'other')).toBe(false);
  });
});
