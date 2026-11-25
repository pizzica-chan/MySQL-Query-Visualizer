import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { SQL_TEST_CASES } from './fixtures/sql-cases';

describe('parse invariants', () => {
  const successCases = SQL_TEST_CASES.filter((c) => c.expectSuccess);

  it.each(successCases)('$name — 構造的不変条件を満たす', (testCase) => {
    const result = parseMySqlQuery(testCase.sql);
    expect(result.success).toBe(true);
    if (!result.success) return;
    testCase.assert?.(result.query);
    expect(() => assertParseInvariants(result.query, testCase.name)).not.toThrow();
  });

  // 範囲が後ろの空白やコメントまで含むと、エディタで要素の後ろのコメントまで強調し、
  // カーソルがコメントや次の語の先頭にあるときも手前の要素を選んでしまう
  it.each(successCases)('$name — 範囲が SQL の中に収まり、後ろに空白を含まない', (testCase) => {
    const result = parseMySqlQuery(testCase.sql);
    if (!result.success) throw new Error('parse failed');
    const problems: string[] = [];
    const seen = new Set<object>();
    const visit = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const span = child as { start?: unknown; end?: unknown } | null;
        if (key.endsWith('Span') && span && typeof span.start === 'number' && typeof span.end === 'number') {
          const { start, end } = span as { start: number; end: number };
          if (!(start >= 0 && start < end && end <= testCase.sql.length)) problems.push(`${path}.${key} [${start},${end}]`);
          else if (/\s$/.test(testCase.sql.slice(start, end))) problems.push(`${path}.${key} ${JSON.stringify(testCase.sql.slice(start, end))}`);
        } else {
          visit(child, `${path}.${key}`);
        }
      }
    };
    visit(result.query, 'q');
    expect(problems).toEqual([]);
  });
});

describe('parse invariants — 意図的な破損検出', () => {
  it('JOIN が存在するのに参照先が無ければ検出する', () => {
    expect(() =>
      assertParseInvariants({
        rawSql: '',
        statementType: 'SELECT',
        tables: [{ id: 'tbl-1', table: 'a', displayName: 'a' }],
        joins: [
          {
            id: 'join-1',
            type: 'INNER JOIN',
            sourceId: 'tbl-1',
            targetId: 'tbl-missing',
            condition: 'a.id = b.id',
          },
        ],
        columns: [{ expression: '*' }],
        groupBy: [],
        orderBy: [],
        distinct: false,
      }),
    ).toThrow(/unknown target/);
  });

  it('派生テーブルに derivedQuery が無ければ検出する', () => {
    expect(() =>
      assertParseInvariants({
        rawSql: '',
        statementType: 'SELECT',
        tables: [{ id: 'tbl-1', table: 't', displayName: 't (派生)', isDerived: true }],
        joins: [],
        columns: [{ expression: 'id' }],
        groupBy: [],
        orderBy: [],
        distinct: false,
      }),
    ).toThrow(/missing derivedQuery/);
  });
});
