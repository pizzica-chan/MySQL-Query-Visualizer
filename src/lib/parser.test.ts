import { describe, expect, it } from 'vitest';
import {
  parseMySqlQuery,
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
} from './parser';
import { assertParseInvariants } from './fixtures/parse-invariants';
import { SQL_TEST_CASES, collectConditionTypes, tableNames } from './fixtures/sql-cases';
import type { ConditionNode } from './types';
import { collectAllNestedQueries } from './query-utils';

function flattenConditionLabels(node: ConditionNode | undefined): string[] {
  if (!node) return [];
  return [node.label, ...(node.children ?? []).flatMap(flattenConditionLabels)];
}

const ALL_CATEGORIES = [
  'basic',
  'complex',
  'dirty',
  'edge',
  'update',
  'delete',
  'union',
  'subquery',
  'regression',
  'error',
] as const;

describe('parseMySqlQuery', () => {
  describe('SAMPLE_SQL（ゴールデン）', () => {
    it('サンプルクエリをエラーなく解析し構造が一致する', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('SELECT');
      expect(result.query.tables).toHaveLength(7);
      expect(result.query.joins).toHaveLength(6);
      expect(result.query.tables.some((t) => t.isDerived)).toBe(true);
      expect(result.query.where?.type).toBe('and');
      expect(result.query.having).toBeDefined();
      expect(result.query.limit).toBe('100');
      expect(result.query.groupBy).toHaveLength(9);
      expect(result.query.orderBy).toHaveLength(2);

      const wTypes = collectConditionTypes(result.query.where);
      expect(wTypes).toContain('or');
      expect(wTypes).toContain('like');
      expect(wTypes).toContain('in');
      expect(wTypes).toContain('between');
      expect(wTypes).toContain('exists');
      expect(result.query.having?.label).toContain('SUM(oi.quantity)');

      const nested = collectAllNestedQueries(result.query);
      expect(nested.length).toBeGreaterThanOrEqual(4);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'payments'))).toBe(true);
      expect(nested.some((q) => q.tables.some((t) => t.table === 'banned_users'))).toBe(true);

      expect(result.query.where?.sourceSpan).toBeDefined();
      expect(result.query.tables[0]?.sourceSpan).toBeDefined();
      expect(result.query.joins[0]?.sourceSpan).toBeDefined();
      expect(result.query.columns[0]?.sourceSpan).toBeDefined();
      expect(result.query.groupBy[0]?.sourceSpan).toBeDefined();
      expect(result.query.orderBy[0]?.sourceSpan).toBeDefined();
      expect(result.query.limitSpan).toBeDefined();

      expect(() => assertParseInvariants(result.query, 'SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('UPDATE_SAMPLE_SQL（ゴールデン）', () => {
    it('UPDATEサンプルをエラーなく解析し構造が一致する', () => {
      const result = parseMySqlQuery(UPDATE_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.tables).toHaveLength(3);
      expect(result.query.joins).toHaveLength(2);
      expect(result.query.setClauses).toHaveLength(4);
      expect(result.query.where?.type).toBe('and');
      expect(result.query.limit).toBe('500');
      expect(result.query.setClauses?.some((s) => s.table === 'u')).toBe(true);
      expect(result.query.setClauses?.some((s) => s.table === 'oi')).toBe(true);

      expect(() => assertParseInvariants(result.query, 'UPDATE_SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('DELETE_SAMPLE_SQL（ゴールデン）', () => {
    it('DELETEサンプルをエラーなく解析し構造が一致する', () => {
      const result = parseMySqlQuery(DELETE_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.statementType).toBe('DELETE');
      expect(result.query.tables).toHaveLength(3);
      expect(result.query.joins).toHaveLength(2);
      expect(result.query.deleteTargets).toHaveLength(2);
      expect(result.query.deleteTargets?.map((d) => d.name).sort().join(',')).toBe('oi,u');
      expect(result.query.where?.type).toBe('and');
      expect(result.query.limit).toBe('200');

      const wTypes = collectConditionTypes(result.query.where);
      expect(wTypes).toContain('or');
      expect(wTypes).toContain('is_null');
      const labels = flattenConditionLabels(result.query.where);
      expect(labels.some((l) => l.toUpperCase().includes('NOT LIKE'))).toBe(true);

      expect(() => assertParseInvariants(result.query, 'DELETE_SAMPLE_SQL')).not.toThrow();
    });
  });

  describe('UNION_SAMPLE_SQL（ゴールデン）', () => {
    it('UNIONサンプルを全ブランチ解析し構造が一致する', () => {
      const result = parseMySqlQuery(UNION_SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.unionBranches).toHaveLength(3);
      expect(result.query.unionBranches?.[1]?.operator).toBe('UNION ALL');
      expect(result.query.unionBranches?.[2]?.operator).toBe('UNION');
      expect(tableNames(result.query).join()).toBe('users');
      expect(result.query.unionBranches?.[1]?.query.tables[0]?.table).toBe('archived_users');
      expect(result.query.unionBranches?.[2]?.query.tables[0]?.table).toBe('guest_users');

      const branch2Where = result.query.unionBranches?.[2]?.query.where;
      const types = collectConditionTypes(branch2Where);
      expect(types).toContain('exists');

      expect(() => assertParseInvariants(result.query, 'UNION_SAMPLE_SQL')).not.toThrow();
    });
  });

  describe.each(ALL_CATEGORIES)('category: %s', (category) => {
    const cases = SQL_TEST_CASES.filter((c) => c.category === category);

    it.each(cases)('$name', (testCase) => {
      const result = parseMySqlQuery(testCase.sql);

      if (testCase.expectSuccess) {
        expect(result.success, `parse failed: ${!result.success ? result.error.message : ''}`).toBe(true);
        if (!result.success) return;
        testCase.assert?.(result.query);
        expect(() => assertParseInvariants(result.query, testCase.name)).not.toThrow();
      } else {
        expect(result.success).toBe(false);
        if (!result.success && testCase.errorContains) {
          expect(result.error.message).toContain(testCase.errorContains);
        }
      }
    });
  });

  describe('JOIN条件の詳細', () => {
    it('各JOINに ON 条件文字列が付く', () => {
      const result = parseMySqlQuery(`
        SELECT * FROM a
        INNER JOIN b ON a.id = b.a_id
        LEFT JOIN c ON c.b_id = b.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.joins[0]?.condition).toBe('a.id = b.a_id');
      expect(result.query.joins[0]?.type).toBe('INNER JOIN');
      expect(result.query.joins[1]?.type).toBe('LEFT JOIN');
      expect(result.query.joins[0]?.sourceId).not.toBe(result.query.joins[0]?.targetId);
    });

    it('JOIN の source/target は実在テーブル ID を指す', () => {
      const result = parseMySqlQuery('SELECT * FROM a JOIN b ON a.id = b.a_id JOIN c ON c.b_id = b.id');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const ids = new Set(result.query.tables.map((t) => t.id));
      for (const join of result.query.joins) {
        expect(ids.has(join.sourceId)).toBe(true);
        expect(ids.has(join.targetId)).toBe(true);
      }
    });
  });

  describe('LIMIT / OFFSET', () => {
    it('LIMIT OFFSET を limit と offset に分解する', () => {
      const result = parseMySqlQuery('SELECT id FROM t LIMIT 50 OFFSET 10');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.limit).toBe('50');
      expect(result.query.offset).toBe('10');
    });

    it('LIMIT offset, count 形式は MySQL 順（先が offset）で分解する', () => {
      const result = parseMySqlQuery('SELECT id FROM t LIMIT 100, 120');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.offset).toBe('100');
      expect(result.query.limit).toBe('120');
    });
  });

  describe('WHERE条件ツリー', () => {
    it('LIKE条件は like タイプになる', () => {
      const result = parseMySqlQuery("SELECT id FROM t WHERE name LIKE '%foo%'");
      expect(result.success).toBe(true);
      if (!result.success) return;

      const labels = flattenConditionLabels(result.query.where);
      expect(labels.some((l) => l.includes('LIKE'))).toBe(true);
      expect(result.query.where?.type).toBe('like');
    });

    it('IN条件は in タイプになる', () => {
      const result = parseMySqlQuery('SELECT id FROM t WHERE status IN (1, 2, 3)');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.where?.type).toBe('in');
    });
  });

  describe('テーブルメタデータ', () => {
    it('エイリアスが displayName に反映される', () => {
      const result = parseMySqlQuery('SELECT u.id FROM users u');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.tables[0]?.alias).toBe('u');
      expect(result.query.tables[0]?.displayName).toBe('u');
    });

    it('スキーマ付きテーブル名を解釈する', () => {
      const result = parseMySqlQuery('SELECT id FROM mydb.users');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.query.tables[0]?.schema).toBe('mydb');
      expect(result.query.tables[0]?.table).toBe('users');
    });
  });
});

describe('parseMySqlQuery 統計', () => {
  it('成功ケースが一定数以上ある', () => {
    const successCount = SQL_TEST_CASES.filter((c) => c.expectSuccess).length;
    expect(successCount).toBeGreaterThanOrEqual(45);
  });

  it('失敗ケースが一定数以上ある', () => {
    const errorCount = SQL_TEST_CASES.filter((c) => !c.expectSuccess).length;
    expect(errorCount).toBeGreaterThanOrEqual(5);
  });

  it('union / subquery / regression カテゴリが存在する', () => {
    const cats = new Set(SQL_TEST_CASES.map((c) => c.category));
    expect(cats.has('union')).toBe(true);
    expect(cats.has('subquery')).toBe(true);
    expect(cats.has('regression')).toBe(true);
  });
});
