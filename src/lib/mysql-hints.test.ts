import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { tableNames } from './fixtures/sql-cases';

function expectParseOk(sql: string) {
  const result = parseMySqlQuery(sql);
  expect(result.success, result.success ? '' : result.error.message).toBe(true);
  return result;
}

describe('MySQL ヒント / 修飾子の前処理', () => {
  describe('SELECT 修飾子', () => {
    it('SELECT ALL を解析できる', () => {
      const result = expectParseOk('SELECT ALL id FROM users');
      if (!result.success) return;
      expect(result.query.columns[0]?.expression).toBe('id');
    });

    it('SELECT DISTINCTROW を DISTINCT として解析できる', () => {
      const result = expectParseOk('SELECT DISTINCTROW id FROM users');
      if (!result.success) return;
      expect(result.query.distinct).toBe(true);
    });

    it('SELECT HIGH_PRIORITY を解析できる', () => {
      expectParseOk(`
        SELECT HIGH_PRIORITY u.id
        FROM users u
        JOIN orders o ON o.user_id = u.id
      `);
    });

    it('SELECT DISTINCTROW HIGH_PRIORITY の組み合わせを解析できる', () => {
      const result = expectParseOk('SELECT DISTINCTROW HIGH_PRIORITY id FROM users');
      if (!result.success) return;
      expect(result.query.distinct).toBe(true);
    });

    it('SELECT SQL_CALC_FOUND_ROWS / SQL_NO_CACHE / SQL_SMALL_RESULT を解析できる', () => {
      for (const modifier of ['SQL_CALC_FOUND_ROWS', 'SQL_NO_CACHE', 'SQL_SMALL_RESULT']) {
        const result = expectParseOk(
          `SELECT ${modifier} u.id FROM users u JOIN orders o ON o.user_id = u.id`,
        );
        if (!result.success) return;
        expect(result.query.columns[0]?.expression).toBe('u.id');
      }
    });

    it('修飾子と同名のエイリアス・WHERE 列は識別子として残す', () => {
      const result = expectParseOk(`
        SELECT u.id AS sql_no_cache
        FROM users u
        JOIN orders o ON o.user_id = u.id
        WHERE o.high_priority = 1
      `);
      if (!result.success) return;
      expect(result.query.columns[0]?.alias).toBe('sql_no_cache');
      expect(result.query.where?.label).toMatch(/high_priority/i);
    });
  });

  describe('テーブル参照ヒント', () => {
    it('文字列リテラル内の USE INDEX は壊さない', () => {
      const sql = "SELECT 'USE INDEX (idx)' AS x FROM users u JOIN orders o ON o.user_id = u.id";
      const result = expectParseOk(sql);
      if (!result.success) return;
      expect(result.query.columns[0]?.expression).toBe("'USE INDEX (idx)'");
    });

    it('USE INDEX を除去して解析できる', () => {
      const result = expectParseOk(`
        SELECT u.id
        FROM users USE INDEX (idx_name) u
        JOIN orders o ON o.user_id = u.id
      `);
      if (!result.success) return;
      expect(tableNames(result.query)).toEqual(['users', 'orders']);
    });

    it('FORCE INDEX / IGNORE INDEX / USE INDEX FOR JOIN を解析できる', () => {
      for (const hint of [
        'FORCE INDEX (idx_name)',
        'IGNORE INDEX (idx_name)',
        'USE INDEX FOR JOIN (idx_name)',
        'USE KEY FOR ORDER BY (idx_name)',
      ]) {
        const result = expectParseOk(`SELECT id FROM users ${hint} u JOIN orders o ON o.user_id = u.id`);
        if (!result.success) return;
        expect(tableNames(result.query)[0]).toBe('users');
      }
    });

    it('PARTITION 指定を除去して解析できる', () => {
      const result = expectParseOk('SELECT id FROM users PARTITION (p0, p1) u');
      if (!result.success) return;
      expect(tableNames(result.query)[0]).toBe('users');
    });

    it('バッククォート付き USE INDEX / PARTITION を解析できる', () => {
      for (const hint of [
        'USE INDEX (`idx_name`)',
        'USE KEY (`idx_name`)',
        'FORCE INDEX (`idx_a`, `idx_b`)',
        'PARTITION (`p0`)',
      ]) {
        const result = expectParseOk(
          `SELECT id FROM users ${hint} u JOIN orders o ON o.user_id = u.id`,
        );
        if (!result.success) return;
        expect(tableNames(result.query)[0]).toBe('users');
      }
    });

    it('複数インデックスヒントを解析できる', () => {
      expectParseOk(`
        SELECT id
        FROM users
          USE INDEX (idx_a)
          IGNORE INDEX FOR GROUP BY (idx_b)
        u
        JOIN orders o ON o.user_id = u.id
      `);
    });
  });

  describe('UPDATE / DELETE の文オプション修飾子', () => {
    it('UPDATE LOW_PRIORITY + JOIN を解析できる', () => {
      const result = expectParseOk(`
        UPDATE LOW_PRIORITY users u
        JOIN orders o ON o.user_id = u.id
        SET u.status = 'x'
        WHERE o.total > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.joins).toHaveLength(1);
    });

    it('DELETE LOW_PRIORITY + USE INDEX を解析できる', () => {
      const result = expectParseOk(`
        DELETE LOW_PRIORITY u
        FROM users u
        USE INDEX (idx_name)
        JOIN orders o ON o.user_id = u.id
        WHERE o.total > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('DELETE');
      expect(result.query.joins).toHaveLength(1);
    });

    it('SET の low_priority 列は修飾子として除去しない', () => {
      const result = expectParseOk(`
        UPDATE orders o
        JOIN users u ON u.id = o.user_id
        SET o.low_priority = 1
        WHERE u.id > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.setClauses?.some((c) => /low_priority/i.test(c.column) || /low_priority/i.test(c.label))).toBe(
        true,
      );
    });

    it('UPDATE IGNORE + JOIN を解析できる', () => {
      const result = expectParseOk(`
        UPDATE IGNORE users u
        JOIN orders o ON o.user_id = u.id
        SET u.status = 'x'
        WHERE o.total > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.joins).toHaveLength(1);
    });

    it('DELETE IGNORE + JOIN を解析できる', () => {
      const result = expectParseOk(`
        DELETE IGNORE u
        FROM users u
        JOIN orders o ON o.user_id = u.id
        WHERE o.total > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('DELETE');
      expect(result.query.joins).toHaveLength(1);
    });

    it('UPDATE LOW_PRIORITY IGNORE + JOIN を解析できる', () => {
      const result = expectParseOk(`
        UPDATE LOW_PRIORITY IGNORE users u
        JOIN orders o ON o.user_id = u.id
        SET u.status = 'x'
        WHERE o.total > 0
      `);
      if (!result.success) return;
      expect(result.query.statementType).toBe('UPDATE');
      expect(result.query.joins).toHaveLength(1);
    });
  });
});
