import { describe, expect, it } from 'vitest';
import { joinTreeSignature, type JoinCondition, type JoinKind, type JoinTreeHelpers } from './join-tree';
import type { JoinEdge, ParsedQuery, TableRef } from './types';

/**
 * 書き換えの規則だけを確かめるため、SQL を解析せずに FROM 句を組み立てる。
 * join は [種類, 結合先, 条件の一覧]。条件は [シグネチャ, 読むテーブル（'?' は分からない）]
 */
type Cond = [signature: string, tables: string[] | '?'];
type Step = [kind: JoinKind, target: string, conditions: Cond[]];

function signature(first: string, steps: Step[]): string | null {
  const names = [first, ...steps.map((s) => s[1])];
  const tables: TableRef[] = names.map((name) => ({ id: name, table: name, displayName: name }));
  const conditions = new Map<string, JoinCondition[]>();
  const kinds = new Map<string, JoinKind>();
  const joins: JoinEdge[] = steps.map(([kind, target, conds], i) => {
    const id = `j${i}`;
    kinds.set(id, kind);
    conditions.set(
      id,
      conds.map(([sig, refs]) => ({ signature: sig, tables: refs === '?' ? 'unknown' : new Set(refs) })),
    );
    return { id, type: 'INNER JOIN', sourceId: names[i]!, targetId: target, condition: sig(conds) };
  });
  const query = { tables, joins } as unknown as ParsedQuery;
  const helpers: JoinTreeHelpers = {
    tableKey: (id) => id,
    kind: (join) => kinds.get(join.id)!,
    conditions: (join) => conditions.get(join.id)!,
  };
  return joinTreeSignature(query, helpers);
}

function sig(conds: Cond[]): string {
  return conds.map((c) => c[0]).join(' AND ') || '(no condition)';
}

describe('joinTreeSignature', () => {
  it('内部結合は並べ替えても、ON の条件を別の ON に移しても同じ', () => {
    expect(
      signature('a', [
        ['inner', 'b', [['a=b', ['a', 'b']], ['b.k=1', ['b']]]],
        ['inner', 'c', [['b=c', ['b', 'c']]]],
      ]),
    ).toBe(
      signature('a', [
        ['inner', 'c', [['b=c', ['b', 'c']], ['b.k=1', ['b']]]],
        ['inner', 'b', [['a=b', ['a', 'b']]]],
      ]),
    );
  });

  it('LEFT JOIN で行を残す側が違えば別の木になる', () => {
    expect(signature('a', [['left', 'b', [['a=b', ['a', 'b']]]]])).not.toBe(
      signature('b', [['left', 'a', [['a=b', ['a', 'b']]]]]),
    );
  });

  it('RIGHT JOIN は左右を入れ替えた LEFT JOIN と同じ', () => {
    expect(signature('a', [['left', 'b', [['a=b', ['a', 'b']]]]])).toBe(
      signature('b', [['right', 'a', [['a=b', ['a', 'b']]]]]),
    );
  });

  it('内部結合の条件が NULL で埋まる側を読まなければ、外部結合をまとまりの外へ出す', () => {
    // (x ⟕ b) ⋈ a と (a ⋈ x) ⟕ b
    expect(
      signature('x', [
        ['left', 'b', [['x=b', ['x', 'b']]]],
        ['inner', 'a', [['a=x', ['a', 'x']]]],
      ]),
    ).toBe(
      signature('a', [
        ['inner', 'x', [['a=x', ['a', 'x']]]],
        ['left', 'b', [['x=b', ['x', 'b']]]],
      ]),
    );
  });

  it('内部結合の条件が NULL で埋まる側を読むなら、外部結合を外へ出さない', () => {
    expect(
      signature('x', [
        ['left', 'b', [['x=b', ['x', 'b']]]],
        ['inner', 'a', [['a=x or a=b', ['a', 'x', 'b']]]],
      ]),
    ).not.toBe(
      signature('a', [
        ['inner', 'x', [['a=x or a=b', ['a', 'x', 'b']]]],
        ['left', 'b', [['x=b', ['x', 'b']]]],
      ]),
    );
  });

  it('内部結合の条件が読むテーブルが分からなければ、外部結合を外へ出さない', () => {
    expect(
      signature('x', [
        ['left', 'b', [['x=b', ['x', 'b']]]],
        ['inner', 'a', [['a=x or col=1', '?']]],
      ]),
    ).not.toBe(
      signature('a', [
        ['inner', 'x', [['a=x or col=1', '?']]],
        ['left', 'b', [['x=b', ['x', 'b']]]],
      ]),
    );
  });

  it('互いを読まない外部結合は並べ替えても同じ', () => {
    expect(
      signature('a', [
        ['left', 'b', [['a=b', ['a', 'b']]]],
        ['left', 'c', [['a=c', ['a', 'c']]]],
      ]),
    ).toBe(
      signature('a', [
        ['left', 'c', [['a=c', ['a', 'c']]]],
        ['left', 'b', [['a=b', ['a', 'b']]]],
      ]),
    );
  });

  it('後ろの外部結合が前の外部結合の NULL で埋まる側を読むなら、順序を保つ', () => {
    const chained = signature('a', [
      ['left', 'b', [['a=b', ['a', 'b']]]],
      ['left', 'c', [['b=c', ['b', 'c']]]],
    ]);
    // 同じ 2 つの外部結合を逆の順に並べた木（SQL では書けないが、順序を区別することを確かめる）
    const swapped = signature('a', [
      ['left', 'c', [['b=c', ['b', 'c']]]],
      ['left', 'b', [['a=b', ['a', 'b']]]],
    ]);
    expect(chained).not.toBe(swapped);
  });

  it('NATURAL JOIN は並べ替えない', () => {
    expect(
      signature('a', [
        [{ fixed: 'natural inner join' }, 'b', []],
        [{ fixed: 'natural inner join' }, 'c', []],
      ]),
    ).not.toBe(
      signature('a', [
        [{ fixed: 'natural inner join' }, 'c', []],
        [{ fixed: 'natural inner join' }, 'b', []],
      ]),
    );
  });
});
