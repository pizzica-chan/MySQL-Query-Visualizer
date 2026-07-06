import { describe, expect, it } from 'vitest';
import { formatJoinDisplayType, parseMySqlQuery } from './parser';
import { buildQueryEffect, collectJoinFilterNodes, collectLeafTexts } from './query-effect';
import { applyAliasResolution } from './alias-resolver';

describe('WITH（CTE）', () => {
  it('WITH 句をパースし CTE 定義と FROM 参照を紐付ける', () => {
    const sql = `
      WITH active_users AS (
        SELECT id, name FROM users WHERE status = 'active'
      )
      SELECT au.id, au.name
      FROM active_users au
      JOIN orders o ON o.user_id = au.id
    `;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.query.ctes).toHaveLength(1);
    expect(result.query.ctes![0]!.name).toBe('active_users');
    expect(result.query.ctes![0]!.query.tables[0]?.table).toBe('users');

    const cteTable = result.query.tables.find((t) => t.table === 'active_users');
    expect(cteTable?.isDerived).toBe(true);
    expect(cteTable?.displayName).toBe('active_users（CTE）');
    expect(cteTable?.derivedQuery?.tables[0]?.table).toBe('users');
  });

  it('作用説明の結合するテーブル欄に CTE を表示する', () => {
    const sql = `
      WITH cte AS (SELECT id FROM users)
      SELECT cte.id FROM cte
    `;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const scope = buildQueryEffect(result.query).sections.find((s) => s.kind === 'scope');
    expect(scope?.lines?.some((l) => l.text.includes('cte（CTE）'))).toBe(true);
  });
});

describe('NATURAL JOIN', () => {
  it('NATURAL JOIN をパースし isNatural フラグを付与する', () => {
    const sql = `
      SELECT *
      FROM users u
      NATURAL JOIN orders o
    `;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const join = result.query.joins[0]!;
    expect(join.isNatural).toBe(true);
    expect(formatJoinDisplayType(join)).toBe('NATURAL INNER JOIN');
  });

  it('NATURAL LEFT JOIN も表示種別に反映する', () => {
    const sql = `
      SELECT *
      FROM users u
      NATURAL LEFT JOIN profiles p
    `;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const join = result.query.joins[0]!;
    expect(join.isNatural).toBe(true);
    expect(formatJoinDisplayType(join)).toBe('NATURAL LEFT JOIN');

    const optional = buildQueryEffect(result.query).sections
      .find((s) => s.title === '結合するテーブル')
      ?.presenceGroups?.find((g) => g.kind === 'optional');
    expect(optional?.entries.some((e) => e.join?.root.label === 'NATURAL LEFT JOIN')).toBe(true);
  });

  it('エイリアス解決後も NATURAL 表示を維持する', () => {
    const sql = `SELECT * FROM users u NATURAL JOIN orders o`;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = applyAliasResolution(result.query, true);
    expect(formatJoinDisplayType(resolved.joins[0]!)).toBe('NATURAL INNER JOIN');
  });

  it('作用説明の結合条件に NATURAL 種別を表示する', () => {
    const sql = `
      SELECT u.id
      FROM users u
      NATURAL INNER JOIN orders o
      WHERE u.status = 'active'
    `;
    const result = parseMySqlQuery(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const filter = buildQueryEffect(result.query).sections.find((s) => s.title === '行の絞り込み');
    const joinPart = filter?.filterParts?.find((p) => p.label === '結合条件');
    const joinNode = joinPart?.root ? collectJoinFilterNodes(joinPart.root)[0] : undefined;
    expect(joinNode?.label).toBe('NATURAL INNER JOIN');
    expect(collectLeafTexts(joinNode!.children![0]!)).toEqual(['NATURAL JOIN']);
  });
});
