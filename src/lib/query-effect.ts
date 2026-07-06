import type { ConditionNode, JoinEdge, ParsedQuery, SelectColumn, SetClause, SourceSpan, TableRef } from './types';
import { formatJoinDisplayType } from './parser';
import { getUpdateTargetTables } from './query-utils';
import {
  effectiveInnerAnalysisByJoinId,
  type EffectiveInnerReason,
} from './join-effective-inner';
import { resolveJoinLayoutSources } from './join-graph-layout';
import { hasUnion } from './query-utils';

export type EffectAction = 'select' | 'update' | 'delete';

export type EffectLineKind = 'target' | 'scope' | 'filter' | 'aggregate' | 'change' | 'info';

export type ConditionEffectType = 'and' | 'or' | 'not' | 'leaf' | 'join';

export interface ConditionEffectNode {
  id: string;
  type: ConditionEffectType;
  label?: string;
  text?: string;
  sourceSpan?: SourceSpan;
  children?: ConditionEffectNode[];
}

export interface TablePresenceJoin {
  /** 行の絞り込み「結合条件」と同じ join ノード（種別ヘッダー + ON 句） */
  root: ConditionEffectNode;
}

export interface TablePresenceEntry {
  tableLabel: string;
  tableSourceSpan?: SourceSpan;
  join?: TablePresenceJoin;
}

export interface TablePresenceGroup {
  label: string;
  kind: 'required' | 'optional';
  entries: TablePresenceEntry[];
}

export interface EffectLine {
  text: string;
  sourceSpan?: SourceSpan;
  /** 集約セクションの GROUP BY 見出し（クリック不可・ラベル表示） */
  aggregateLabel?: boolean;
  /** 集約セクションで GROUP BY 配下の列としてインデント表示 */
  aggregateIndent?: boolean;
}

export interface QueryEffectFilterPart {
  label: string;
  root: ConditionEffectNode;
}

export interface QueryEffectSection {
  kind: EffectLineKind;
  title?: string;
  lines?: EffectLine[];
  presenceGroups?: TablePresenceGroup[];
  /** 行の絞り込み: 結合条件と WHERE を分けて表示 */
  filterParts?: QueryEffectFilterPart[];
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

function formatSelectColumnSql(col: SelectColumn): string {
  return col.alias ? `${col.expression} AS ${col.alias}` : col.expression;
}

function formatOrderByClause(query: ParsedQuery): EffectLine | null {
  if (query.orderBy.length === 0) return null;
  return {
    text: `ORDER BY ${query.orderBy.map((o) => o.text).join(', ')}`,
    sourceSpan: query.orderBy[0]?.sourceSpan,
  };
}

function formatLimitClauseLine(query: ParsedQuery): EffectLine | null {
  if (!query.limit && !query.offset) return null;

  let text: string;
  if (query.limitCommaOffset && query.offset != null && query.limit != null) {
    text = `LIMIT ${query.offset}, ${query.limit}`;
  } else if (query.offset != null && query.limit != null) {
    text = `LIMIT ${query.limit} OFFSET ${query.offset}`;
  } else if (query.limit != null) {
    text = `LIMIT ${query.limit}`;
  } else {
    text = `OFFSET ${query.offset}`;
  }

  return {
    text,
    sourceSpan: query.limitSpan ?? query.offsetSpan,
  };
}

function describePostProcessLines(query: ParsedQuery): EffectLine[] {
  const lines: EffectLine[] = [];
  if (query.distinct) {
    lines.push({ text: 'DISTINCT' });
  }
  const orderBy = formatOrderByClause(query);
  if (orderBy) lines.push(orderBy);
  const limit = formatLimitClauseLine(query);
  if (limit) lines.push(limit);
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

function describeAggregateLines(query: ParsedQuery): EffectLine[] {
  if (query.statementType !== 'SELECT') return [];

  const lines: EffectLine[] = [];

  if (query.groupBy.length > 0) {
    lines.push({ text: 'GROUP BY', aggregateLabel: true });
    for (const g of query.groupBy) {
      lines.push({ text: g.text, sourceSpan: g.sourceSpan, aggregateIndent: true });
    }
  }

  const aggregateCols = query.columns.filter((c) => AGGREGATE_FUNC_PATTERN.test(c.expression));
  for (const col of aggregateCols) {
    lines.push({
      text: formatSelectColumnSql(col),
      sourceSpan: col.sourceSpan,
    });
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

function derivedTableLabelAlreadyPresent(name: string): boolean {
  return /派生テーブル/.test(name);
}

function tablePrimaryName(table: TableRef): string {
  if (table.isDerived) {
    const base = table.alias || table.table;
    return derivedTableLabelAlreadyPresent(base) ? base : `${base}（派生テーブル）`;
  }
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
}

function tableRefByName(tables: TableRef[], name: string): TableRef | undefined {
  return tables.find((t) => t.alias === name || t.table === name || t.displayName === name);
}

function formatSummaryTableList(tables: TableRef[], multiSuffix = ''): string {
  if (tables.length === 0) return 'テーブル';
  const names = tables.map((t) => tablePrimaryName(t));
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} と ${names[1]}`;
  return `${names[0]} など ${names.length} テーブル${multiSuffix}`;
}

function deleteTargetTables(query: ParsedQuery): TableRef[] {
  if (!query.deleteTargets?.length) return [];
  const tables: TableRef[] = [];
  const seen = new Set<string>();
  for (const target of query.deleteTargets) {
    const table = tableRefByName(query.tables, target.name);
    if (table && !seen.has(table.id)) {
      seen.add(table.id);
      tables.push(table);
    }
  }
  return tables;
}

function updatedTargetTables(query: ParsedQuery): TableRef[] {
  return getUpdateTargetTables(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableQualifierPrefixes(table: TableRef): string[] {
  const prefixes = new Set<string>();
  if (table.alias) prefixes.add(table.alias);
  if (!table.isDerived) {
    if (table.schema) prefixes.add(`${table.schema}.${table.table}`);
    prefixes.add(table.table);
  }
  return [...prefixes];
}

function replaceTableQualifiersInExpression(expression: string, tables: TableRef[]): string {
  let result = expression;
  const replacements = tables
    .flatMap((table) =>
      tableQualifierPrefixes(table).map((prefix) => ({
        prefix,
        label: tablePrimaryName(table),
      })),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, label } of replacements) {
    const qualified = new RegExp(`(?<![\\w.])${escapeRegExp(prefix)}\\.`, 'g');
    result = result.replace(qualified, `${label}.`);
  }
  return result;
}

function formatSelectColumnLine(col: SelectColumn, tables: TableRef[]): string {
  const expression = replaceTableQualifiersInExpression(col.expression, tables);
  if (col.expression === '*') return '*（すべての列）';
  return col.alias ? `${expression} AS ${col.alias}` : expression;
}

function formatSetClauseLine(set: SetClause, tables: TableRef[]): string {
  if (set.table) {
    const table = tableRefByName(tables, set.table);
    const tableName = table ? tablePrimaryName(table) : set.table;
    return `${tableName}.${set.column} = ${set.value}`;
  }
  return set.label;
}

function describeOperationTarget(query: ParsedQuery): QueryEffectSection | null {
  if (query.statementType === 'SELECT') {
    if (query.columns.length === 0) return null;
    return {
      kind: 'target',
      title: '表示対象',
      lines: query.columns.map((col) => ({
        text: formatSelectColumnLine(col, query.tables),
        sourceSpan: col.sourceSpan,
      })),
    };
  }

  if (query.statementType === 'UPDATE') {
    if (!query.setClauses?.length) return null;
    return {
      kind: 'target',
      title: '更新対象',
      lines: query.setClauses.map((set) => ({ text: formatSetClauseLine(set, query.tables) })),
    };
  }

  if (query.statementType === 'DELETE') {
    const targets = deleteTargetTables(query);
    const tables = targets.length > 0 ? targets : query.tables.filter((t) => !t.isDerived);
    if (tables.length === 0) return null;
    return {
      kind: 'target',
      title: '削除対象',
      lines: tables.map((t) => ({ text: tablePrimaryName(t), sourceSpan: t.sourceSpan })),
    };
  }

  return null;
}

function tableLabel(table: TableRef): string {
  if (table.displayName.includes('（CTE）')) return table.displayName;
  if (table.isDerived) {
    return derivedTableLabelAlreadyPresent(table.displayName)
      ? table.displayName
      : `${table.displayName}（派生テーブル）`;
  }
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

function isInnerJoinType(type: JoinEdge['type']): boolean {
  return type === 'INNER JOIN' || type === 'JOIN';
}

export interface TablePresenceClassification {
  required: TableRef[];
  optional: TableRef[];
  /** 外部結合だが実質 INNER となり必須側に含まれるテーブル id */
  effectiveInnerTableIds: Set<string>;
}

/** JOIN 種別と実質 INNER から、結果行にレコードが必須か任意かを分類 */
export function classifyTablePresenceRequirement(query: ParsedQuery): TablePresenceClassification {
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);
  const requiredIds = new Set<string>();
  const optionalIds = new Set<string>();
  const effectiveInnerTableIds = new Set<string>();

  if (query.tables.length === 0) {
    return { required: [], optional: [], effectiveInnerTableIds };
  }

  requiredIds.add(query.tables[0]!.id);

  for (const join of query.joins) {
    const analysis = effectiveInnerByJoin.get(join.id);
    const effectiveInner = Boolean(analysis && analysis.reasons.length > 0);
    const sourceIds = resolveJoinLayoutSources(join, query.tables);

    if (isInnerJoinType(join.type)) {
      requiredIds.add(join.targetId);
      for (const id of sourceIds) requiredIds.add(id);
      optionalIds.delete(join.targetId);
    } else if (join.type === 'LEFT JOIN') {
      if (effectiveInner) {
        requiredIds.add(join.targetId);
        optionalIds.delete(join.targetId);
        effectiveInnerTableIds.add(join.targetId);
      } else {
        optionalIds.add(join.targetId);
      }
    } else if (join.type === 'RIGHT JOIN') {
      requiredIds.add(join.targetId);
      if (effectiveInner) {
        requiredIds.add(join.sourceId);
        optionalIds.delete(join.sourceId);
        effectiveInnerTableIds.add(join.sourceId);
      } else {
        optionalIds.add(join.sourceId);
      }
    } else if (join.type === 'FULL JOIN') {
      optionalIds.add(join.targetId);
      for (const id of sourceIds) optionalIds.add(id);
    } else if (join.type === 'CROSS JOIN') {
      requiredIds.add(join.targetId);
    }
  }

  for (const id of requiredIds) optionalIds.delete(id);

  return {
    required: query.tables.filter((t) => requiredIds.has(t.id)),
    optional: query.tables.filter((t) => optionalIds.has(t.id)),
    effectiveInnerTableIds,
  };
}

function tablePresenceLabel(table: TableRef): string {
  if (table.isDerived) return tableLabel(table);
  return tablePrimaryName(table);
}

function formatTableNameForPresence(
  table: TableRef,
  classification: TablePresenceClassification,
  markEffectiveInner: boolean,
): string {
  const name = tablePresenceLabel(table);
  if (markEffectiveInner && classification.effectiveInnerTableIds.has(table.id)) {
    return `${name}（実質 INNER JOIN）`;
  }
  return name;
}

function buildTablePresenceGroups(
  classification: TablePresenceClassification,
): TablePresenceGroup[] {
  return [
    {
      label: PRESENCE_REQUIRED_LABEL,
      kind: 'required',
      entries: classification.required.map((t) => ({
        tableLabel: formatTableNameForPresence(t, classification, true),
        tableSourceSpan: t.sourceSpan,
      })),
    },
    {
      label: PRESENCE_OPTIONAL_LABEL,
      kind: 'optional',
      entries: classification.optional.map((t) => ({
        tableLabel: formatTableNameForPresence(t, classification, false),
        tableSourceSpan: t.sourceSpan,
      })),
    },
  ];
}

function crossJoinPhrase(join: JoinEdge, tables: TableRef[]): string {
  const sourceLabels = joinSourceLabels(join, tables);
  const right = tableName(join, tables, join.targetId);
  const left = sourceLabels.length === 1 ? sourceLabels[0]! : sourceLabels.join('、');
  return `CROSS JOIN — ${left} と ${right} のすべての組み合わせ`;
}

function conditionPhrase(node: ConditionNode): string {
  return node.label;
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
    sourceSpan: node.sourceSpan,
  };
}

export function collectLeafTexts(node: ConditionEffectNode): string[] {
  if (node.type === 'join') {
    const header = node.label ? [node.label] : [];
    return [...header, ...(node.children ?? []).flatMap(collectLeafTexts)];
  }
  if (node.type === 'leaf') return node.text ? [node.text] : [];
  return (node.children ?? []).flatMap(collectLeafTexts);
}

/** 結合条件ブロック（JOIN 種別 + ON 句）を抽出 */
export function collectJoinFilterNodes(root: ConditionEffectNode): ConditionEffectNode[] {
  if (root.type === 'join') return [root];
  if (root.type === 'and' || root.type === 'or' || root.type === 'not') {
    return (root.children ?? []).flatMap(collectJoinFilterNodes);
  }
  return [];
}

function effectiveInnerForJoin(
  join: JoinEdge,
  query: ParsedQuery,
  effectiveInnerByJoin: Map<string, { reasons: EffectiveInnerReason[] }>,
): { nullableTable: TableRef; reasons: EffectiveInnerReason[] } | undefined {
  const analysis = effectiveInnerByJoin.get(join.id);
  if (!analysis || analysis.reasons.length === 0) return undefined;

  const nullableId = join.type === 'LEFT JOIN' ? join.targetId : join.sourceId;
  const nullableTable = query.tables.find((t) => t.id === nullableId);
  if (!nullableTable) return undefined;

  return { nullableTable, reasons: analysis.reasons };
}

const SCOPE_SECTION_TITLE_JOIN = '結合するテーブル';
const SCOPE_SECTION_TITLE_SINGLE = '対象テーブル';

function scopeSectionTitle(query: ParsedQuery): string {
  return query.joins.length > 0 ? SCOPE_SECTION_TITLE_JOIN : SCOPE_SECTION_TITLE_SINGLE;
}
const PRESENCE_REQUIRED_LABEL = '必須';
const PRESENCE_OPTIONAL_LABEL = '任意（外部結合）';
const ROW_FILTER_TITLE = '行の絞り込み';

function effectiveInnerCauseLabel(reasons: EffectiveInnerReason[]): string {
  if (reasons.some((r) => r.kind === 'inner_join')) {
    return '後続の結合で必須';
  }
  const parts: string[] = [];
  if (reasons.some((r) => r.kind === 'where')) parts.push('WHERE');
  if (reasons.some((r) => r.kind === 'having')) parts.push('HAVING');
  if (parts.length === 0) return '後続条件で必須';
  return `${parts.join(' / ')} で必須`;
}

function effectiveInnerFilterTag(join: JoinEdge, reasons: EffectiveInnerReason[]): string {
  return `${join.type}（実質 INNER JOIN — ${effectiveInnerCauseLabel(reasons)}）`;
}

function joinFilterHeader(
  join: JoinEdge,
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): string {
  if (effectiveInner) {
    return effectiveInnerFilterTag(join, effectiveInner.reasons);
  }
  const typeLabel = formatJoinDisplayType(join);
  if (!join.isNatural && isInnerJoinType(join.type)) {
    return 'INNER JOIN';
  }
  return typeLabel;
}

function buildJoinConditionEffectNode(join: JoinEdge): ConditionEffectNode {
  if (join.conditionRoot) {
    return buildConditionEffectTree(join.conditionRoot);
  }
  return {
    id: `join-cond-${join.id}`,
    type: 'leaf',
    text: join.condition,
    sourceSpan: join.sourceSpan,
  };
}

function findOptionalJoinForTable(
  table: TableRef,
  optionalJoins: JoinEdge[],
  query: ParsedQuery,
): JoinEdge | undefined {
  return optionalJoins.find((join) => {
    if (join.type === 'LEFT JOIN') return join.targetId === table.id;
    if (join.type === 'RIGHT JOIN') return join.sourceId === table.id;
    if (join.type === 'FULL JOIN') {
      return (
        join.targetId === table.id ||
        resolveJoinLayoutSources(join, query.tables).includes(table.id)
      );
    }
    return false;
  });
}

function attachOptionalJoinsToPresenceGroups(
  groups: TablePresenceGroup[],
  query: ParsedQuery,
  classification: TablePresenceClassification,
  optionalJoins: JoinEdge[],
): TablePresenceGroup[] {
  return groups.map((group) => {
    if (group.kind !== 'optional') return group;
    return {
      ...group,
      entries: group.entries.map((entry) => {
        const table = classification.optional.find(
          (t) => formatTableNameForPresence(t, classification, false) === entry.tableLabel,
        );
        if (!table) return entry;
        const join = findOptionalJoinForTable(table, optionalJoins, query);
        if (!join) return entry;
        return {
          ...entry,
          join: {
            root: buildJoinFilterNode(join),
          },
        };
      }),
    };
  });
}

function buildJoinFilterNode(
  join: JoinEdge,
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): ConditionEffectNode {
  return {
    id: `join-filter-${join.id}`,
    type: 'join',
    label: joinFilterHeader(join, effectiveInner),
    sourceSpan: join.sourceSpan,
    children: [buildJoinConditionEffectNode(join)],
  };
}

/** INNER / 実質 INNER JOIN の ON だけが行の絞り込みに相当する */
function isJoinRowFilter(
  join: JoinEdge,
  effectiveInner?: { nullableTable: TableRef; reasons: EffectiveInnerReason[] },
): boolean {
  if (isInnerJoinType(join.type)) return true;
  return Boolean(effectiveInner);
}

function buildJoinFilterLeaves(
  query: ParsedQuery,
  effectiveInnerByJoin: Map<string, { reasons: EffectiveInnerReason[] }>,
): ConditionEffectNode[] {
  return query.joins.flatMap((join) => {
    const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
    if (!isJoinRowFilter(join, effectiveInner)) return [];
    return [
      buildJoinFilterNode(join, effectiveInner),
    ];
  });
}

function joinFilterPart(joinLeaves: ConditionEffectNode[]): QueryEffectFilterPart | null {
  if (joinLeaves.length === 0) return null;
  if (joinLeaves.length === 1) {
    return { label: '結合条件', root: joinLeaves[0]! };
  }
  return {
    label: '結合条件',
    root: {
      id: 'join-filter-root',
      type: 'and',
      label: 'すべて満たす（AND）',
      children: joinLeaves,
    },
  };
}

function describeRowFilterSection(query: ParsedQuery): QueryEffectSection | null {
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);
  const joinLeaves = buildJoinFilterLeaves(query, effectiveInnerByJoin);
  const filterParts: QueryEffectFilterPart[] = [];

  const joinPart = joinFilterPart(joinLeaves);
  if (joinPart) filterParts.push(joinPart);

  if (query.where) {
    filterParts.push({
      label: 'WHERE',
      root: buildConditionEffectTree(query.where),
    });
  }

  if (filterParts.length === 0) return null;

  return {
    kind: 'filter',
    title: ROW_FILTER_TITLE,
    filterParts,
  };
}

function describeScope(query: ParsedQuery): QueryEffectSection | null {
  const lines: EffectLine[] = [];
  let presenceGroups: TablePresenceGroup[] | undefined;
  const effectiveInnerByJoin = effectiveInnerAnalysisByJoinId(query);

  if (query.tables.length === 0) {
    lines.push({ text: '対象テーブルが指定されていません' });
  } else {
    if (query.ctes?.length) {
      for (const cte of query.ctes) {
        lines.push({
          text: `${cte.name}（CTE）— WITH で定義された一時結果セット`,
          sourceSpan: cte.sourceSpan,
        });
      }
    }
    if (query.joins.length === 0) {
      lines.push({ text: `${tableLabel(query.tables[0]!)} の行` });
    } else {
      const classification = classifyTablePresenceRequirement(query);
      const optionalJoins = query.joins.filter((join) => {
        if (join.type === 'CROSS JOIN') return false;
        const effectiveInner = effectiveInnerForJoin(join, query, effectiveInnerByJoin);
        return !isJoinRowFilter(join, effectiveInner);
      });
      presenceGroups = attachOptionalJoinsToPresenceGroups(
        buildTablePresenceGroups(classification),
        query,
        classification,
        optionalJoins,
      );
      for (const join of query.joins) {
        if (join.type === 'CROSS JOIN') {
          lines.push({ text: crossJoinPhrase(join, query.tables) });
        }
      }
    }
  }

  if (lines.length === 0 && !presenceGroups) return null;

  return { kind: 'scope', title: scopeSectionTitle(query), lines, presenceGroups };
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

  const aggregateLines = describeAggregateLines(query);
  if (aggregateLines.length === 0 && query.groupBy.length === 0) return [];

  const sections: QueryEffectSection[] = [
    {
      kind: 'aggregate',
      title: '集約',
      lines: aggregateLines,
    },
  ];

  const having = describeFilterSection(query.having, 'HAVING');
  if (having) sections.push(having);

  return sections;
}

function describeChanges(query: ParsedQuery): QueryEffectSection | null {
  if (query.statementType === 'UPDATE' && query.setClauses?.length) {
    return {
      kind: 'change',
      title: '更新内容',
      lines: query.setClauses.map((s) => ({ text: s.label })),
    };
  }
  return null;
}

function describePostProcess(query: ParsedQuery): QueryEffectSection | null {
  const lines = describePostProcessLines(query);
  return lines.length > 0 ? { kind: 'info', title: '後処理', lines } : null;
}

function primaryTarget(query: ParsedQuery): string {
  if (query.statementType === 'DELETE' && query.deleteTargets?.length) {
    return formatSummaryTableList(deleteTargetTables(query));
  }
  if (query.statementType === 'UPDATE') {
    return formatSummaryTableList(updatedTargetTables(query));
  }
  if (query.joins.length > 0) {
    return formatSummaryTableList(query.tables, 'の組み合わせ');
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

  const target = describeOperationTarget(query);
  if (target) sections.push(target);

  const scope = describeScope(query);
  if (scope) sections.push(scope);

  const where = describeRowFilterSection(query);
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
