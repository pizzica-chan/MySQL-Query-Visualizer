import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { compareQueryResults } from './query-result-diff';
import { buildVerificationSql } from './verification-sql';

function mustParse(sql: string) {
  const result = parseMySqlQuery(sql);
  if (!result.success) throw new Error(`${result.error.message}: ${sql}`);
  return result.query;
}

describe('buildVerificationSql', () => {
  it('A と B を両方の向きの EXCEPT ALL で突き合わせる', () => {
    const sql = buildVerificationSql(mustParse('SELECT u.id FROM users u'), mustParse('SELECT u.id FROM users u WHERE u.a = 1'));
    expect(sql).toBe(
      [
        '-- 1. A にあって B に無い行（同じ行が返る数も比べる）',
        '(\nSELECT u.id FROM users u\n)',
        'EXCEPT ALL',
        '(\nSELECT u.id FROM users u WHERE u.a = 1\n);',
        '',
        '-- 2. B にあって A に無い行',
        '(\nSELECT u.id FROM users u WHERE u.a = 1\n)',
        'EXCEPT ALL',
        '(\nSELECT u.id FROM users u\n);',
      ].join('\n'),
    );
  });

  it('末尾の ; とその後ろのコメントは除き、; の無い末尾のコメントは残して閉じ括弧の前で改行する', () => {
    const withSemicolon = buildVerificationSql(mustParse('SELECT 1 AS x;  -- 最後'), mustParse('SELECT 1 AS x'));
    expect(withSemicolon).toContain('(\nSELECT 1 AS x\n)\nEXCEPT ALL');
    expect(withSemicolon).not.toContain('最後');

    const withComment = buildVerificationSql(mustParse('SELECT 1 AS x -- 末尾'), mustParse('SELECT 1 AS x'));
    expect(withComment).toContain('(\nSELECT 1 AS x -- 末尾\n)');
  });

  it('文字列の中の ; は消さない', () => {
    const sql = buildVerificationSql(mustParse("SELECT 'a;' AS x"), mustParse("SELECT 'a;' AS x"));
    expect(sql).toContain("(\nSELECT 'a;' AS x\n)");
  });

  // 括弧で囲んだクエリには WITH を書けない（MySQL 8.4 リファレンス 15.2.11）ので、派生テーブルで囲む
  it('WITH を使う SQL は派生テーブルで囲む', () => {
    const sql = buildVerificationSql(
      mustParse('WITH c AS (SELECT u.id FROM users u) SELECT c.id FROM c'),
      mustParse('SELECT u.id FROM users u'),
    );
    expect(sql).toContain('SELECT * FROM (\nWITH c AS (SELECT u.id FROM users u) SELECT c.id FROM c\n) AS verify_a\nEXCEPT ALL\n(\nSELECT u.id FROM users u\n);');
  });

  it('UPDATE と DELETE では作らない（実行するとデータが変わる）', () => {
    expect(buildVerificationSql(mustParse('UPDATE users u SET u.a = 1'), mustParse('UPDATE users u SET u.a = 1'))).toBeNull();
    expect(buildVerificationSql(mustParse('SELECT u.id FROM users u'), mustParse('DELETE FROM users WHERE id = 1'))).toBeNull();
  });

  it('比較の結果に入る', () => {
    const diff = compareQueryResults(mustParse('SELECT u.id FROM users u'), mustParse('SELECT u.id FROM users u'));
    expect(diff.verificationSql).toContain('EXCEPT ALL');
  });
});
