import { describe, expect, it } from 'vitest';
import { highlightSqlToHtml, tokenizeSql } from './sql-highlight';

function kinds(sql: string) {
  return tokenizeSql(sql).filter((t) => t.kind !== 'plain');
}

describe('sql-highlight', () => {
  it('SELECT / JOIN キーワードをハイライトする', () => {
    const tokens = kinds('SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id');
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'SELECT')).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'INNER JOIN')).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'FROM')).toBe(true);
  });

  it('STRAIGHT_JOIN をキーワードとしてハイライトする', () => {
    const tokens = kinds('SELECT STRAIGHT_JOIN u.id FROM users u STRAIGHT_JOIN orders o ON o.user_id = u.id');
    expect(tokens.filter((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'STRAIGHT_JOIN')).toHaveLength(2);
  });

  it('SELECT / DML 修飾子をキーワードとしてハイライトする', () => {
    const selectTokens = kinds(
      'SELECT DISTINCTROW HIGH_PRIORITY SQL_SMALL_RESULT SQL_BIG_RESULT SQL_BUFFER_RESULT SQL_NO_CACHE SQL_CALC_FOUND_ROWS u.id FROM users u',
    );
    for (const keyword of [
      'DISTINCTROW',
      'HIGH_PRIORITY',
      'SQL_SMALL_RESULT',
      'SQL_BIG_RESULT',
      'SQL_BUFFER_RESULT',
      'SQL_NO_CACHE',
      'SQL_CALC_FOUND_ROWS',
    ]) {
      expect(selectTokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === keyword), keyword).toBe(
        true,
      );
    }
    expect(selectTokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'DISTINCT')).toBe(false);

    const updateTokens = kinds(
      'UPDATE LOW_PRIORITY orders o JOIN users u ON u.id = o.user_id SET o.status = 1',
    );
    expect(updateTokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'LOW_PRIORITY')).toBe(true);
  });

  it('# 行コメントをハイライトする', () => {
    const tokens = kinds('SELECT id FROM t # USE INDEX (idx)\nJOIN u ON u.id = t.id');
    expect(tokens.some((t) => t.kind === 'comment' && t.text.includes('USE INDEX'))).toBe(true);
    expect(tokens.some((t) => t.kind === 'keyword' && t.text.toUpperCase() === 'JOIN')).toBe(true);
  });

  it('文字列リテラルとコメントをハイライトする', () => {
    const tokens = kinds("WHERE name = 'O''Reilly' -- comment\n/* block */");
    expect(tokens.some((t) => t.kind === 'string' && t.text === "'O''Reilly'")).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '-- comment')).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '/* block */')).toBe(true);
  });

  it('空白なしの -- はコメントにしない', () => {
    const tokens = tokenizeSql('SELECT a--b FROM t');
    expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
    expect(tokens.map((t) => t.text).join('')).toBe('SELECT a--b FROM t');
  });

  it('>= などの演算子をリテラル表示する', () => {
    const tokens = kinds('WHERE amount >= 100 AND qty <= 5');
    expect(tokens.some((t) => t.kind === 'operator' && t.text === '>=')).toBe(true);
    expect(tokens.some((t) => t.kind === 'operator' && t.text === '<=')).toBe(true);
    expect(highlightSqlToHtml('>=')).toContain('&gt;=');
    expect(highlightSqlToHtml('>=')).not.toContain('≧');
  });

  it('HTML 特殊文字をエスケープする', () => {
    const html = highlightSqlToHtml("WHERE tag = '<script>'");
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('focusSpan で該当範囲に focus クラスを付ける', () => {
    const sql = 'SELECT id FROM users';
    const html = highlightSqlToHtml(sql, { start: 7, end: 9 });
    expect(html).toContain('sql-hl--focus">id</span>');
    expect(html).not.toContain('sql-hl--focus">SELECT');
  });

  it('focusSpan は plain トークン結合時も列単位で部分ハイライトする', () => {
    const sql = 'SELECT\n  u.id,\n  u.name,\n  u.email\nFROM users u';
    const nameStart = sql.indexOf('u.name');
    const nameEnd = nameStart + 'u.name'.length;
    const idHtml = highlightSqlToHtml(sql, { start: sql.indexOf('u.id'), end: sql.indexOf('u.id') + 'u.id'.length });
    const nameHtml = highlightSqlToHtml(sql, { start: nameStart, end: nameEnd });

    expect(idHtml.match(/sql-hl--focus/g)).toHaveLength(1);
    expect(idHtml).toContain('sql-hl--focus">u.id</span>');
    expect(idHtml).not.toMatch(/sql-hl--focus">[^<]*u\.name/);
    expect(nameHtml).toMatch(/sql-hl--focus">u\.name</);
    expect(nameHtml).not.toMatch(/sql-hl--focus">[^<]*u\.email/);
  });

  it('別名や列名の中の数字は数値の色にしない（u1、order2、t.1st）', () => {
    const tokens = kinds('SELECT u1.id, t.1st, order2 FROM users u1, t WHERE u1.total > 10 AND x = .5 AND y = 1.5e3');
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['10', '.5', '1.5e3']);
  });

  it('ASCII 以外の文字を含む識別子と、数字で始まる識別子の数字は数値の色にしない', () => {
    const tokens = kinds('SELECT テーブル1.列2, 1st_col, 1e5, 2 FROM テーブル1 WHERE 列2 > 3');
    expect(tokens.filter((t) => t.kind === 'number').map((t) => t.text)).toEqual(['1e5', '2', '3']);
  });

  it('ASCII 以外の文字が続く語はキーワードにしない（SELECT日付）', () => {
    const tokens = kinds('SELECT SELECT日付 FROM t');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['SELECT', 'FROM']);
  });

  it('語の途中のキーワードはキーワードにしない（selection、fromage、u_on）', () => {
    const tokens = kinds('SELECT selection, fromage, u_on FROM t');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['SELECT', 'FROM']);
  });

  it('長い SQL でも短い時間で色分けする（文字ごとに正規表現を作り直さない）', () => {
    const sql = Array.from(
      { length: 1500 },
      (_, i) => `SELECT u${i}.id, u${i}.name FROM users u${i} JOIN orders o${i} ON o${i}.user_id = u${i}.id WHERE o${i}.total > ${i}`,
    ).join('\nUNION ALL\n');
    const started = performance.now();
    const restored = tokenizeSql(sql).map((t) => t.text).join('');
    const elapsed = performance.now() - started;
    expect(restored).toBe(sql);
    // 直す前は 1 秒を超えていた。遅い CI でも通るよう、余裕を持たせる
    expect(elapsed).toBeLessThan(400);
  });

  it('原文を欠落なく復元できる', () => {
    const sql = "SELECT * FROM t WHERE x >= 1 AND name = 'a''b' -- end";
    const restored = tokenizeSql(sql).map((t) => t.text).join('');
    expect(restored).toBe(sql);
  });
});
