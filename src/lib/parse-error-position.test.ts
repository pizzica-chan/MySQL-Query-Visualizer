import { describe, expect, it } from 'vitest';
import { lineColumnAt, parseMySqlQuery } from './parser';

function errorOf(sql: string) {
  const result = parseMySqlQuery(sql);
  if (result.success) throw new Error(`解析に成功してしまった: ${sql}`);
  return result.error;
}

describe('構文エラーの位置', () => {
  it('エラーの範囲を入力 SQL 上のオフセットで返し、メッセージに行と列を入れる', () => {
    const sql = 'SELECT a,\n FROM t';
    const error = errorOf(sql);
    expect(error.span).toBeDefined();
    // 「a,」の後ろに列が無く、FROM の位置で解釈できなくなる
    expect(sql.slice(error.span!.start, error.span!.end).trim().length).toBeGreaterThan(0);
    const { line, column } = lineColumnAt(sql, error.span!.start);
    expect(error.message).toContain(`${line} 行 ${column} 列`);
    expect(error.position).toBe(error.span!.start);
  });

  it('先頭に空行や字下げがあっても、位置が手前にずれない', () => {
    const body = 'SELECT a FROM t WHERE x = = 1';
    const plain = errorOf(body);
    const indented = errorOf(`\n\n    ${body}`);
    expect(indented.span!.start - plain.span!.start).toBe(6);
  });

  it('文の途中で入力が終わったときは、最後の空白でない 1 文字を範囲にする', () => {
    const sql = 'SELECT a FROM t WHERE   \n';
    const error = errorOf(sql);
    const contentEnd = sql.trimEnd().length;
    expect(error.span).toEqual({ start: contentEnd - 1, end: contentEnd });
  });

  it('前処理で書き換える構文（NATURAL JOIN）の後ろのエラーも、元の SQL の位置に戻す', () => {
    const sql = 'SELECT a FROM t NATURAL JOIN u WHERE ) = 1';
    const error = errorOf(sql);
    expect(sql.slice(error.span!.start, error.span!.end)).toBe(')');
  });

  it('文種の誤りなど、位置を持たないエラーは範囲を返さない', () => {
    const error = errorOf('INSERT INTO t VALUES (1)');
    expect(error.span).toBeUndefined();
  });
});

describe('lineColumnAt', () => {
  it('1 始まりの行と列を返す', () => {
    expect(lineColumnAt('abc\ndef', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumnAt('abc\ndef', 5)).toEqual({ line: 2, column: 2 });
  });
});
