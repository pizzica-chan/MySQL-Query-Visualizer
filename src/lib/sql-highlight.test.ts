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

  it('文字列リテラルとコメントをハイライトする', () => {
    const tokens = kinds("WHERE name = 'O''Reilly' -- comment\n/* block */");
    expect(tokens.some((t) => t.kind === 'string' && t.text === "'O''Reilly'")).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '-- comment')).toBe(true);
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '/* block */')).toBe(true);
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

  it('原文を欠落なく復元できる', () => {
    const sql = "SELECT * FROM t WHERE x >= 1 AND name = 'a''b' -- end";
    const restored = tokenizeSql(sql).map((t) => t.text).join('');
    expect(restored).toBe(sql);
  });
});
