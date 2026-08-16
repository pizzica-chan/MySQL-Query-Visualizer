import { describe, expect, it } from 'vitest';
import { proveCqEquivalence, type CqEquivalenceStatus } from './cq-equivalence';
import { parseMySqlQuery } from './parser';

function prove(sqlA: string, sqlB: string) {
  const a = parseMySqlQuery(sqlA);
  const b = parseMySqlQuery(sqlB);
  if (!a.success) throw new Error(`SQL A 解析失敗: ${a.error.message}`);
  if (!b.success) throw new Error(`SQL B 解析失敗: ${b.error.message}`);
  return proveCqEquivalence(a.query, b.query);
}

function expectStatus(sqlA: string, sqlB: string, status: CqEquivalenceStatus) {
  const result = prove(sqlA, sqlB);
  expect(result.status, `${result.reason ?? ''}`).toBe(status);
  return result;
}

const JOIN_DISTINCT = `
  SELECT DISTINCT u.id, u.name
  FROM users u
  INNER JOIN orders o ON o.user_id = u.id
  WHERE u.active = 1 AND o.status = 'paid'
`;

const EXISTS_PLAIN = `
  SELECT u.id, u.name
  FROM users u
  WHERE u.active = 1
    AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid')
`;

const EXISTS_DISTINCT = `
  SELECT DISTINCT u.id, u.name
  FROM users u
  WHERE u.active = 1
    AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid')
`;

describe('EXISTS ↔ JOIN + DISTINCT（半結合）', () => {
  it('両方 DISTINCT なら結果セット一致を証明する', () => {
    expectStatus(JOIN_DISTINCT, EXISTS_DISTINCT, 'proven-equivalent');
  });

  it('DISTINCT が片側だけなら重複を除いた一致に留める', () => {
    expectStatus(JOIN_DISTINCT, EXISTS_PLAIN, 'proven-equivalent-set-only');
  });

  it('比較の向きを変えても同じ判定になる', () => {
    expectStatus(EXISTS_PLAIN, JOIN_DISTINCT, 'proven-equivalent-set-only');
  });

  it('相関条件が欠けていれば証明しない', () => {
    expectStatus(
      JOIN_DISTINCT,
      `SELECT DISTINCT u.id, u.name FROM users u
       WHERE u.active = 1 AND EXISTS (SELECT 1 FROM orders o WHERE o.status = 'paid')`,
      'not-proven',
    );
  });

  it('EXISTS 内の定数が違えば証明しない', () => {
    expectStatus(
      JOIN_DISTINCT,
      `SELECT DISTINCT u.id, u.name FROM users u
       WHERE u.active = 1
         AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'pending')`,
      'not-proven',
    );
  });

  it('外側の絞り込みが欠けていれば証明しない', () => {
    expectStatus(
      JOIN_DISTINCT,
      `SELECT DISTINCT u.id, u.name FROM users u
       WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid')`,
      'not-proven',
    );
  });

  it('EXISTS 内で結合先テーブルが違えば証明しない', () => {
    expectStatus(
      JOIN_DISTINCT,
      `SELECT DISTINCT u.id, u.name FROM users u
       WHERE u.active = 1
         AND EXISTS (SELECT 1 FROM refunds o WHERE o.user_id = u.id AND o.status = 'paid')`,
      'not-proven',
    );
  });
});

describe('合接クエリの正規化', () => {
  it('JOIN の記述順を入れ替えても証明する', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u
       INNER JOIN orders o ON o.user_id = u.id
       INNER JOIN items i ON i.order_id = o.id`,
      `SELECT DISTINCT u.id FROM orders o
       INNER JOIN items i ON i.order_id = o.id
       INNER JOIN users u ON o.user_id = u.id`,
      'proven-equivalent',
    );
  });

  it('WHERE と ON の書き換えを吸収する', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE o.status = 'paid'`,
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id AND o.status = 'paid'`,
      'proven-equivalent',
    );
  });

  it('カンマ結合と INNER JOIN を同一視する', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u, orders o WHERE o.user_id = u.id`,
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      'proven-equivalent',
    );
  });

  it('エイリアス名が違うだけなら証明する', () => {
    expectStatus(
      `SELECT DISTINCT a.id FROM users a INNER JOIN orders b ON b.user_id = a.id`,
      `SELECT DISTINCT x.id FROM users x INNER JOIN orders y ON y.user_id = x.id`,
      'proven-equivalent',
    );
  });

  it('等値の左右を入れ替えても証明する', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE 1 = u.active`,
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.active = 1`,
      'proven-equivalent',
    );
  });

  it('冗長な自己結合を畳み込む（集合として）', () => {
    expectStatus(
      `SELECT DISTINCT a.id FROM users a, users b WHERE a.id = b.id`,
      `SELECT DISTINCT a.id FROM users a`,
      'proven-equivalent',
    );
  });

  it('冗長な自己結合は DISTINCT なしなら重複数まで保証しない', () => {
    expectStatus(
      `SELECT a.id FROM users a, users b WHERE a.id = b.id`,
      `SELECT a.id FROM users a`,
      'proven-equivalent-set-only',
    );
  });

  it('DISTINCT なしで完全に同型なら重複数まで証明する', () => {
    expectStatus(
      `SELECT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE o.status = 'paid'`,
      `SELECT u.id FROM orders o INNER JOIN users u ON u.id = o.user_id WHERE o.status = 'paid'`,
      'proven-equivalent',
    );
  });
});

describe('結果が変わる差分は証明しない', () => {
  it('出力列が増えている', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      `SELECT DISTINCT u.id, u.name FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      'not-proven',
    );
  });

  it('出力列の別名が違う', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      `SELECT DISTINCT u.id AS user_id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      'not-proven',
    );
  });

  it('結合条件の列が違う', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.id = u.id`,
      'not-proven',
    );
  });

  it('絞り込み条件が増えている', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.active = 1`,
      'not-proven',
    );
  });

  it('結合先テーブルが増えている', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
      `SELECT DISTINCT u.id FROM users u
       INNER JOIN orders o ON o.user_id = u.id
       INNER JOIN items i ON i.order_id = o.id`,
      'not-proven',
    );
  });

  it('数値リテラルの表記が違えば証明しない（保守側）', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u WHERE u.active = 1`,
      `SELECT DISTINCT u.id FROM users u WHERE u.active = 1.0`,
      'not-proven',
    );
  });
});

describe('対象クラス外は必ず not-proven', () => {
  const same = `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`;

  const outOfScope: Array<[string, string]> = [
    ['LEFT JOIN', `SELECT DISTINCT u.id FROM users u LEFT JOIN orders o ON o.user_id = u.id`],
    ['RIGHT JOIN', `SELECT DISTINCT u.id FROM users u RIGHT JOIN orders o ON o.user_id = u.id`],
    [
      'OR',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.active = 1 OR u.active = 2`,
    ],
    [
      'NOT EXISTS',
      `SELECT DISTINCT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`,
    ],
    [
      'IN サブクエリ',
      `SELECT DISTINCT u.id FROM users u WHERE u.id IN (SELECT o.user_id FROM orders o)`,
    ],
    [
      'IS NULL',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.deleted_at IS NULL`,
    ],
    [
      '不等号',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.age > 20`,
    ],
    [
      'LIKE',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.name LIKE 'a%'`,
    ],
    [
      'BETWEEN',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.age BETWEEN 1 AND 2`,
    ],
    [
      '文字列リテラル同士の比較',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE 1 = 1`,
    ],
    [
      'GROUP BY',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id GROUP BY u.id`,
    ],
    [
      'LIMIT',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id LIMIT 10`,
    ],
    [
      'UNION',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id
       UNION SELECT x.id FROM users x`,
    ],
    ['CTE', `WITH t AS (SELECT id FROM users) SELECT DISTINCT t.id FROM t`],
    [
      '派生テーブル',
      `SELECT DISTINCT u.id FROM users u INNER JOIN (SELECT user_id FROM orders) o ON o.user_id = u.id`,
    ],
    ['ワイルドカード', `SELECT DISTINCT * FROM users u INNER JOIN orders o ON o.user_id = u.id`],
    [
      '関数式の出力列',
      `SELECT DISTINCT COUNT(u.id) FROM users u INNER JOIN orders o ON o.user_id = u.id`,
    ],
    [
      '未修飾カラム',
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE active = 1`,
    ],
    ['UPDATE 文', `UPDATE users u SET u.active = 1 WHERE u.id = 1`],
  ];

  for (const [label, sql] of outOfScope) {
    it(`${label} は判定しない`, () => {
      expectStatus(same, sql, 'not-proven');
      expectStatus(sql, same, 'not-proven');
      // 自分自身との比較でも「証明済み」にはしない
      expectStatus(sql, sql, 'not-proven');
    });
  }

  it('構文木に現れない対象外キーワードも字句レベルで弾く', () => {
    const parsed = parseMySqlQuery(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // 構文木は対象クラス内でも、元 SQL に対象外の語が残っていれば判定しない
    const tampered = { ...parsed.query, rawSql: `${parsed.query.rawSql} HAVING x > 1` };
    expect(proveCqEquivalence(tampered, parsed.query).status).toBe('not-proven');
    expect(proveCqEquivalence(parsed.query, tampered).status).toBe('not-proven');
  });

  it('元 SQL が失われている場合は判定しない', () => {
    const parsed = parseMySqlQuery(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id`,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const noRaw = { ...parsed.query, rawSql: '' };
    expect(proveCqEquivalence(noRaw, parsed.query).status).toBe('not-proven');
  });

  it('文字列リテラル内のキーワードでは弾かない', () => {
    expectStatus(
      `SELECT DISTINCT u.id FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE o.status = 'not null or between'`,
      `SELECT DISTINCT u.id FROM orders o INNER JOIN users u ON u.id = o.user_id WHERE o.status = 'not null or between'`,
      'proven-equivalent',
    );
  });

  it('末尾セミコロンがあっても判定できる', () => {
    expectStatus(
      `SELECT DISTINCT u.id, u.name FROM users u INNER JOIN orders o ON o.user_id = u.id WHERE u.active = 1 AND o.status = 'paid';`,
      `SELECT DISTINCT u.id, u.name FROM users u WHERE u.active = 1 AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid');`,
      'proven-equivalent',
    );
  });

  it('テーブル参照が上限を超えたら判定しない', () => {
    const many = `
      SELECT DISTINCT t1.id FROM t1
      INNER JOIN t2 ON t2.id = t1.id
      INNER JOIN t3 ON t3.id = t2.id
      INNER JOIN t4 ON t4.id = t3.id
      INNER JOIN t5 ON t5.id = t4.id
      INNER JOIN t6 ON t6.id = t5.id
      INNER JOIN t7 ON t7.id = t6.id
      INNER JOIN t8 ON t8.id = t7.id
      INNER JOIN t9 ON t9.id = t8.id
    `;
    expectStatus(many, many, 'not-proven');
  });
});
