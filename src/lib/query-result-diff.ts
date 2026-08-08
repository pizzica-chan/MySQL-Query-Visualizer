import { applyAliasResolution } from './alias-resolver';
import type {
  ConditionNode,
  CteRef,
  JoinEdge,
  JoinType,
  ParsedQuery,
  SelectColumn,
  SetClause,
  SqlFragment,
  TableRef,
  UnionBranch,
} from './types';

export type DiffCategoryId =
  | 'statementType'
  | 'columns'
  | 'distinct'
  | 'tables'
  | 'joins'
  | 'where'
  | 'having'
  | 'groupBy'
  | 'orderBy'
  | 'limit'
  | 'union'
  | 'cte'
  | 'set'
  | 'deleteTargets';

export interface DiffCategoryResult {
  id: DiffCategoryId;
  label: string;
  status: 'same' | 'different';
  details: string[];
}

export interface QueryResultDiffOptions {
  /**
   * UI 向け。エンジンは常に equalForResultSet / equalIncludingOrder の両方を返す。
   * サマリ表示でどちらを主判定にするかは呼び出し側が切り替える。
   */
  compareOrderBy?: boolean;
}

export interface QueryResultDiff {
  /** 行の集合として同じと推定できるか（ORDER BY を除く） */
  equalForResultSet: boolean;
  /** ORDER BY を含めて同じと推定できるか */
  equalIncludingOrder: boolean;
  categories: DiffCategoryResult[];
}

const CATEGORY_LABELS: Record<DiffCategoryId, string> = {
  statementType: '文種',
  columns: '出力列',
  distinct: 'DISTINCT',
  tables: 'テーブル',
  joins: 'JOIN',
  where: 'WHERE',
  having: 'HAVING',
  groupBy: 'GROUP BY',
  orderBy: 'ORDER BY',
  limit: 'LIMIT / OFFSET',
  union: 'UNION',
  cte: 'CTE (WITH)',
  set: 'SET',
  deleteTargets: '削除対象',
};

/** 比較用に空白を潰し、大文字小文字を揃える */
export function normalizeExpr(text: string | undefined | null): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolveForDiff(query: ParsedQuery): ParsedQuery {
  const resolved = applyAliasResolution(query, true);
  return {
    ...resolved,
    ctes: resolved.ctes?.map((cte) => ({
      ...cte,
      query: resolveForDiff(cte.query),
    })),
  };
}

function tableKey(table: TableRef): string {
  if (table.isDerived) {
    const body = table.derivedQuery ? querySignature(table.derivedQuery) : '';
    return `derived:${normalizeExpr(table.alias ?? table.displayName)}:${body}`;
  }
  const name = table.schema ? `${table.schema}.${table.table}` : table.table;
  return `table:${normalizeExpr(name)}`;
}

function tableLookupKey(table: TableRef): string {
  if (table.isDerived) {
    return normalizeExpr(table.alias ?? table.displayName) || table.id;
  }
  return normalizeExpr(table.schema ? `${table.schema}.${table.table}` : table.table);
}

function buildTableIdMap(tables: TableRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tables) {
    map.set(t.id, tableLookupKey(t));
  }
  return map;
}

/** エイリアス／テーブル名 → 比較用キー（ON 条件から結合相手を復元するため） */
function buildTableNameMap(tables: TableRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tables) {
    const key = tableLookupKey(t);
    const names = [
      t.alias,
      t.table,
      t.displayName,
      t.schema ? `${t.schema}.${t.table}` : undefined,
    ];
    for (const name of names) {
      if (!name) continue;
      map.set(normalizeExpr(name), key);
    }
  }
  return map;
}

/**
 * ON 条件内の `table.column` から結合に関与するテーブルを抽出する。
 * パーサの sourceId/targetId は「直前の表」基準のため、結合順入れ替えでずれる。
 */
function endpointsFromJoinCondition(
  condition: string,
  nameMap: Map<string, string>,
): string[] {
  if (!condition) return [];
  const found = new Set<string>();
  const re = /(?<![\w.`])(`?[A-Za-z_][\w]*`?)\s*\./g;
  for (const match of condition.matchAll(re)) {
    const raw = match[1]?.replace(/`/g, '') ?? '';
    const key = nameMap.get(normalizeExpr(raw));
    if (key) found.add(key);
  }
  return [...found].sort();
}

function normalizeJoinConditionText(join: JoinEdge): string {
  const parts = join.conditionParts;
  if (parts && (parts.operator === '=' || parts.operator === '<=>')) {
    const left = normalizeExpr(parts.left);
    const right = normalizeExpr(parts.right);
    return `${[left, right].sort().join(` ${parts.operator} `)}`;
  }
  return normalizeExpr(join.condition);
}

function columnSignature(col: SelectColumn): string {
  const expr = normalizeExpr(col.expression);
  const alias = normalizeExpr(col.alias);
  return alias ? `${expr} as ${alias}` : expr;
}

function fragmentListSignature(items: SqlFragment[]): string {
  return items.map((item) => normalizeExpr(item.text)).join('\0');
}

/** GROUP BY など順序が結果集合に影響しない句用 */
function fragmentSetSignature(items: SqlFragment[]): string {
  return items
    .map((item) => normalizeExpr(item.text))
    .sort()
    .join('\0');
}

function conditionSignature(node: ConditionNode | undefined): string {
  if (!node) return '';
  const nested = node.nestedQuery ? `nested:${querySignature(node.nestedQuery)}` : '';
  const base = [
    node.type,
    normalizeExpr(node.operator),
    normalizeExpr(node.left),
    normalizeExpr(node.right),
    normalizeExpr(node.label),
    nested,
  ].join('|');

  if (!node.children?.length) return base;

  const childSigs = node.children.map(conditionSignature);
  if (node.type === 'and' || node.type === 'or') {
    childSigs.sort();
  }
  return `${base}[${childSigs.join(';')}]`;
}

/** 差分表示用に条件木を読みやすく要約する（ルート label だけの AND 等を避ける） */
function conditionSummary(node: ConditionNode | undefined): string {
  if (!node) return '(なし)';
  if (node.type === 'and' || node.type === 'or') {
    const op = node.type.toUpperCase();
    const parts = (node.children ?? []).map((child) => conditionSummary(child));
    return parts.length > 0 ? `(${parts.join(` ${op} `)})` : op;
  }
  if (node.type === 'not') {
    const inner = node.children?.[0];
    return `NOT ${conditionSummary(inner)}`;
  }
  return normalizeExpr(node.label) || node.type;
}

function conditionDiffDetails(
  a: ConditionNode | undefined,
  b: ConditionNode | undefined,
  sigA: string,
  sigB: string,
): string[] {
  if (sigA === sigB) return [];
  return [`A: ${conditionSummary(a)}`, `B: ${conditionSummary(b)}`];
}

function isCommutativeJoinType(type: JoinType | string): boolean {
  const t = normalizeExpr(type);
  return t === 'inner join' || t === 'join' || t === 'cross join';
}

function joinSignature(
  join: JoinEdge,
  idMap: Map<string, string>,
  nameMap: Map<string, string>,
): string {
  const source = idMap.get(join.sourceId) ?? join.sourceId;
  const target = idMap.get(join.targetId) ?? join.targetId;
  const natural = join.isNatural ? 'natural' : '';
  const condition = normalizeJoinConditionText(join);
  const rawType = normalizeExpr(join.type);

  // INNER / CROSS は結合順入れ替えで結果集合が変わらないため無向。
  // RIGHT JOIN A→B は LEFT JOIN B→A と等価なので LEFT に正規化する。
  // LEFT / FULL は保全側があるため向きを保持する。
  if (isCommutativeJoinType(join.type)) {
    const fromCondition = endpointsFromJoinCondition(join.condition, nameMap);
    const endpoints =
      fromCondition.length >= 2
        ? fromCondition.join('~')
        : [source, target].sort().join('~');
    return [rawType === 'join' ? 'inner join' : rawType, natural, endpoints, condition]
      .filter(Boolean)
      .join('|');
  }

  if (rawType === 'right join') {
    return ['left join', natural, `${target}->${source}`, condition].filter(Boolean).join('|');
  }

  if (rawType === 'full join') {
    // 2 表 FULL は可換
    return ['full join', natural, [source, target].sort().join('~'), condition]
      .filter(Boolean)
      .join('|');
  }

  return [rawType, natural, `${source}->${target}`, condition].filter(Boolean).join('|');
}

function setClauseSignature(set: SetClause): string {
  return [
    normalizeExpr(set.table),
    normalizeExpr(set.column),
    normalizeExpr(set.value),
    normalizeExpr(set.label),
  ].join('|');
}

function limitSignature(query: ParsedQuery): string {
  return [
    normalizeExpr(query.limit),
    normalizeExpr(query.offset),
    query.limitCommaOffset ? 'comma' : 'offset',
  ].join('|');
}

function unionBranchSignature(branch: UnionBranch): string {
  return `${normalizeExpr(branch.operator ?? 'base')}:${querySignature(branch.query)}`;
}

function cteSignature(cte: CteRef): string {
  return `${normalizeExpr(cte.name)}:${querySignature(cte.query)}`;
}

/** クエリ全体の比較用シグネチャ（ORDER BY 除外） */
function querySignature(query: ParsedQuery): string {
  const idMap = buildTableIdMap(query.tables);
  const nameMap = buildTableNameMap(query.tables);
  const parts = [
    query.statementType,
    query.distinct ? 'distinct' : '',
    query.columns.map(columnSignature).join(','),
    [...query.tables.map(tableKey)].sort().join(','),
    [...query.joins.map((j) => joinSignature(j, idMap, nameMap))].sort().join(','),
    conditionSignature(query.where),
    conditionSignature(query.having),
    fragmentSetSignature(query.groupBy),
    limitSignature(query),
    (query.setClauses ?? []).map(setClauseSignature).sort().join(','),
    (query.deleteTargets ?? [])
      .map((d) => normalizeExpr(d.name))
      .sort()
      .join(','),
    (query.unionBranches ?? []).map(unionBranchSignature).join('||'),
    (query.ctes ?? []).map(cteSignature).sort().join('||'),
  ];
  return parts.join('##');
}

function orderBySignature(query: ParsedQuery): string {
  return fragmentListSignature(query.orderBy);
}

function diffSortedLists(
  aItems: string[],
  bItems: string[],
  formatItem: (item: string) => string = (s) => s,
): string[] {
  const aSet = new Set(aItems);
  const bSet = new Set(bItems);
  const details: string[] = [];
  for (const item of aItems) {
    if (!bSet.has(item)) details.push(`A のみ: ${formatItem(item)}`);
  }
  for (const item of bItems) {
    if (!aSet.has(item)) details.push(`B のみ: ${formatItem(item)}`);
  }
  return details;
}

function diffScalar(label: string, a: string, b: string): string[] {
  if (a === b) return [];
  if (!a) return [`A に${label}なし / B: ${b || '(空)'}`];
  if (!b) return [`A: ${a || '(空)'} / B に${label}なし`];
  return [`A: ${a}`, `B: ${b}`];
}

function category(
  id: DiffCategoryId,
  details: string[],
): DiffCategoryResult {
  return {
    id,
    label: CATEGORY_LABELS[id],
    status: details.length === 0 ? 'same' : 'different',
    details,
  };
}

function compareTopLevel(a: ParsedQuery, b: ParsedQuery): DiffCategoryResult[] {
  const aIdMap = buildTableIdMap(a.tables);
  const bIdMap = buildTableIdMap(b.tables);
  const aNameMap = buildTableNameMap(a.tables);
  const bNameMap = buildTableNameMap(b.tables);

  const statementDetails =
    a.statementType === b.statementType
      ? []
      : [`A: ${a.statementType}`, `B: ${b.statementType}`];

  const aCols = a.columns.map(columnSignature);
  const bCols = b.columns.map(columnSignature);
  const columnDiff =
    aCols.join('\0') === bCols.join('\0')
      ? category('columns', [])
      : category('columns', [
          `A: ${aCols.join(', ') || '(なし)'}`,
          `B: ${bCols.join(', ') || '(なし)'}`,
        ]);

  const distinctDetails =
    a.distinct === b.distinct
      ? []
      : [`A: ${a.distinct ? 'DISTINCT' : 'なし'}`, `B: ${b.distinct ? 'DISTINCT' : 'なし'}`];

  const aTables = a.tables.map(tableKey).sort();
  const bTables = b.tables.map(tableKey).sort();
  const tableDetails = diffSortedLists(aTables, bTables, (k) => k.replace(/^table:/, '').replace(/^derived:/, '派生:'));

  const aJoins = a.joins.map((j) => joinSignature(j, aIdMap, aNameMap)).sort();
  const bJoins = b.joins.map((j) => joinSignature(j, bIdMap, bNameMap)).sort();
  const joinDetails = diffSortedLists(aJoins, bJoins, (sig) => {
    const parts = sig.split('|');
    return parts.slice(0, 4).join(' / ') || sig;
  });

  const whereA = conditionSignature(a.where);
  const whereB = conditionSignature(b.where);
  const whereDetails = conditionDiffDetails(a.where, b.where, whereA, whereB);

  const havingA = conditionSignature(a.having);
  const havingB = conditionSignature(b.having);
  const havingDetails = conditionDiffDetails(a.having, b.having, havingA, havingB);

  const groupA = [...a.groupBy.map((g) => normalizeExpr(g.text))].sort();
  const groupB = [...b.groupBy.map((g) => normalizeExpr(g.text))].sort();
  const groupDetails =
    groupA.join('\0') === groupB.join('\0')
      ? []
      : diffScalar('GROUP BY', groupA.join(', ') || '(なし)', groupB.join(', ') || '(なし)');

  const orderA = a.orderBy.map((o) => normalizeExpr(o.text));
  const orderB = b.orderBy.map((o) => normalizeExpr(o.text));
  const orderDetails =
    orderA.join('\0') === orderB.join('\0')
      ? []
      : diffScalar('ORDER BY', orderA.join(', ') || '(なし)', orderB.join(', ') || '(なし)');

  const limitDetails =
    limitSignature(a) === limitSignature(b)
      ? []
      : diffScalar(
          'LIMIT',
          [a.limit && `LIMIT ${a.limit}`, a.offset && `OFFSET ${a.offset}`].filter(Boolean).join(' ') ||
            '(なし)',
          [b.limit && `LIMIT ${b.limit}`, b.offset && `OFFSET ${b.offset}`].filter(Boolean).join(' ') ||
            '(なし)',
        );

  const aSets = (a.setClauses ?? []).map(setClauseSignature).sort();
  const bSets = (b.setClauses ?? []).map(setClauseSignature).sort();
  const setDetails =
    aSets.join('\0') === bSets.join('\0')
      ? []
      : diffSortedLists(
          (a.setClauses ?? []).map((s) => normalizeExpr(s.label) || setClauseSignature(s)),
          (b.setClauses ?? []).map((s) => normalizeExpr(s.label) || setClauseSignature(s)),
        );

  const aDel = (a.deleteTargets ?? []).map((d) => normalizeExpr(d.name)).sort();
  const bDel = (b.deleteTargets ?? []).map((d) => normalizeExpr(d.name)).sort();
  const deleteDetails = diffSortedLists(aDel, bDel);

  const aUnion = (a.unionBranches ?? []).map(unionBranchSignature);
  const bUnion = (b.unionBranches ?? []).map(unionBranchSignature);
  const unionDetails =
    aUnion.join('||') === bUnion.join('||')
      ? []
      : a.unionBranches || b.unionBranches
        ? [
            `A: ${a.unionBranches?.map((br) => br.operator ?? 'SELECT').join(' → ') || 'UNION なし'}`,
            `B: ${b.unionBranches?.map((br) => br.operator ?? 'SELECT').join(' → ') || 'UNION なし'}`,
            ...(aUnion.length === bUnion.length
              ? aUnion.flatMap((sig, i) =>
                  sig === bUnion[i] ? [] : [`ブランチ ${i + 1} の内容が異なります`],
                )
              : [`ブランチ数: A=${aUnion.length}, B=${bUnion.length}`]),
          ]
        : [];

  const aCtes = (a.ctes ?? []).map(cteSignature).sort();
  const bCtes = (b.ctes ?? []).map(cteSignature).sort();
  const cteDetails =
    aCtes.join('||') === bCtes.join('||')
      ? []
      : diffSortedLists(
          (a.ctes ?? []).map((c) => normalizeExpr(c.name)),
          (b.ctes ?? []).map((c) => normalizeExpr(c.name)),
        ).concat(
          aCtes.length === bCtes.length && aCtes.some((s, i) => s !== bCtes[i])
            ? ['同名 CTE の本体に差分があります']
            : [],
        );

  const all = [
    category('statementType', statementDetails),
    columnDiff,
    category('distinct', distinctDetails),
    category('tables', tableDetails),
    category('joins', joinDetails),
    category('where', whereDetails),
    category('having', havingDetails),
    category('groupBy', groupDetails),
    category('orderBy', orderDetails),
    category('limit', limitDetails),
    category('union', unionDetails),
    category('cte', cteDetails),
    category('set', setDetails),
    category('deleteTargets', deleteDetails),
  ];

  const hasContent: Record<DiffCategoryId, boolean> = {
    statementType: true,
    columns: true,
    distinct: true,
    tables: true,
    joins: a.joins.length > 0 || b.joins.length > 0 || joinDetails.length > 0,
    where: !!(a.where || b.where) || whereDetails.length > 0,
    having: !!(a.having || b.having) || havingDetails.length > 0,
    groupBy: a.groupBy.length > 0 || b.groupBy.length > 0 || groupDetails.length > 0,
    orderBy: a.orderBy.length > 0 || b.orderBy.length > 0 || orderDetails.length > 0,
    limit: !!(a.limit || b.limit || a.offset || b.offset) || limitDetails.length > 0,
    union: !!(a.unionBranches?.length || b.unionBranches?.length) || unionDetails.length > 0,
    cte: !!(a.ctes?.length || b.ctes?.length) || cteDetails.length > 0,
    set: !!(a.setClauses?.length || b.setClauses?.length) || setDetails.length > 0,
    deleteTargets:
      !!(a.deleteTargets?.length || b.deleteTargets?.length) || deleteDetails.length > 0,
  };

  return all.filter((c) => hasContent[c.id] || c.status === 'different');
}

/**
 * 2つの ParsedQuery を比較し、実行結果に影響しうる構文差分を返す。
 * 実データは使わず、エイリアス解決後の構造比較による推定。
 */
export function compareQueryResults(
  queryA: ParsedQuery,
  queryB: ParsedQuery,
  _options: QueryResultDiffOptions = {},
): QueryResultDiff {
  const a = resolveForDiff(queryA);
  const b = resolveForDiff(queryB);

  const categories = compareTopLevel(a, b);
  const orderCategory = categories.find((c) => c.id === 'orderBy');
  const nonOrderDiffs = categories.filter((c) => c.id !== 'orderBy' && c.status === 'different');
  const orderDiffers = orderCategory?.status === 'different';

  const equalForResultSet = nonOrderDiffs.length === 0;
  const equalIncludingOrder = equalForResultSet && !orderDiffers;

  // compareOrderBy は UI が equalForResultSet / equalIncludingOrder のどちらを
  // 主判定に使うかの切り替え用。エンジンは常に両方を返す。
  return {
    equalForResultSet,
    equalIncludingOrder,
    categories,
  };
}

/** テスト・デバッグ用: ORDER BY を除くシグネチャ */
export function resultSetSignature(query: ParsedQuery): string {
  return querySignature(resolveForDiff(query));
}

/** テスト・デバッグ用: ORDER BY シグネチャ */
export function orderSignature(query: ParsedQuery): string {
  return orderBySignature(resolveForDiff(query));
}
