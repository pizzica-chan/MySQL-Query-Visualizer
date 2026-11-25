import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import type { ConditionNode } from './types';

/** 条件木を `OR(a, AND(b, c))` の形の文字列にする */
function show(node: ConditionNode | undefined): string {
  if (!node) return '-';
  if (node.type === 'and' || node.type === 'or') {
    return `${node.operator}(${(node.children ?? []).map(show).join(', ')})`;
  }
  if (node.type === 'not') return `NOT(${(node.children ?? []).map(show).join(', ')})`;
  return node.label;
}

function whereOf(sql: string): string {
  const result = parseMySqlQuery(sql);
  if (!result.success) throw new Error(result.error.message);
  return show(result.query.where ?? result.query.having);
}

describe('AND と OR の優先順位（MySQL 8.4 リファレンス 14.4.1）', () => {
  it.each([
    ['t.a = 1 OR t.b = 2 AND t.c = 3', 'OR(t.a = 1, AND(t.b = 2, t.c = 3))'],
    ['t.a = 1 AND t.b = 2 OR t.c = 3 AND t.d = 4', 'OR(AND(t.a = 1, t.b = 2), AND(t.c = 3, t.d = 4))'],
    ['(t.a = 1 OR t.b = 2) AND t.c = 3', 'AND(OR(t.a = 1, t.b = 2), t.c = 3)'],
    ['t.a = 1 OR t.b = 2 AND (t.c = 3 OR t.d = 4) AND t.e = 5', 'OR(t.a = 1, AND(t.b = 2, OR(t.c = 3, t.d = 4), t.e = 5))'],
    ['NOT t.a = 1 OR t.b = 2 AND t.c = 3', 'OR(NOT(t.a = 1), AND(t.b = 2, t.c = 3))'],
    ['t.a BETWEEN 1 AND 5 OR t.b = 2 AND t.c = 3', 'OR(t.a BETWEEN 1 AND 5, AND(t.b = 2, t.c = 3))'],
  ])('WHERE %s', (condition, expected) => {
    expect(whereOf(`SELECT t.a FROM t WHERE ${condition}`)).toBe(expected);
  });

  it('HAVING・サブクエリの中・UPDATE・DELETE でも AND を先に結び付ける', () => {
    const expected = 'OR(t.a = 1, AND(t.b = 2, t.c = 3))';
    expect(whereOf('UPDATE t SET t.a = 1 WHERE t.a = 1 OR t.b = 2 AND t.c = 3')).toBe(expected);
    expect(whereOf('DELETE FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3')).toBe(expected);
    expect(whereOf('SELECT t.a FROM t GROUP BY t.a HAVING COUNT(*) > 1 OR SUM(t.b) > 2 AND MAX(t.c) > 3')).toBe(
      'OR(COUNT(*) > 1, AND(SUM(t.b) > 2, MAX(t.c) > 3))',
    );
    const result = parseMySqlQuery('SELECT t.a FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.a = 1 OR u.b = 2 AND u.c = 3)');
    if (!result.success) throw new Error(result.error.message);
    expect(show(result.query.where?.nestedQuery?.where)).toBe('OR(u.a = 1, AND(u.b = 2, u.c = 3))');
  });

  it('組み直しても、条件全体の範囲は元の SQL の条件全体を指す', () => {
    const sql = 'SELECT t.a FROM t WHERE t.a = 1 OR t.b = 2 AND t.c = 3';
    const result = parseMySqlQuery(sql);
    if (!result.success) throw new Error(result.error.message);
    const span = result.query.where!.sourceSpan!;
    expect(sql.slice(span.start, span.end)).toBe('t.a = 1 OR t.b = 2 AND t.c = 3');
  });

  it.each(['||', 'XOR'])('括弧の無い %s は、MySQL と違う意味で解析されるのでエラーにする', (op) => {
    const result = parseMySqlQuery(`SELECT t.a FROM t WHERE t.a = 1 ${op} t.b = 2`);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`${op} の前後の比較を括弧で囲んでください`);
  });

  it('比較を括弧で囲んだ XOR は解析する', () => {
    expect(parseMySqlQuery('SELECT t.a FROM t WHERE (t.a = 1) XOR (t.b = 2)').success).toBe(true);
  });
});
