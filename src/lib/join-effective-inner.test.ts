import { describe, expect, it } from 'vitest';
import {
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  parseMySqlQuery,
} from './parser';
import {
  analyzeEffectiveInnerJoins,
  formatEffectiveInnerCausePhrase,
  formatEffectiveInnerJoinScopeLine,
} from './join-effective-inner';

describe('join-effective-inner', () => {
  it('サンプル SQL で order_items LEFT JOIN が検出される', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const analyses = analyzeEffectiveInnerJoins(result.query);
    const oiJoin = result.query.joins.find((j) => j.type === 'LEFT JOIN' && j.condition.includes('oi.order_id'));
    expect(oiJoin).toBeDefined();

    const analysis = analyses.find((a) => a.joinId === oiJoin!.id);
    expect(analysis).toBeDefined();
    expect(analysis!.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('products'))).toBe(true);
    expect(analysis!.reasons.some((r) => r.kind === 'where' && r.label.includes('oi.quantity'))).toBe(true);
    expect(analysis!.reasons.some((r) => r.kind === 'having' && r.label.includes('oi.quantity'))).toBe(true);
  });

  it('サンプル SQL では categories LEFT JOIN は検出されない', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const cJoin = result.query.joins.find((j) => j.type === 'LEFT JOIN' && j.condition.includes('p.category_id'));
    expect(cJoin).toBeDefined();

    const analyses = analyzeEffectiveInnerJoins(result.query);
    expect(analyses.some((a) => a.joinId === cJoin!.id)).toBe(false);
  });

  it('LEFT JOIN のみでは検出されない', () => {
    const result = parseMySqlQuery(`
      SELECT * FROM table_a a
      LEFT JOIN table_b b ON b.a_id = a.id
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(analyzeEffectiveInnerJoins(result.query)).toHaveLength(0);
  });

  it('LEFT JOIN + WHERE on nullable 列のみ検出される', () => {
    const result = parseMySqlQuery(`
      SELECT * FROM table_a a
      LEFT JOIN table_b b ON b.a_id = a.id
      WHERE b.col = 1
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const analyses = analyzeEffectiveInnerJoins(result.query);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]!.reasons).toHaveLength(1);
    expect(analyses[0]!.reasons[0]!.kind).toBe('where');
    expect(analyses[0]!.reasons[0]!.label).toContain('b.col');
  });

  it('OR 配下の nullable 参照は検出しない（保守的）', () => {
    const result = parseMySqlQuery(`
      SELECT * FROM table_a a
      LEFT JOIN table_b b ON b.a_id = a.id
      WHERE b.col = 1 OR b.id IS NULL
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(analyzeEffectiveInnerJoins(result.query)).toHaveLength(0);
  });

  it('UPDATE サンプルで order_items LEFT JOIN が検出される', () => {
    const result = parseMySqlQuery(UPDATE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const analyses = analyzeEffectiveInnerJoins(result.query);
    expect(analyses.length).toBeGreaterThan(0);
    expect(analyses.some((a) => a.reasons.some((r) => r.kind === 'where' && r.label.includes('oi.quantity')))).toBe(
      true,
    );
  });

  it('RIGHT JOIN で nullable 側を参照する後続 INNER JOIN を検出する', () => {
    const result = parseMySqlQuery(`
      SELECT a.id, b.name, d.val
      FROM table_a a
      RIGHT JOIN table_b b ON b.a_id = a.id
      INNER JOIN table_d d ON d.a_id = a.id
    `);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const rightJoin = result.query.joins.find((j) => j.type === 'RIGHT JOIN');
    expect(rightJoin).toBeDefined();

    const analyses = analyzeEffectiveInnerJoins(result.query);
    const analysis = analyses.find((a) => a.joinId === rightJoin!.id);
    expect(analysis).toBeDefined();
    expect(analysis!.reasons.some((r) => r.kind === 'inner_join' && r.label.includes('table_d'))).toBe(true);
  });

  it('formatEffectiveInnerJoinScopeLine が結論ファーストで説明する', () => {
    const reasons = [{ kind: 'inner_join' as const, label: 'INNER JOIN products（p）' }];
    const line = formatEffectiveInnerJoinScopeLine(
      {
        id: 'join-1',
        type: 'LEFT JOIN',
        sourceId: 'tbl-o',
        targetId: 'tbl-oi',
        condition: 'oi.order_id = o.id',
      },
      'o',
      {
        id: 'tbl-oi',
        table: 'order_items',
        alias: 'oi',
        displayName: 'oi',
      },
      reasons,
    );

    expect(line.startsWith('o と order_items（oi）は実質 INNER JOIN')).toBe(true);
    expect(line).toContain('後続の INNER JOIN により');
    expect(line).not.toContain('WHERE');
    expect(line).not.toContain('HAVING');
    expect(line).not.toMatch(/^o の行をすべて残し/);
  });

  it('formatEffectiveInnerCausePhrase が原因種別ごとに文言を返す', () => {
    expect(
      formatEffectiveInnerCausePhrase([{ kind: 'inner_join', label: 'INNER JOIN p' }]),
    ).toBe('後続の INNER JOIN により');
    expect(formatEffectiveInnerCausePhrase([{ kind: 'where', label: 'WHERE: b.col = 1' }])).toBe(
      'WHERE により',
    );
    expect(
      formatEffectiveInnerCausePhrase([
        { kind: 'where', label: 'WHERE: b.col = 1' },
        { kind: 'having', label: 'HAVING: SUM(b.q) > 1' },
      ]),
    ).toBe('WHERE / HAVING により');
    expect(
      formatEffectiveInnerCausePhrase([
        { kind: 'inner_join', label: 'INNER JOIN p' },
        { kind: 'where', label: 'WHERE: oi.q = 1' },
      ]),
    ).toBe('後続の INNER JOIN により');
  });
});
