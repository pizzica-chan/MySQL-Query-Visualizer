import type { ConditionNode, JoinEdge, ParsedQuery, SelectColumn, TableRef } from './types';
import {
  effectiveInnerAnalysisByJoinId,
  formatEffectiveInnerJoinScopeLine,
  type EffectiveInnerReason,
} from './join-effective-inner';
import { resolveJoinLayoutSources } from './join-graph-layout';
import { hasUnion } from './query-utils';

export type EffectAction = 'select' | 'update' | 'delete';

export type EffectLineKind = 'scope' | 'filter' | 'aggregate' | 'change' | 'info';

export type ConditionEffectType = 'and' | 'or' | 'not' | 'leaf';

export interface ConditionEffectNode {
  id: string;
  type: ConditionEffectType;
  label?: string;
  text?: string;
  children?: ConditionEffectNode[];
}

export interface QueryEffectSection {
  kind: EffectLineKind;
  title?: string;
  lines?: string[];
  conditionRoot?: ConditionEffectNode;
}

export interface QueryEffect {
  action: EffectAction;
  actionLabel: string;
  headline: string;
  summary: string;
  sections: QueryEffectSection[];
}

const AGGREGATE_FUNC_PATTERN =
  /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|BIT_AND|BIT_OR|STD|STDDEV|VARIANCE)\s*\(/i;
const COUNT_DISTINCT_PATTERN = /\bCOUNT\s*\(\s*DISTINCT\b/i;

function columnLabel(col: SelectColumn): string {
  return col.alias ?? col.expression;
}

function hasStarProjection(columns: SelectColumn[]): boolean {
  return columns.some((c) => c.expression === '*' || /\.\*$/.test(c.expression));
}

function describeDistinctLine(query: ParsedQuery): string {
  if (!query.distinct) return '';

  if (query.groupBy.length > 0) {
    return 'DISTINCT — 集約後、SELECT 列の組み合わせが同じ行を1行にまとめる';
  }

  if (hasStarProjection(query.columns)) {
    return 'DISTINCT — 行全体（すべての列）が同じものを1行にまとめる';
  }

  const cols = query.columns.map(columnLabel).join(', ');
  return `DISTINCT — ${cols} の組み合わせが同じ行を1行にまとめる`;
}

function describeLimitOffsetLines(query: ParsedQuery): string[] {
  const lines: string[] = [];
  if (query.offset) {
    lines.push(`先頭スキップ — ${query.offset} 行を飛ばしてから取得`);
  }
  if (query.limit) {
    lines.push(
      query.offset
        ? `件数上限 — スキップ後最大 ${query.limit} 行`
        : `件数上限 — 最大 ${query.limit} 行`,
    );
  }
  return lines;
}

function formatLimitSummary(query: ParsedQuery): string {
  if (query.limit && query.offset) {
    return ` — ${query.offset} 行スキップ後最大 ${query.limit} 行`;
  }
  if (query.limit) return ` — 最大 ${query.limit} 行`;
  if (query.offset) return ` — ${query.offset} 行スキップ後`;
  return '';
}

function describeAggregateColumns(query: ParsedQuery): string[] {
  if (query.statementType !== 'SELECT') return [];

  const aggregateCols = query.columns.filter((c) => AGGREGATE_FUNC_PATTERN.test(c.expression));
  const countDistinctCols = query.columns.filter((c) => COUNT_DISTINCT_PATTERN.test(c.expression));
  const lines: string[] = [];

  if (query.groupBy.length > 0) {
    lines.push(`${query.groupBy.map((g) => g.text).join(', ')} ごとに集約 — 1グループ = 結果の1行`);
  } else if (aggregateCols.length > 0) {
    lines.push('集約関数のみ — 全体を1グループとして計算（結果は最大1行）');
  }

  for (const col of countDistinctCols) {
    lines.push(`${columnLabel(col)} — 重複値を除いて数える（COUNT DISTINCT）`);
  }

  return lines;
}

function describeUnionCombination(query: ParsedQuery): string[] {
  if (!query.unionBranches || query.unionBranches.length < 2) return [];

  const operators = query.unionBranches
    .slice(1)
    .map((b) => b.operator ?? 'UNION')
    .filter((op, i, arr) => arr.indexOf(op) === i);

  if (operators.length === 1 && operators[0] === 'UNION ALL') {
    return ['UNION ALL — 各 SELECT の結果をそのまま縦に連結（重複も残る）'];
  }
  if (operators.length === 1 && operators[0] === 'UNION') {
    return ['UNION — 各 SELECT の結果を縦に連結し、完全に同じ行は1行にまとめる'];
  }

  return [
    'UNION / UNION ALL — 各 SELECT の結果を縦に連結（UNION は重複行を除外、UNION ALL は残す）',
  ];
}

const ACTION_LABELS: Record<ParsedQuery['statementType'], { action: EffectAction; label: string; verb: string }> = {
  SELECT: { action: 'select', label: '表示', verb: '表示される' },
  UPDATE: { action: 'update', label: '更新', verb: '更新される' },
  DELETE: { action: 'delete', label: '削除', verb: '削除される' },
};

const JOIN_SCOPE: Record<string, (left: string, right: string, condition: string) => string> = {
  'INNER JOIN': (l, r, c) =>
    `${l} と ${r} を INNER JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  JOIN: (l, r, c) =>
    `${l} と ${r} を JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  'LEFT JOIN': (l, r, c) =>
    `${l} の行をすべて残し ${r} を LEFT JOIN — 結合条件「${c}」（${r} が無い行も ${l} は残る）`,
  'RIGHT JOIN': (l, r, c) =>
    `${r} の行をすべて残し ${l} を RIGHT JOIN — 結合条件「${c}」`,
  'FULL JOIN': (l, r, c) => `${l} と ${r} を FULL JOIN — 結合条件「${c}」`,
  'CROSS JOIN': (l, r) => `${l} と ${r} の直積（すべての組み合わせ）`,
};

const MULTI_SOURCE_JOIN_SCOPE: Record<string, (sources: string, target: string, condition: string) => string> = {
  'INNER JOIN': (s, r, c) =>
    `${s} と ${r} を INNER JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  JOIN: (s, r, c) =>
    `${s} と ${r} を JOIN — 結合条件「${c}」を満たす組み合わせのみ残る`,
  'LEFT JOIN': (s, r, c) =>
    `${s} を基準に ${r} を LEFT JOIN — 結合条件「${c}」（${r} が無い組み合わせも LEFT 側は残る）`,
  'RIGHT JOIN': (s, r, c) =>
    `${r} を基準に ${s} を RIGHT JOIN — 結合条件「${c}」`,
  'FULL JOIN': (s, r, c) => `${s} と ${r} を FULL JOIN — 結合条件「${c}」`,
  'CROSS JOIN': (s, r) => `${s} と ${r} の直積（すべての組み合わせ）`,
};

function tablePrimaryName(table: TableRef): string {
  if (table.isDerived) return `${table.table}（派生テーブル）`;
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
}

function tableLabel(table: TableRef): string {
  if (table.isDerived) return `${table.displayName}（派生テーブル）`;
  return table.displayName;
}

function mergeSameTypeGroups(
  nodes: ConditionEffectNode[],
  type: 'and' | 'or',
): ConditionEffectNode[] {
  return nodes.flatMap((node) => {
    if (node.type === type && node.children) {
      return node.children;
    }
    return [node];
  });
}

function tableName(_join: JoinEdge, tables: TableRef[], id: string): string {
  const t = tables.find((x) => x.id === id);
  return t ? tableLabel(t) : id;
}

function joinSourceLabels(join: JoinEdge, tables: TableRef[]): string[] {
  return resolveJoinLayoutSources(join, tables).map((id) => tableName(join, tables, id));
}

function describeJoin(
  join: JoinEdge,
  tables: TableRef[],
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): string {
  const sourceLabels = joinSourceLabels(join, tables);
  const sourcesText = sourceLabels.join('、');
  const right = tableName(join, tables, join.targetId);
  const left = sourceLabels.length === 1 ? sourceLabels[0]! : sourcesText;

  if (effectiveInner) {
    const preservedLabel = join.type === 'LEFT JOIN' ? left : right;
    return formatEffectiveInnerJoinScopeLine(
      join,
      preservedLabel,
      effectiveInner.nullableTable,
      effectiveInner.reasons,
    );
  }

  if (sourceLabels.length > 1) {
    const fn = MULTI_SOURCE_JOIN_SCOPE[join.type] ?? MULTI_SOURCE_JOIN_SCOPE.JOIN;
    return fn(sourcesText, right, join.condition);
  }

  const fn = JOIN_SCOPE[join.type] ?? JOIN_SCOPE.JOIN;
  return fn(left, right, join.condition);
}

function conditionPhrase(node: ConditionNode): string {
  switch (node.type) {
    case 'exists':
      return `関連行が存在するものだけ — ${node.label}`;
    case 'in':
      return node.nestedQuery ? `リスト / サブクエリの結果に含まれる — ${node.label}` : node.label;
    case 'like':
      return `パターン一致 — ${node.label}`;
    case 'between':
      return `範囲内 — ${node.label}`;
    case 'is_null':
      return node.label;
    case 'subquery':
      return node.label;
    default:
      return node.label;
  }
}

/** WHERE / HAVING を AND / OR / NOT の入れ子ツリーに変換 */
export function buildConditionEffectTree(node: ConditionNode): ConditionEffectNode {
  if (node.type === 'and' && node.children?.length) {
    if (node.children.length === 1) {
      return buildConditionEffectTree(node.children[0]!);
    }
    return {
      id: node.id,
      type: 'and',
      label: 'すべて満たす（AND）',
      children: mergeSameTypeGroups(node.children.map(buildConditionEffectTree), 'and'),
    };
  }
  if (node.type === 'or' && node.children?.length) {
    if (node.children.length === 1) {
      return buildConditionEffectTree(node.children[0]!);
    }
    return {
      id: node.id,
      type: 'or',
      label: 'いずれかを満たす（OR）',
      children: mergeSameTypeGroups(node.children.map(buildConditionEffectTree), 'or'),
    };
  }
  if (node.type === 'not') {
    const inner = node.children?.[0];
    return {
      id: node.id,
      type: 'not',
      label: '除外（NOT）',
      children: inner ? [buildConditionEffectTree(inner)] : [],
    };
  }
  return {
    id: node.id,
    type: 'leaf',
    text: conditionPhrase(node),
  };
}

export function collectLeafTexts(node: ConditionEffectNode): string[] {
  if (node.type === 'leaf') return node.text ? [node.text] : [];
  return (node.children ?? []).flatMap(collectLeafTexts);
}

function describeScope(query: ParsedQuery): QueryEffectSection | null {
  const lines: string[] = [];
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);

  if (query.tables.length === 0) {
    lines.push('対象テーブルが指定されていません');
  } else if (query.joins.length === 0) {
    lines.push(`${tableLabel(query.tables[0]!)} の行`);
  } else {
    lines.push(`${tableLabel(query.tables[0]!)} を起点に行の組み合わせを構成`);
    for (const join of query.joins) {
      const analysis = effectiveInnerByJoin.get(join.id);
      let effectiveInner: { nullableTable: TableRef; reasons: EffectiveInnerReason[] } | undefined;
      if (analysis && analysis.reasons.length > 0) {
        const nullableId = join.type === 'LEFT JOIN' ? join.targetId : join.sourceId;
        const nullableTable = query.tables.find((t) => t.id === nullableId);
        if (nullableTable) {
          effectiveInner = { nullableTable, reasons: analysis.reasons };
        }
      }
      lines.push(describeJoin(join, query.tables, effectiveInner));
    }
  }

  return lines.length > 0 ? { kind: 'scope', title: '対象の範囲', lines } : null;
}

function describeFilterSection(
  node: ConditionNode | undefined,
  title: string,
): QueryEffectSection | null {
  if (!node) return null;
  return {
    kind: 'filter',
    title,
    conditionRoot: buildConditionEffectTree(node),
  };
}

function describeAggregation(query: ParsedQuery): QueryEffectSection[] {
  if (query.statementType !== 'SELECT') return [];

  const aggregateLines = describeAggregateColumns(query);
  if (aggregateLines.length === 0 && query.groupBy.length === 0) return [];

  const sections: QueryEffectSection[] = [
    {
      kind: 'aggregate',
      title: '集約',
      lines: aggregateLines,
    },
  ];

  const having = describeFilterSection(
    query.having,
    '集約後の HAVING 条件（グループ単位でさらに絞り込み）',
  );
  if (having) sections.push(having);

  return sections;
}

function describeChanges(query: ParsedQuery): QueryEffectSection | null {
  if (query.statementType === 'UPDATE' && query.setClauses?.length) {
    return {
      kind: 'change',
      title: '更新内容',
      lines: query.setClauses.map((s) => s.label),
    };
  }
  if (query.statementType === 'DELETE' && query.deleteTargets?.length) {
    return {
      kind: 'change',
      title: '削除対象',
      lines: [`${query.deleteTargets.map((t) => t.label).join('、')} の行`],
    };
  }
  return null;
}

function describePostProcess(query: ParsedQuery): QueryEffectSection | null {
  const lines: string[] = [];
  const distinctLine = describeDistinctLine(query);
  if (distinctLine) lines.push(distinctLine);
  if (query.orderBy.length > 0) {
    lines.push(`並び順 — ${query.orderBy.map((o) => o.text).join(', ')}`);
  }
  lines.push(...describeLimitOffsetLines(query));
  return lines.length > 0 ? { kind: 'info', title: '後処理', lines } : null;
}

function primaryTarget(query: ParsedQuery): string {
  if (query.statementType === 'DELETE' && query.deleteTargets?.length) {
    return query.deleteTargets.map((t) => t.label).join(' と ');
  }
  if (query.statementType === 'UPDATE') {
    const main = query.tables[0];
    return main ? tablePrimaryName(main) : 'テーブル';
  }
  if (query.joins.length > 0) {
    const names = query.tables.filter((t) => !t.isDerived).map((t) => tablePrimaryName(t));
    if (names.length <= 2) return names.join(' と ');
    return `${names[0]} など ${names.length} テーブルの組み合わせ`;
  }
  const main = query.tables[0];
  return main ? tablePrimaryName(main) : 'テーブル';
}

function buildSummary(query: ParsedQuery, meta: (typeof ACTION_LABELS)[ParsedQuery['statementType']]): string {
  const target = primaryTarget(query);
  const filtered = query.where ? '、WHERE 条件を満たす' : '';
  const distinct = query.statementType === 'SELECT' && query.distinct ? '（重複行除外）' : '';
  const grouped =
    query.statementType === 'SELECT' && query.groupBy.length > 0
      ? '（グループ集約後）'
      : query.statementType === 'SELECT' &&
          query.groupBy.length === 0 &&
          query.columns.some((c) => AGGREGATE_FUNC_PATTERN.test(c.expression))
        ? '（全体集約）'
        : '';
  const limit = formatLimitSummary(query);

  if (query.statementType === 'SELECT') {
    return `${target}${filtered}行${grouped}${distinct}が結果として${meta.verb}${limit}`;
  }
  if (query.statementType === 'UPDATE') {
    return `${target}${filtered}行が${meta.verb}${limit}`;
  }
  return `${target}${filtered}行が${meta.verb}${limit}`;
}

export function buildQueryEffect(query: ParsedQuery): QueryEffect {
  const meta = ACTION_LABELS[query.statementType];
  const sections: QueryEffectSection[] = [];

  const scope = describeScope(query);
  if (scope) sections.push(scope);

  const where = describeFilterSection(query.where, '行の絞り込み（WHERE）');
  if (where) sections.push(where);

  sections.push(...describeAggregation(query));

  const changes = describeChanges(query);
  if (changes) sections.push(changes);

  const post = describePostProcess(query);
  if (post) sections.push(post);

  return {
    action: meta.action,
    actionLabel: meta.label,
    headline: `${meta.label}対象`,
    summary: buildSummary(query, meta),
    sections,
  };
}

export interface UnionQueryEffect {
  branches: Array<{ operator?: string; effect: QueryEffect }>;
  unionNotes: string[];
}

export function buildUnionQueryEffect(query: ParsedQuery): UnionQueryEffect | null {
  if (!hasUnion(query) || !query.unionBranches) return null;
  return {
    unionNotes: describeUnionCombination(query),
    branches: query.unionBranches.map((branch) => ({
      operator: branch.operator,
      effect: buildQueryEffect(branch.query),
    })),
  };
}
