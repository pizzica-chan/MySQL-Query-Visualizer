import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { residualTokenDiff } from './residual-token-diff';

function mustParse(sql: string) {
  const result = parseMySqlQuery(sql);
  if (!result.success) throw new Error(`${result.error.message}: ${sql}`);
  return result.query;
}

function diff(sqlA: string, sqlB: string) {
  return residualTokenDiff(mustParse(sqlA), mustParse(sqlB));
}

const NO_DIFF = { onlyA: [], onlyB: [] };

describe('residualTokenDiff', () => {
  it('別名の付け替え・JOIN 種別の書き方・AND の並べ替えでは過不足が出ない', () => {
    expect(
      diff(
        'SELECT u.id FROM users u INNER JOIN orders AS o ON o.uid = u.id WHERE o.x = 1 AND u.y = 2',
        'SELECT usr.id FROM users usr JOIN orders ord ON usr.id = ord.uid WHERE usr.y = 2 AND ord.x = 1;',
      ),
    ).toEqual(NO_DIFF);
  });

  it('コメントは数えず、文字列リテラルは 1 つの字句として比べる', () => {
    expect(
      diff(
        "SELECT t.id FROM t WHERE t.n = 'a b' /* x y */",
        "SELECT t.id FROM t WHERE t.n = 'a b' -- z",
      ),
    ).toEqual(NO_DIFF);
    expect(
      diff("SELECT t.id FROM t WHERE t.n = 'a b'", "SELECT t.id FROM t WHERE t.n = 'a c'"),
    ).toEqual({ onlyA: ["'a b'"], onlyB: ["'a c'"] });
  });

  it('インデックスヒントは数えない', () => {
    expect(
      diff('SELECT t.id FROM t USE INDEX (i1, i2)', 'SELECT t.id FROM t IGNORE KEY FOR ORDER BY (i3)'),
    ).toEqual(NO_DIFF);
  });

  it('最上位の ORDER BY 句は数えない（並び順は ORDER BY カテゴリが扱う）', () => {
    expect(diff('SELECT t.id FROM t', 'SELECT t.id FROM t ORDER BY t.x DESC, t.y')).toEqual(NO_DIFF);
  });

  it('サブクエリの中の ORDER BY は数える', () => {
    expect(
      diff(
        'SELECT d.x FROM (SELECT t.x FROM t ORDER BY t.x LIMIT 3) d',
        'SELECT d.x FROM (SELECT t.x FROM t ORDER BY t.x DESC LIMIT 3) d',
      ),
    ).toEqual({ onlyA: [], onlyB: ['desc'] });
  });

  it('USING は列ごとの等値比較と同じ個数に揃える', () => {
    expect(
      diff(
        'SELECT a.x FROM a JOIN b USING (id, kind)',
        'SELECT a.x FROM a JOIN b ON a.id = b.id AND a.kind = b.kind',
      ),
    ).toEqual(NO_DIFF);
  });

  it('同じ字句でも個数が違えば過不足として返す', () => {
    expect(
      diff('SELECT t.id FROM t WHERE t.a = 1 OR t.a = 1', 'SELECT t.id FROM t WHERE t.a = 1'),
    ).toEqual({ onlyA: ['a', '=', '1', 'or'], onlyB: [] });
  });

  it('元 SQL を持たない ParsedQuery は比較しない', () => {
    const query = mustParse('SELECT t.id FROM t');
    expect(residualTokenDiff({ ...query, rawSql: '' }, mustParse('SELECT t.x FROM u'))).toEqual(NO_DIFF);
  });
});
