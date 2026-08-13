import { describe, expect, it } from 'vitest';
import { isInnerJoinType } from './join-effective-inner';
import { formatJoinDisplayType, parseMySqlQuery } from './parser';
import type { JoinType } from './types';

function expectParseOk(sql: string) {
  const result = parseMySqlQuery(sql);
  expect(result.success, result.success ? '' : result.error.message).toBe(true);
  return result;
}

function expectWrittenInnerJoin(type: JoinType | undefined) {
  expect(type).toBeDefined();
  expect(isInnerJoinType(type!)).toBe(true);
  expect(type).not.toBe('STRAIGHT JOIN');
}

describe('STRAIGHT_JOIN', () => {
  it('FROM 句の STRAIGHT_JOIN を解析し種別を保持する', () => {
    const sql = `
      SELECT u.id, o.total
      FROM users u
      STRAIGHT_JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.joins[0]?.type).toBe('STRAIGHT JOIN');
    expect(formatJoinDisplayType(result.query.joins[0]!)).toBe('STRAIGHT JOIN');
    expect(result.query.straightJoinHint).toBeFalsy();
  });

  it('SELECT 直後の STRAIGHT_JOIN ヒントは JOIN 種別を書き換えない', () => {
    const sql = `
      SELECT STRAIGHT_JOIN u.id, o.total
      FROM users u
      JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('SELECT と STRAIGHT_JOIN の間にコメントがあっても解析できる', () => {
    const sql = `
      SELECT /* optimizer */ STRAIGHT_JOIN u.id
      FROM users u
      JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('SELECT DISTINCT と STRAIGHT_JOIN の間にコメントがあっても解析できる', () => {
    const sql = `
      SELECT DISTINCT /* c */ STRAIGHT_JOIN u.id
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
    expect(result.query.distinct).toBe(true);
  });

  it('SELECT DISTINCT STRAIGHT_JOIN も解析できる', () => {
    const sql = `
      SELECT DISTINCT STRAIGHT_JOIN u.id
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
    expect(result.query.distinct).toBe(true);
  });

  it('サブクエリ内の SELECT STRAIGHT_JOIN ヒントも個別に反映する', () => {
    const sql = `
      SELECT *
      FROM (
        SELECT STRAIGHT_JOIN u.id
        FROM users u
        JOIN orders o ON o.user_id = u.id
      ) t
      JOIN categories c ON c.id = t.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    const derived = result.query.tables.find((t) => t.isDerived);
    expect(derived?.derivedQuery?.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(derived?.derivedQuery?.joins[0]?.type);
    expect(result.query.straightJoinHint).toBeFalsy();
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('UNION 後段の SELECT STRAIGHT_JOIN ヒントを反映する', () => {
    const sql = `
      SELECT DISTINCTROW u.id FROM users u
      UNION ALL
      SELECT STRAIGHT_JOIN o.id
      FROM orders o
      JOIN users u ON u.id = o.user_id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.unionBranches?.[1]?.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.unionBranches?.[1]?.query.joins[0]?.type);
    expect(result.query.unionBranches?.[0]?.query.joins).toHaveLength(0);
    expect(result.query.unionBranches?.[0]?.query.straightJoinHint).toBeFalsy();
  });

  it('SELECT STRAIGHT_JOIN でも LEFT JOIN は維持する', () => {
    const sql = `
      SELECT STRAIGHT_JOIN u.id, p.name
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expect(result.query.joins[0]?.type).toBe('LEFT JOIN');
  });

  it('SELECT STRAIGHT_JOIN 除去後も列 sourceSpan が元 SQL を指す', () => {
    const sql = 'SELECT STRAIGHT_JOIN u.id FROM users u JOIN orders o ON o.user_id = u.id';
    const result = expectParseOk(sql);
    if (!result.success) return;

    const span = result.query.columns[0]?.sourceSpan;
    expect(span).toBeDefined();
    expect(sql.slice(span!.start, span!.end)).toBe('u.id');
  });

  it('SELECT STRAIGHT_JOIN 除去後も ON 条件 conditionRoot の sourceSpan が元 SQL を指す', () => {
    const sql = 'SELECT STRAIGHT_JOIN u.id FROM users u JOIN orders o ON o.user_id = u.id';
    const result = expectParseOk(sql);
    if (!result.success) return;

    const onSpan = result.query.joins[0]?.conditionRoot?.sourceSpan;
    expect(onSpan).toBeDefined();
    expect(sql.slice(onSpan!.start, onSpan!.end)).toBe('o.user_id = u.id');
  });

  it('SELECT STRAIGHT_JOIN 除去後も列エイリアスまで sourceSpan が伸びる', () => {
    const sql = 'SELECT STRAIGHT_JOIN u.id AS uid FROM users u JOIN orders o ON o.user_id = u.id';
    const result = expectParseOk(sql);
    if (!result.success) return;

    const span = result.query.columns[0]?.sourceSpan;
    expect(span).toBeDefined();
    expect(sql.slice(span!.start, span!.end)).toBe('u.id AS uid');
  });

  it('WITH 付きの SELECT STRAIGHT_JOIN ヒントを外側に付ける', () => {
    const sql = `
      WITH cte AS (SELECT id FROM users)
      SELECT STRAIGHT_JOIN cte.id
      FROM cte
      JOIN orders o ON o.user_id = cte.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('CTE 内の SELECT STRAIGHT_JOIN ヒントは外側 JOIN に漏らさない', () => {
    const sql = `
      WITH cte AS (
        SELECT STRAIGHT_JOIN u.id
        FROM users u
        JOIN orders o ON o.user_id = u.id
      )
      SELECT cte.id
      FROM cte
      JOIN categories c ON c.id = cte.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.ctes?.[0]?.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.ctes?.[0]?.query.joins[0]?.type);
    expect(result.query.straightJoinHint).toBeFalsy();
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('SELECT 先頭のスカラーサブクエリ内ヒントは外側 JOIN に漏らさない', () => {
    const sql = `
      SELECT (SELECT STRAIGHT_JOIN a.id FROM users a JOIN orders b ON a.id = b.user_id) AS x
      FROM categories c
      JOIN products p ON p.category_id = c.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBeFalsy();
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('WITH 付きでも先頭スカラーサブクエリ内ヒントは外側に漏らさない', () => {
    const sql = `
      WITH cte AS (SELECT id FROM users)
      SELECT (SELECT STRAIGHT_JOIN a.id FROM users a JOIN orders b ON a.id = b.user_id) AS x
      FROM cte
      JOIN categories c ON c.id = cte.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBeFalsy();
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('WITH 付き SELECT STRAIGHT_JOIN で先頭がスカラーサブクエリでも外側に付ける', () => {
    const sql = `
      WITH cte AS (SELECT id FROM users)
      SELECT STRAIGHT_JOIN (SELECT a.id FROM users a) AS x
      FROM cte
      JOIN categories c ON c.id = cte.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
  });

  it('SELECT DISTINCTROW STRAIGHT_JOIN SQL_SMALL_RESULT を解析できる', () => {
    const sql = `
      SELECT DISTINCTROW STRAIGHT_JOIN SQL_SMALL_RESULT u.id
      FROM users u
      JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
    expect(result.query.distinct).toBe(true);
    expect(result.query.columns[0]?.expression).toBe('u.id');
  });

  it('SELECT STRAIGHT_JOIN SQL_NO_CACHE を解析できる', () => {
    const sql = `
      SELECT STRAIGHT_JOIN SQL_NO_CACHE u.id
      FROM users u
      JOIN orders o ON o.user_id = u.id
    `;
    const result = expectParseOk(sql);
    if (!result.success) return;

    expect(result.query.straightJoinHint).toBe(true);
    expectWrittenInnerJoin(result.query.joins[0]?.type);
    expect(result.query.columns[0]?.expression).toBe('u.id');
    const hintSpan = result.query.straightJoinHintSpan;
    expect(hintSpan).toBeDefined();
    expect(result.query.rawSql.slice(hintSpan!.start, hintSpan!.end).trim()).toMatch(/^SELECT\s+STRAIGHT_JOIN$/i);
  });
});
