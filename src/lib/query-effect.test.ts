import { describe, expect, it } from 'vitest';
import {
  DELETE_SAMPLE_SQL,
  SAMPLE_SQL,
  UNION_SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  parseMySqlQuery,
} from './parser';
import type { QueryEffectSection } from './query-effect';
import {
  buildConditionEffectTree,
  buildQueryEffect,
  buildUnionQueryEffect,
  classifyTablePresenceRequirement,
  collectLeafTexts,
} from './query-effect';
import { applyAliasResolution } from './alias-resolver';
import type { ParsedQuery } from './types';

function scopeSectionForQuery(query: ParsedQuery): QueryEffectSection | undefined {
  const effect = buildQueryEffect(query);
  return effect.sections.find((s) => s.kind === 'scope');
}

function scopeSection(sql: string): QueryEffectSection | undefined {
  const result = parseMySqlQuery(sql);
  expect(result.success).toBe(true);
  if (!result.success) return undefined;
  return scopeSectionForQuery(result.query);
}

function scopeLines(sql: string): string[] {
  return scopeSection(sql)?.lines ?? [];
}

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
    expect(effect.summary).toContain('users（u）');
    expect(effect.summary).not.toContain(' AS ');

    const scope = effect.sections.find((s) => s.kind === 'scope');
    expect(scope?.title).toBe('検索範囲');
    expect(scope?.lines?.some((l) => l.includes('INNER JOIN'))).toBe(true);

    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('表示対象');
    expect(target?.lines?.some((l) => l.includes('users（u）.id'))).toBe(true);
    expect(effect.sections.findIndex((s) => s.kind === 'target')).toBeLessThan(
      effect.sections.findIndex((s) => s.kind === 'scope'),
    );

    const where = effect.sections.find((s) => s.kind === 'filter' && s.title?.includes('WHERE'));
    expect(where?.conditionRoot?.type).toBe('and');
    expect(collectLeafTexts(where!.conditionRoot!).some((t) => t.includes('active'))).toBe(true);

    expect(effect.sections.some((s) => s.kind === 'aggregate')).toBe(true);
  });

  it('SELECT の表示対象はエイリアス解決の有無に関わらず実テーブル名とエイリアスを併記する', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const unresolved = buildQueryEffect(result.query).sections.find((s) => s.kind === 'target');
    const resolved = buildQueryEffect(applyAliasResolution(result.query, true)).sections.find(
      (s) => s.kind === 'target',
    );

    expect(unresolved?.lines?.some((l) => l.includes('users（u）.id'))).toBe(true);
    expect(resolved?.lines?.some((l) => l.includes('users（u）.id'))).toBe(true);
    expect(resolved?.lines?.some((l) => l.match(/(?<![（）\w])users\.id/))).toBe(false);
  });

  describe('実質 INNER JOIN の scope 説明', () => {
    it('SELECT サンプルで order_items LEFT JOIN を結論ファーストで説明する', () => {
      const lines = scopeLines(SAMPLE_SQL);
      const oiLine = lines.find((l) => l.includes('oi.order_id = o.id'));
      expect(oiLine).toBeDefined();
      expect(oiLine!.startsWith('o と order_items（oi）は実質 INNER JOIN')).toBe(true);
      expect(oiLine).toContain('後続の INNER JOIN により');
      expect(oiLine).toContain('SQL上は LEFT JOIN');

      const categoriesLine = lines.find((l) => l.includes('p.category_id'));
      expect(categoriesLine).toBeDefined();
      expect(categoriesLine).not.toContain('は実質 INNER JOIN');
      expect(categoriesLine).toContain('LEFT JOIN');
      expect(categoriesLine).toContain('p の行をすべて残し c を LEFT JOIN');

      const lmLine = lines.find((l) => l.includes('lm.user_id'));
      expect(lmLine).toBeDefined();
      expect(lmLine).toContain('u、o、p');
      expect(lmLine).toContain('lm');

      const hotLine = lines.find((l) => l.includes('hot.user_id'));
      expect(hotLine).toBeDefined();
      expect(hotLine).toContain('u と hot');
      expect(hotLine).not.toContain('c と hot');
    });

    it('UPDATE サンプルでは WHERE によりと説明する', () => {
      const lines = scopeLines(UPDATE_SAMPLE_SQL);
      const oiLine = lines.find((l) => l.includes('oi.order_id = o.id'));
      expect(oiLine).toBeDefined();
      expect(oiLine).toContain('は実質 INNER JOIN');
      expect(oiLine).toContain('WHERE により');
      expect(oiLine).not.toContain('後続の INNER JOIN により');
    });

    it('WHERE のみの LEFT JOIN では WHERE によりと説明する', () => {
      const lines = scopeLines(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `);
      const line = lines.find((l) => l.includes('b.a_id = a.id'));
      expect(line).toContain('WHERE により');
      expect(line).not.toContain('後続の INNER JOIN により');
    });

    it('HAVING のみの LEFT JOIN では HAVING によりと説明する', () => {
      const lines = scopeLines(`
        SELECT a.id FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        GROUP BY a.id
        HAVING SUM(b.q) > 1
      `);
      const line = lines.find((l) => l.includes('b.a_id = a.id'));
      expect(line).toContain('HAVING により');
      expect(line).not.toContain('WHERE により');
    });

    it('WHERE と HAVING のみでは WHERE / HAVING によりと説明する', () => {
      const lines = scopeLines(`
        SELECT a.id FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
        GROUP BY a.id
        HAVING COUNT(b.id) > 0
      `);
      const line = lines.find((l) => l.includes('b.a_id = a.id'));
      expect(line).toContain('WHERE / HAVING により');
    });

    it('実質 INNER JOIN でない LEFT JOIN は従来の説明文のまま', () => {
      const lines = scopeLines(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
      `);
      const line = lines.find((l) => l.includes('b.a_id = a.id'));
      expect(line).toContain('の行をすべて残し');
      expect(line).not.toContain('は実質 INNER JOIN');
    });

    it('OR 配下のみ nullable 参照がある場合は従来の LEFT JOIN 説明のまま', () => {
      const lines = scopeLines(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1 OR b.id IS NULL
      `);
      const line = lines.find((l) => l.includes('b.a_id = a.id'));
      expect(line).toContain('の行をすべて残し');
      expect(line).not.toContain('は実質 INNER JOIN');
    });
  });

  describe('テーブル必須・任意の分類', () => {
    it('SELECT サンプルでレコード必須・任意テーブルを羅列する', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional, effectiveInnerTableIds } =
        classifyTablePresenceRequirement(result.query);
      const requiredAliases = required.map((t) => t.alias ?? t.table);
      const optionalAliases = optional.map((t) => t.alias ?? t.table);

      expect(requiredAliases).toContain('u');
      expect(requiredAliases).toContain('o');
      expect(requiredAliases).toContain('oi');
      expect(requiredAliases).toContain('p');
      expect(requiredAliases).toContain('hot');
      expect(optionalAliases).toContain('lm');
      expect(optionalAliases).toContain('c');
      expect(effectiveInnerTableIds.has(result.query.tables.find((t) => t.alias === 'oi')!.id)).toBe(
        true,
      );

      const lines = scopeLines(SAMPLE_SQL);
      expect(lines.some((l) => l.includes('INNER JOIN'))).toBe(true);
      expect(lines.some((l) => l.startsWith('レコード必須'))).toBe(false);

      const scope = scopeSection(SAMPLE_SQL);
      const requiredGroup = scope?.presenceGroups?.find((g) => g.kind === 'required');
      const optionalGroup = scope?.presenceGroups?.find((g) => g.kind === 'optional');
      expect(requiredGroup).toBeDefined();
      expect(optionalGroup).toBeDefined();
      expect(requiredGroup!.tables.some((t) => t.includes('order_items（oi）（実質 INNER JOIN）'))).toBe(
        true,
      );
      expect(optionalGroup!.tables.some((t) => t.includes('line_metrics（lm）'))).toBe(true);
      expect(optionalGroup!.tables.some((t) => t.includes('categories（c）'))).toBe(true);
    });

    it('レコード必須・任意はエイリアス解決の有無に関わらず実テーブル名とエイリアスを併記する', () => {
      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const unresolved = scopeSectionForQuery(result.query)?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );
      const resolved = scopeSectionForQuery(applyAliasResolution(result.query, true))?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );

      expect(unresolved?.tables).toContain('users（u）');
      expect(resolved?.tables).toContain('users（u）');
      expect(unresolved?.tables).not.toContain('u');
      expect(resolved?.tables).not.toContain('users');
    });

    it('派生テーブル表記が二重にならない', () => {
      const requiredGroup = scopeSection(SAMPLE_SQL)?.presenceGroups?.find(
        (g) => g.kind === 'required',
      );
      expect(requiredGroup).toBeDefined();
      const hotLine = requiredGroup!.tables.find((t) => t.includes('hot'));
      expect(hotLine).toBeDefined();
      expect(hotLine).toContain('hot (派生テーブル)');
      expect(hotLine!.match(/派生テーブル/g)?.length).toBe(1);
    });

    it('レコード必須・任意は JOIN 説明より先に配置される', () => {
      const scope = scopeSection(SAMPLE_SQL);
      expect(scope?.presenceGroups?.length).toBeGreaterThan(0);
      expect(scope?.lines?.[0]).toContain('を起点に行の組み合わせを構成');
    });

    it('実質 INNER JOIN でない LEFT JOIN は任意テーブルに含める', () => {
      const result = parseMySqlQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.alias)).toEqual(['a']);
      expect(optional.map((t) => t.alias)).toEqual(['b']);
    });

    it('WHERE により実質 INNER になったテーブルは必須に含める', () => {
      const result = parseMySqlQuery(`
        SELECT * FROM table_a a
        LEFT JOIN table_b b ON b.a_id = a.id
        WHERE b.col = 1
      `);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { required, optional } = classifyTablePresenceRequirement(result.query);
      expect(required.map((t) => t.alias).sort()).toEqual(['a', 'b']);
      expect(optional).toHaveLength(0);
    });
  });

  it('UPDATE サンプルで更新対象と SET を含む', () => {
    const result = parseMySqlQuery(UPDATE_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const effect = buildQueryEffect(result.query);
    expect(effect.action).toBe('update');
    expect(effect.summary).toContain('更新');
    expect(effect.summary).toContain('users（u） など 3 テーブル');
    expect(effect.summary).not.toContain(' AS ');
    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('更新対象');
    expect(target?.lines?.some((l) => l.includes('users（u）.status'))).toBe(true);
    expect(target?.lines?.some((l) => l.includes('order_items（oi）.shipped'))).toBe(true);
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
    expect(effect.summary).toContain('users（u） と order_items（oi）');
    expect(effect.summary).not.toContain(' AS ');
    const target = effect.sections.find((s) => s.kind === 'target');
    expect(target?.title).toBe('削除対象');
    expect(target?.lines).toContain('users（u）');
    expect(target?.lines).toContain('order_items（oi）');
    expect(effect.sections.some((s) => s.kind === 'change')).toBe(false);
  });

  it('UNION サンプルでブランチごとの効果を生成する', () => {
    const result = parseMySqlQuery(UNION_SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const unionEffect = buildUnionQueryEffect(result.query);
    expect(unionEffect?.branches).toHaveLength(3);
    expect(unionEffect?.unionNotes.some((n) => n.includes('UNION'))).toBe(true);
    expect(unionEffect?.branches[2]?.effect.summary).toContain('guest_users');
    expect(allLeafTexts(unionEffect!.branches[2]!.effect).some((t) => t.includes('関連行'))).toBe(true);
  });

  describe('SELECT 修飾子・集約', () => {
    it('DISTINCT で重複行除外と対象列を説明する', () => {
      const result = parseMySqlQuery('SELECT DISTINCT u.dept, u.name FROM users u');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('重複行除外');
      const post = effect.sections.find((s) => s.title === '後処理');
      expect(post?.lines?.some((l) => l.includes('DISTINCT') && l.includes('u.dept'))).toBe(true);
    });

    it('LIMIT OFFSET を後処理と要約に反映する', () => {
      const result = parseMySqlQuery('SELECT id FROM t ORDER BY id LIMIT 50 OFFSET 10');
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.query.offset).toBe('10');
      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('10 行スキップ後最大 50 行');
      const post = effect.sections.find((s) => s.title === '後処理');
      expect(post?.lines?.some((l) => l.includes('先頭スキップ'))).toBe(true);
    });

    it('LIMIT offset, count 形式を MySQL 順で要約する', () => {
      const result = parseMySqlQuery('SELECT id FROM t LIMIT 100, 120');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('100 行スキップ後最大 120 行');
    });

    it('GROUP BY なしの集約関数は全体集約として説明する', () => {
      const result = parseMySqlQuery('SELECT COUNT(*) AS cnt FROM users');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      expect(effect.summary).toContain('全体集約');
      const agg = effect.sections.find((s) => s.kind === 'aggregate');
      expect(agg?.lines?.some((l) => l.includes('最大1行'))).toBe(true);
    });

    it('COUNT(DISTINCT ...) を集約セクションで説明する', () => {
      const result = parseMySqlQuery('SELECT dept, COUNT(DISTINCT user_id) AS uu FROM users GROUP BY dept');
      expect(result.success).toBe(true);
      if (!result.success) return;

      const effect = buildQueryEffect(result.query);
      const agg = effect.sections.find((s) => s.kind === 'aggregate');
      expect(agg?.lines?.some((l) => l.includes('COUNT DISTINCT'))).toBe(true);
    });
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
