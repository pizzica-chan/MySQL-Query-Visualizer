import { describe, expect, it } from 'vitest';
import { findCodeRegions, preprocessSqlForParser, remapSourceSpan } from './sql-preprocess';

describe('sql-preprocess', () => {
  it('文字列リテラル内は code 領域に含めない', () => {
    const sql = "SELECT 'NOT A -- COMMENT' AS x, id FROM t";
    const regions = findCodeRegions(sql);
    expect(regions.some((r) => sql.slice(r.start, r.end).includes("'NOT A"))).toBe(false);
    expect(regions.some((r) => sql.slice(r.start, r.end).includes('FROM t'))).toBe(true);
  });

  it('USE INDEX 除去後も processedToOriginal で元位置に戻せる', () => {
    const sql = 'SELECT id FROM users USE INDEX (idx) u';
    const { sql: processed, processedToOriginal } = preprocessSqlForParser(sql);
    expect(processed).toBe('SELECT id FROM users  u');
    const idPos = processed.indexOf('id');
    const span = remapSourceSpan(processedToOriginal, { start: idPos, end: idPos + 2 });
    expect(sql.slice(span!.start, span!.end)).toBe('id');
  });

  it('DISTINCTROW と別 SELECT の STRAIGHT_JOIN ヒントを独立に処理する', () => {
    const sql = 'SELECT DISTINCTROW x UNION SELECT STRAIGHT_JOIN y FROM a JOIN b ON a.id = b.id';
    const { straightJoinHintSelectStarts, sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toContain('SELECT y FROM');
    expect(straightJoinHintSelectStarts).toHaveLength(1);
    const secondSelect = processed.indexOf('SELECT y');
    expect(straightJoinHintSelectStarts[0]).toBe(secondSelect);
  });

  it('連続 NATURAL JOIN の開始位置を最終 SQL で補正する', () => {
    const sql = 'SELECT * FROM a_table NATURAL JOIN b_table NATURAL LEFT JOIN c_table';
    const pre = preprocessSqlForParser(sql);
    expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('INNER JOIN'));
    expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('LEFT JOIN'));
  });

  it('NATURAL JOIN 置換区間の span は元の NATURAL JOIN 全体に戻る', () => {
    const sql = 'SELECT * FROM a_table NATURAL JOIN b_table';
    const { sql: processed, processedToOriginal } = preprocessSqlForParser(sql);
    const innerJoinAt = processed.indexOf('INNER JOIN');
    expect(innerJoinAt).toBeGreaterThanOrEqual(0);
    const span = remapSourceSpan(processedToOriginal, {
      start: innerJoinAt,
      end: innerJoinAt + 'INNER JOIN'.length,
    });
    expect(sql.slice(span!.start, span!.end)).toBe('NATURAL JOIN');
  });

  it('空白なしの -- はコメントにせず USE INDEX を除去する', () => {
    const sql = 'SELECT a--b FROM users USE INDEX (idx) u';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toContain('--b');
    expect(processed).not.toContain('USE INDEX');
    expect(processed).toBe('SELECT a--b FROM users  u');
  });

  it('空白ありの -- 行コメント内の NATURAL JOIN は置換しない', () => {
    const sql = 'SELECT * FROM a -- NATURAL JOIN b\nJOIN c ON c.id = a.id';
    const pre = preprocessSqlForParser(sql);
    expect(pre.sql).toContain('-- NATURAL JOIN b');
    expect(pre.naturalJoinStarts).toHaveLength(0);
  });

  it('# 行コメント内の USE INDEX は除去しない', () => {
    const sql = 'SELECT id FROM users u # USE INDEX (idx)\nJOIN orders o ON o.user_id = u.id';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toContain('# USE INDEX (idx)');
    expect(processed).not.toMatch(/\busers\s+JOIN orders\b/);
  });

  it('バッククォート付き USE INDEX を除去する', () => {
    const sql = 'SELECT id FROM users USE INDEX (`idx_name`) u';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toBe('SELECT id FROM users  u');
    expect(processed).not.toContain('USE INDEX');
  });

  it('括弧ネストを含む USE INDEX も除去する', () => {
    const sql = 'SELECT id FROM users USE INDEX (idx_a, (idx_b)) u';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toBe('SELECT id FROM users  u');
    expect(processed).not.toContain('USE INDEX');
  });

  it('閉じ括弧のない USE INDEX は除去しない', () => {
    const sql = 'SELECT id FROM users USE INDEX (idx';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toBe(sql);
    expect(processed).toContain('USE INDEX (idx');
  });

  it('SELECT と STRAIGHT_JOIN の間のコメントをまたいでヒントを除去する', () => {
    const sql = 'SELECT /* c */ STRAIGHT_JOIN u.id FROM a JOIN b ON a.id = b.id';
    const { sql: processed, straightJoinHintSelectStarts } = preprocessSqlForParser(sql);
    expect(processed).toContain('SELECT');
    expect(processed).not.toMatch(/\bSTRAIGHT_JOIN\b/i);
    expect(straightJoinHintSelectStarts).toHaveLength(1);
    expect(straightJoinHintSelectStarts[0]).toBe(processed.indexOf('SELECT'));
  });

  it('STRAIGHT_JOIN ヒントの originalSpan は SELECT から STRAIGHT_JOIN まで', () => {
    const sql = 'SELECT STRAIGHT_JOIN SQL_NO_CACHE u.id FROM a JOIN b ON a.id = b.id';
    const { straightJoinHintOriginalSpans } = preprocessSqlForParser(sql);
    expect(straightJoinHintOriginalSpans).toHaveLength(1);
    expect(sql.slice(straightJoinHintOriginalSpans[0]!.start, straightJoinHintOriginalSpans[0]!.end)).toBe(
      'SELECT STRAIGHT_JOIN',
    );
  });

  it('NATURAL と JOIN の間のコメントをまたいで置換する', () => {
    const sql = 'SELECT * FROM a NATURAL /* x */ JOIN b';
    const pre = preprocessSqlForParser(sql);
    expect(pre.sql).toContain('INNER JOIN');
    expect(pre.sql).not.toMatch(/\bNATURAL\b/i);
    expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('INNER JOIN'));
  });

  it('NATURAL LEFT OUTER JOIN を LEFT JOIN に正規化する', () => {
    const sql = 'SELECT * FROM a NATURAL LEFT OUTER JOIN b';
    const pre = preprocessSqlForParser(sql);
    expect(pre.sql).toContain('LEFT JOIN');
    expect(pre.sql).not.toMatch(/\bNATURAL\b/i);
    expect(pre.sql).not.toMatch(/\bOUTER\b/i);
    expect(pre.naturalJoinStarts).toContain(pre.sql.indexOf('LEFT JOIN'));
  });

  it('DISTINCTROW STRAIGHT_JOIN の後の SQL_SMALL_RESULT も除去する', () => {
    const sql =
      'SELECT DISTINCTROW STRAIGHT_JOIN SQL_SMALL_RESULT u.id FROM a JOIN b ON a.id = b.id';
    const { sql: processed, straightJoinHintSelectStarts } = preprocessSqlForParser(sql);
    expect(processed).toMatch(/SELECT\s+DISTINCT\s+u\.id/);
    expect(processed).not.toMatch(/\bSTRAIGHT_JOIN\b/i);
    expect(processed).not.toMatch(/\bSQL_SMALL_RESULT\b/i);
    expect(straightJoinHintSelectStarts).toHaveLength(1);
  });

  it('SELECT 修飾子と同名のエイリアス・WHERE 識別子は除去しない', () => {
    const sql =
      'SELECT u.id AS sql_no_cache FROM users u JOIN orders o ON o.user_id = u.id WHERE o.high_priority = 1';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toContain('AS sql_no_cache');
    expect(processed).toContain('o.high_priority');
    expect(processed).toBe(sql);
  });

  it('UPDATE SET の low_priority 列は除去せず、文頭の LOW_PRIORITY だけ除去する', () => {
    const withModifier =
      'UPDATE LOW_PRIORITY orders o JOIN users u ON u.id = o.user_id SET o.status = 1';
    const { sql: processedModifier } = preprocessSqlForParser(withModifier);
    expect(processedModifier).toMatch(/^UPDATE\s+orders\b/);
    expect(processedModifier).not.toMatch(/\bLOW_PRIORITY\b/i);

    const asColumn =
      'UPDATE orders o JOIN users u ON u.id = o.user_id SET o.low_priority = 1';
    const { sql: processedColumn } = preprocessSqlForParser(asColumn);
    expect(processedColumn).toContain('o.low_priority');
    expect(processedColumn).toBe(asColumn);
  });

  it('文頭の IGNORE は除去し、SET / WHERE の ignore 識別子は残す', () => {
    const updateIgnore =
      'UPDATE IGNORE orders o JOIN users u ON u.id = o.user_id SET o.status = 1';
    const { sql: processedUpdate } = preprocessSqlForParser(updateIgnore);
    expect(processedUpdate).toMatch(/^UPDATE\s+orders\b/);
    expect(processedUpdate).not.toMatch(/\bIGNORE\b/i);

    const deleteIgnore =
      'DELETE IGNORE u FROM users u JOIN orders o ON o.user_id = u.id WHERE o.total > 0';
    const { sql: processedDelete } = preprocessSqlForParser(deleteIgnore);
    expect(processedDelete).toMatch(/^DELETE\s+u\b/);
    expect(processedDelete).not.toMatch(/\bIGNORE\b/i);

    const asColumn =
      'UPDATE orders o JOIN users u ON u.id = o.user_id SET o.ignore = 1 WHERE u.ignore = 0';
    const { sql: processedColumn } = preprocessSqlForParser(asColumn);
    expect(processedColumn).toContain('o.ignore');
    expect(processedColumn).toContain('u.ignore');
    expect(processedColumn).toBe(asColumn);
  });

  it('UPDATE LOW_PRIORITY IGNORE をまとめて除去する', () => {
    const sql =
      'UPDATE LOW_PRIORITY IGNORE orders o JOIN users u ON u.id = o.user_id SET o.status = 1';
    const { sql: processed } = preprocessSqlForParser(sql);
    expect(processed).toMatch(/^UPDATE\s+orders\b/);
    expect(processed).not.toMatch(/\bLOW_PRIORITY\b/i);
    expect(processed).not.toMatch(/\bIGNORE\b/i);
  });

  it('DISTINCTROW を SELECT 修飾子のときだけ DISTINCT にする', () => {
    const asModifier = 'SELECT DISTINCTROW id FROM users';
    expect(preprocessSqlForParser(asModifier).sql).toBe('SELECT DISTINCT id FROM users');

    const asAlias =
      'SELECT u.id AS distinctrow FROM users u JOIN orders o ON o.user_id = u.id';
    expect(preprocessSqlForParser(asAlias).sql).toContain('AS distinctrow');
  });
});
