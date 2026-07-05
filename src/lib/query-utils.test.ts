import { describe, expect, it } from 'vitest';
import {
  collectAllNestedQueries,
  collectSubqueriesFromCondition,
  countNestedItems,
  formatUnionBranches,
  hasUnion,
} from './query-utils';
import { parseMySqlQuery, UNION_SAMPLE_SQL } from './parser';
import type { ConditionNode, ParsedQuery } from './types';

function makeMinimalQuery(overrides: Partial<ParsedQuery> = {}): ParsedQuery {
  return {
    rawSql: '',
    statementType: 'SELECT',
    tables: [{ id: 't1', table: 'users', displayName: 'users' }],
    joins: [],
    columns: [{ expression: 'id' }],
    groupBy: [],
    orderBy: [],
    distinct: false,
    ...overrides,
  };
}

describe('query-utils', () => {
  describe('hasUnion', () => {
    it('unionBranches が2未満なら false', () => {
      expect(hasUnion(makeMinimalQuery())).toBe(false);
      expect(
        hasUnion(
          makeMinimalQuery({
            unionBranches: [{ id: 'u1', query: makeMinimalQuery() }],
          }),
        ),
      ).toBe(false);
    });

    it('unionBranches が2以上なら true', () => {
      const q = makeMinimalQuery({
        unionBranches: [
          { id: 'u1', query: makeMinimalQuery() },
          {
            id: 'u2',
            operator: 'UNION ALL',
            query: makeMinimalQuery({
              tables: [{ id: 't2', table: 'b', displayName: 'b' }],
            }),
          },
        ],
      });
      expect(hasUnion(q)).toBe(true);
    });
  });

  describe('formatUnionBranches', () => {
    it('2ブランチ以上を矢印形式で連結する', () => {
      const branches = [
        { id: 'u1', query: makeMinimalQuery() },
        { id: 'u2', operator: 'UNION ALL', query: makeMinimalQuery() },
        { id: 'u3', operator: 'UNION', query: makeMinimalQuery() },
      ];
      expect(formatUnionBranches(branches)).toBe('SELECT → UNION ALL → UNION');
    });

    it('1ブランチ以下は空文字', () => {
      expect(formatUnionBranches(undefined)).toBe('');
      expect(formatUnionBranches([{ id: 'u1', query: makeMinimalQuery() }])).toBe('');
    });
  });

  describe('collectSubqueriesFromCondition', () => {
    it('ネストした条件からサブクエリを収集する', () => {
      const inner = makeMinimalQuery({
        tables: [{ id: 'i1', table: 'orders', displayName: 'orders' }],
      });
      const root: ConditionNode = {
        id: 'c1',
        type: 'and',
        label: 'AND',
        children: [
          { id: 'c2', type: 'in', label: 'IN', nestedQuery: inner },
          { id: 'c3', type: 'exists', label: 'EXISTS', nestedQuery: inner },
        ],
      };
      const collected = collectSubqueriesFromCondition(root);
      expect(collected).toHaveLength(2);
      expect(collected.every((q) => q.tables[0]?.table === 'orders')).toBe(true);
    });
  });

  describe('collectAllNestedQueries', () => {
    it('ルート自身は含めない', () => {
      const root = makeMinimalQuery();
      expect(collectAllNestedQueries(root)).toEqual([]);
    });

    it('派生テーブル・WHERE・UNION を再帰収集する', () => {
      const result = parseMySqlQuery(UNION_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const nested = collectAllNestedQueries(result.query);
      expect(nested.length).toBeGreaterThanOrEqual(3);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'orders'))).toBe(true);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'archived_users'))).toBe(true);
    });

    it('同一オブジェクト参照は1回だけ数える', () => {
      const shared = makeMinimalQuery({
        tables: [{ id: 's1', table: 'shared', displayName: 'shared' }],
      });
      const root = makeMinimalQuery({
        where: {
          id: 'w1',
          type: 'and',
          label: 'AND',
          children: [
            { id: 'w2', type: 'in', label: 'IN', nestedQuery: shared },
            { id: 'w3', type: 'exists', label: 'EXISTS', nestedQuery: shared },
          ],
        },
      });
      expect(collectAllNestedQueries(root)).toHaveLength(1);
    });
  });

  describe('countNestedItems', () => {
    it('UNION とサブクエリ数を返す', () => {
      const result = parseMySqlQuery(UNION_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const counts = countNestedItems(result.query);
      expect(counts.unions).toBe(3);
      expect(counts.subqueries).toBeGreaterThanOrEqual(1);
    });

    it('単純 SELECT は 0/0', () => {
      const result = parseMySqlQuery('SELECT id FROM users');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(countNestedItems(result.query)).toEqual({ unions: 0, subqueries: 0 });
    });
  });
});
