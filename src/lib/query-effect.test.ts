import { describe, expect, it } from 'vitest';
import {
  DELETE_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  parseMySqlQuery,
} from './parser';
import {
  buildConditionEffectTree,
  buildQueryEffect,
  buildUnionQueryEffect,
  collectLeafTexts,
} from './query-effect';

function allLeafTexts(effect: ReturnType<typeof buildQueryEffect>): string[] {
  return effect.sections.flatMap((s) =>
    s.conditionRoot ? collectLeafTexts(s.conditionRoot) : (s.lines ?? []),
  );
}

describe('query-effect', () => {
  it('SELECT サンプルで表示対象の要約を生成する', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.action).toBe('select');
    expect(effect.summary).toContain('表示');
    expect(effect.summary).toContain('100');

    const scope = effect.sections.find((s) => s.kind === 'scope');
    expect(scope?.lines?.some((l) => l.includes('INNER JOIN'))).toBe(true);

    const where = effect.sections.find((s) => s.kind === 'filter' && s.title?.includes('WHERE'));
    expect(where?.conditionRoot?.type).toBe('and');
    expect(collectLeafTexts(where!.conditionRoot!).some((t) => t.includes('active'))).toBe(true);

    expect(effect.sections.some((s) => s.kind === 'aggregate')).toBe(true);
  });

  it('SELECT サンプルで order_items LEFT JOIN に実質 INNER JOIN 注釈を付ける', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    const scope = effect.sections.find((s) => s.kind === 'scope');

    const oiLine = scope?.lines?.find((l) => l.includes('oi.order_id = o.id'));
    expect(oiLine).toBeDefined();
    expect(oiLine!.startsWith('o と order_items（oi）は実質 INNER JOIN')).toBe(true);
    expect(oiLine).toContain('後続の INNER JOIN により');
    expect(oiLine).not.toContain('WHERE / HAVING');

    const categoriesLine = scope?.lines?.find(
      (l) => l.includes('LEFT JOIN') && l.includes('p.category_id'),
    );
    expect(categoriesLine).toBeDefined();
    expect(categoriesLine).not.toContain('は実質 INNER JOIN');
  });

  it('UPDATE サンプルで更新対象と SET を含む', () => {
    const result = parseMySqlQuery(UPDATE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.action).toBe('update');
    expect(effect.summary).toContain('更新');
    expect(effect.sections.some((s) => s.kind === 'change' && s.lines?.some((l) => l.includes('inactive')))).toBe(
      true,
    );
    expect(effect.sections.some((s) => s.conditionRoot?.type === 'and')).toBe(true);
  });

  it('DELETE サンプルで削除対象テーブルを示す', () => {
    const result = parseMySqlQuery(DELETE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.summary).toContain('削除');
    expect(
      effect.sections.some((s) => s.lines?.some((l) => l.includes('users') && l.includes('order_items'))),
    ).toBe(true);
  });

  it('UNION サンプルでブランチごとの効果を生成する', () => {
    const result = parseMySqlQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const unionEffect = buildUnionQueryEffect(result.query);
    expect(unionEffect?.branches).toHaveLength(3);
    expect(unionEffect?.branches[2]?.effect.summary).toContain('guest_users');
    expect(allLeafTexts(unionEffect!.branches[2]!.effect).some((t) => t.includes('関連行'))).toBe(true);
  });

  it('buildConditionEffectTree が AND 配下を入れ子にする', () => {
    const result = parseMySqlQuery('SELECT * FROM t WHERE a = 1 AND b = 2');
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('and');
    expect(tree.children).toHaveLength(2);
    expect(collectLeafTexts(tree)).toHaveLength(2);
  });

  it('buildConditionEffectTree が OR グループを保持する', () => {
    const result = parseMySqlQuery("SELECT * FROM t WHERE x = 1 OR y = 2 OR z = 3");
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('or');
    expect(collectLeafTexts(tree)).toHaveLength(3);
  });

  it('buildConditionEffectTree が AND 内の OR を入れ子にする', () => {
    const result = parseMySqlQuery('SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3)');
    expect(result.success).toBe(true);
    if (!result.success || !result.query.where) return;

    const tree = buildConditionEffectTree(result.query.where);
    expect(tree.type).toBe('and');
    expect(tree.children?.some((c) => c.type === 'or')).toBe(true);
  });
});
