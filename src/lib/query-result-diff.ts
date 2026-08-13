import { applyAliasResolution } from './alias-resolver';
import { normalizeEffectiveInnerJoins } from './join-effective-inner';
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

export interface QueryResultDiff {
  /**
   * 行の集合として同じと推定できるか。
   * ORDER BY のみの差分は通常ここに含めないが、LIMIT/OFFSET がある場合は含める。
   * 構文カテゴリに差分がなければ true（意味等価の証明ではない）。
   */
  equalForResultSet: boolean;
  /** ORDER BY を含めて同じと推定できるか */
  equalIncludingOrder: boolean;
  categories: DiffCategoryResult[];
  /** 構文差分はあるが、よくある安全リファクタの可能性を示す補助ヒント（結果推定は変えない） */
  reviewHints: ReviewHint[];
  /** 実質 INNER JOIN 正規化により結果セット同等とみなした */
  matchedViaEffectiveInner: boolean;
  /** LIMIT / OFFSET ありかつ ORDER BY なし（いずれかまたは両方のクエリ） */
  limitWithoutOrderActive: boolean;
}

export interface ReviewHint {
  id: 'exists-vs-distinct-join' | 'where-to-on' | 'limit-without-order';
  title: string;
  message: string;
}

export interface ResultDiffSummary {
  /** サマリー枠の色 */
  tone: 'same' | 'order-only' | 'review-needed' | 'different';
  /** サマリー見出し */
  title: string;
  resultSet: { status: 'same' | 'different' | 'uncertain'; label: string };
  order: { status: 'same' | 'different' | 'not-specified'; label: string };
  /** LIMIT+ORDER BY など、サマリーだけでは分かりにくいときの補足 */
  note?: string;
  /** 実質 INNER JOIN により同等とみなしたときの軽い補足 */
  effectiveInnerNote?: string;
  /** LIMIT あり・ORDER BY なしのときの注意（目立つ警告） */
  limitWithoutOrderWarning?: string;
  /** サマリー本文 */
  body: string;
  /** 要確認ヒント（黄トーン時など） */
  hints: ReviewHint[];
}

export interface PartitionedDiffCategories {
  resultSetDifferent: DiffCategoryResult[];
  orderDifferent: DiffCategoryResult[];
  resultSetSame: DiffCategoryResult[];
  orderSame: DiffCategoryResult[];
}

/** ORDER BY カテゴリを結果セット差分と並び順差分に分ける */
export function partitionDiffCategories(categories: DiffCategoryResult[]): PartitionedDiffCategories {
  const different = categories.filter((c) => c.status === 'different');
  const same = categories.filter((c) => c.status === 'same');
  return {
    resultSetDifferent: different.filter((c) => c.id !== 'orderBy'),
    orderDifferent: different.filter((c) => c.id === 'orderBy'),
    resultSetSame: same.filter((c) => c.id !== 'orderBy'),
    orderSame: same.filter((c) => c.id === 'orderBy'),
  };
}

/** LIMIT / OFFSET があると ORDER BY の違いは返る行の集合にも影響し得る */
export function orderAffectsResultSet(categories: DiffCategoryResult[]): boolean {
  const orderDiffers = categories.some((c) => c.id === 'orderBy' && c.status === 'different');
  const hasLimitOrOffset = categories.some((c) => c.id === 'limit');
  return orderDiffers && hasLimitOrOffset;
}

function buildSummaryBody(
  diff: QueryResultDiff,
  tone: ResultDiffSummary['tone'],
  limitWithoutOrderCaution: boolean,
): string {
  if (limitWithoutOrderCaution) {
    if (diff.equalForResultSet) {
      return '構文上の差分はありませんが、ORDER BY がないため LIMIT / OFFSET で返る行は保証されません。';
    }
    return 'JOIN の記述順などの構文差は、下のカテゴリ一覧には出ない場合があります。ORDER BY がない LIMIT の返る行は実行依存です。';
  }
  if (tone === 'review-needed') {
    return '構文上は差分があります。下のヒントに当てはまるリファクタの可能性がありますが、結果が同じことは保証しません。';
  }
  return '結果セットは出力列・結合・条件など行の集合に影響する差分、並び順は ORDER BY の差分です。';
}

/** 2 段サマリー（結果セット / 並び順）＋要確認ヒント */
export function buildResultDiffSummary(diff: QueryResultDiff): ResultDiffSummary {
  const orderCategory = diff.categories.find((c) => c.id === 'orderBy');
  const orderDiffers = orderCategory?.status === 'different';
  const hints = diff.reviewHints ?? [];
  const nonOrderDifferent = diff.categories.filter((c) => c.id !== 'orderBy' && c.status === 'different');
  const hasExplicitResultSetDiff = nonOrderDifferent.length > 0;
  const limitWithoutOrderCaution = diff.limitWithoutOrderActive && !hasExplicitResultSetDiff;

  let order: ResultDiffSummary['order'];
  if (!orderCategory) {
    order = { status: 'not-specified', label: '指定なし' };
  } else if (orderDiffers) {
    order = { status: 'different', label: '異なる' };
  } else {
    order = { status: 'same', label: '同じ' };
  }

  const resultSetStatus: ResultDiffSummary['resultSet']['status'] = limitWithoutOrderCaution
    ? 'uncertain'
    : diff.equalForResultSet
      ? 'same'
      : 'different';
  const resultSetLabel = limitWithoutOrderCaution
    ? '要確認'
    : diff.equalForResultSet
      ? '同じ'
      : '異なる';

  let tone: ResultDiffSummary['tone'];
  if (limitWithoutOrderCaution) {
    tone = 'review-needed';
  } else if (diff.equalForResultSet) {
    tone = diff.equalIncludingOrder ? 'same' : 'order-only';
  } else if (hints.length > 0) {
    tone = 'review-needed';
  } else {
    tone = 'different';
  }

  const title = limitWithoutOrderCaution
    ? '要確認（LIMIT あり・ORDER BY なし）'
    : tone === 'review-needed'
      ? '要確認（構文差分あり）'
      : '比較結果';

  const otherDiffs = nonOrderDifferent;
  let note: string | undefined;
  if (orderAffectsResultSet(diff.categories) && otherDiffs.length === 0) {
    note = 'LIMIT / OFFSET があるため、ORDER BY の違いは返る行の集合にも影響し得ます。';
  }

  const effectiveInnerNote = diff.matchedViaEffectiveInner
    ? 'JOIN 種別は異なりますが、WHERE 等により実質 INNER JOIN 相当で、結果セットは同じと推定しています。'
    : undefined;

  const limitWithoutOrderWarning = diff.limitWithoutOrderActive
    ? 'ORDER BY がない状態で LIMIT / OFFSET があります。構文差分がなくても、返る行は実行計画や結合順に依存して変わり得ます。問題ないと判断せず、実データで確認してください。'
    : undefined;

  const body = buildSummaryBody(diff, tone, limitWithoutOrderCaution);

  return {
    tone,
    title,
    resultSet: {
      status: resultSetStatus,
      label: resultSetLabel,
    },
    order,
    note,
    effectiveInnerNote,
    limitWithoutOrderWarning,
    body,
    hints,
  };
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

function stripIdentifierQuotes(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1');
}

/** 比較用に空白を潰し、大文字小文字を揃え、識別子のバッククォートを除去する */
export function normalizeExpr(text: string | undefined | null): string {
  if (!text) return '';
  return stripIdentifierQuotes(text.replace(/\s+/g, ' ').trim().toLowerCase());
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

/** エイリアス解決後、実質 INNER JOIN の外部結合を INNER として揃える（HAVING 単独は過検出回避のため除外） */
function resolveForResultSetDiff(query: ParsedQuery): ParsedQuery {
  return normalizeEffectiveInnerJoins(resolveForDiff(query), { ignoreHavingReasons: true });
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

/** INNER 相当（STRAIGHT JOIN・CROSS JOIN を含む）。結果集合・ON 述語の比較に使う */
function isInnerLikeJoinType(type: JoinType | string): boolean {
  return isCommutativeJoinType(type) || normalizeExpr(type) === 'straight join';
}

/** 結果集合向けの結合構造比較では STRAIGHT JOIN も端点の並べ替えで同等扱い */
function isCommutativeJoinStructureType(type: JoinType | string): boolean {
  return isInnerLikeJoinType(type);
}

function normalizeInnerJoinTypeName(type: string): string {
  const t = normalizeExpr(type);
  if (t === 'join' || t === 'straight join') return 'inner join';
  return t;
}

/** ON 条件テキストを除いた結合構造（種別・結合端点） */
function joinStructureSignature(
  join: JoinEdge,
  idMap: Map<string, string>,
  nameMap: Map<string, string>,
): string {
  const source = idMap.get(join.sourceId) ?? join.sourceId;
  const target = idMap.get(join.targetId) ?? join.targetId;
  const natural = join.isNatural ? 'natural' : '';
  const rawType = normalizeExpr(join.type);

  if (isCommutativeJoinStructureType(join.type)) {
    const fromCondition = endpointsFromJoinCondition(join.condition, nameMap);
    const endpoints =
      fromCondition.length >= 2
        ? fromCondition.join('~')
        : [source, target].sort().join('~');
    return [normalizeInnerJoinTypeName(rawType), natural, endpoints].filter(Boolean).join('|');
  }

  if (rawType === 'right join') {
    return ['left join', natural, `${target}->${source}`].filter(Boolean).join('|');
  }

  if (rawType === 'full join') {
    return ['full join', natural, [source, target].sort().join('~')].filter(Boolean).join('|');
  }

  return [rawType, natural, `${source}->${target}`].filter(Boolean).join('|');
}

function joinStructureSignatures(query: ParsedQuery): string[] {
  const idMap = buildTableIdMap(query.tables);
  const nameMap = buildTableNameMap(query.tables);
  return query.joins.map((j) => joinStructureSignature(j, idMap, nameMap)).sort();
}

function joinSignature(
  join: JoinEdge,
  idMap: Map<string, string>,
  nameMap: Map<string, string>,
): string {
  const structure = joinStructureSignature(join, idMap, nameMap);
  const condition = normalizeJoinConditionText(join);
  return condition ? `${structure}|${condition}` : structure;
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

function physicalTableKey(table: TableRef): string {
  if (table.isDerived) return `derived:${normalizeExpr(table.alias ?? table.displayName)}`;
  return normalizeExpr(table.schema ? `${table.schema}.${table.table}` : table.table);
}

function isNotExistsNode(node: ConditionNode): boolean {
  if (node.type !== 'exists') return false;
  return normalizeExpr(node.label).startsWith('not exists');
}

function collectExistsNodes(
  node: ConditionNode | undefined,
  out: ConditionNode[] = [],
  underNot = false,
): ConditionNode[] {
  if (!node) return out;
  if (node.type === 'exists') {
    if (!underNot && !isNotExistsNode(node)) out.push(node);
    return out;
  }
  if (node.type === 'not') {
    for (const child of node.children ?? []) collectExistsNodes(child, out, true);
    return out;
  }
  for (const child of node.children ?? []) collectExistsNodes(child, out, underNot);
  return out;
}

function collectComparisonPreds(node: ConditionNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === 'comparison' || node.type === 'like' || node.type === 'in' || node.type === 'between' || node.type === 'is_null') {
    const left = normalizeExpr(node.left);
    const right = normalizeExpr(node.right);
    const op = normalizeExpr(node.operator) || node.type;
    if (op === '=' || op === '<=>') {
      out.push([left, right].sort().join(` ${op} `));
    } else {
      out.push(normalizeExpr(node.label) || `${left}|${op}|${right}`);
    }
  }
  for (const child of node.children ?? []) collectComparisonPreds(child, out);
  return out;
}

/**
 * ヒント用: 述語 bag は AND/OR を潰すため、OR/NOT を含む木では使わない。
 * EXISTS 等の葉はそのまま許容し、接続子だけを見る。
 */
function isAndOnlyConnectors(node: ConditionNode | undefined): boolean {
  if (!node) return true;
  if (node.type === 'or' || node.type === 'not') return false;
  if (node.type === 'and') {
    return (node.children ?? []).every(isAndOnlyConnectors);
  }
  return true;
}

function joinsHaveAndOnlyOn(joins: JoinEdge[]): boolean {
  return joins.every((join) => {
    if (join.conditionRoot) return isAndOnlyConnectors(join.conditionRoot);
    // conditionRoot が無い生文字列に OR が見えるときは保守的に拒否
    if (join.condition && /\bor\b/i.test(join.condition)) return false;
    return true;
  });
}

function collectJoinOnPreds(joins: JoinEdge[], out: string[] = []): string[] {
  for (const join of joins) {
    if (!isInnerLikeJoinType(join.type)) continue;
    if (join.conditionRoot) {
      collectComparisonPreds(join.conditionRoot, out);
    } else if (join.conditionParts) {
      const left = normalizeExpr(join.conditionParts.left);
      const right = normalizeExpr(join.conditionParts.right);
      const op = normalizeExpr(join.conditionParts.operator);
      if (op === '=' || op === '<=>') {
        out.push([left, right].sort().join(` ${op} `));
      } else {
        out.push(normalizeExpr(join.condition));
      }
    } else if (join.condition) {
      out.push(normalizeExpr(join.condition));
    }
  }
  return out;
}

function columnExprs(query: ParsedQuery): string[] {
  return query.columns.map((c) => normalizeExpr(c.expression));
}

/** 単純な列参照式からテーブル修飾子を取り出す（u.id / users.id / db.users.id） */
function extractLeadingTableRef(expr: string): string | null {
  const match = normalizeExpr(expr).match(/^((?:[\w]+\.)*[\w]+)\.[\w]+$/);
  return match?.[1] ?? null;
}

function tableRefKeys(table: TableRef): Set<string> {
  return new Set(
    [table.alias, table.table, table.displayName, table.schema ? `${table.schema}.${table.table}` : undefined]
      .filter(Boolean)
      .map((s) => normalizeExpr(s!)),
  );
}

function columnsOnlyFromTable(query: ParsedQuery, table: TableRef): boolean {
  const keys = tableRefKeys(table);
  const exprs = columnExprs(query);
  if (exprs.length === 0) return false;
  return exprs.every((expr) => {
    const prefix = extractLeadingTableRef(expr);
    if (!prefix) return false;
    return keys.has(prefix);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 相関サブクエリ内の外側エイリアス参照を実テーブル名へ寄せる */
function rewriteOuterTableRefs(text: string, outer: TableRef): string {
  if (!text) return '';
  const physical = outer.schema ? `${outer.schema}.${outer.table}` : outer.table;
  const names = [outer.alias, outer.table, outer.displayName].filter(Boolean) as string[];
  let result = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\w.])${escapeRegExp(name)}\\.`, 'g');
    result = result.replace(re, `${physical}.`);
  }
  return result;
}

function collectOuterPredsExcludingExists(
  node: ConditionNode | undefined,
  out: string[] = [],
): string[] {
  if (!node) return out;
  if (node.type === 'exists') return out;
  if (node.type === 'and' || node.type === 'or' || node.type === 'not') {
    for (const child of node.children ?? []) collectOuterPredsExcludingExists(child, out);
    return out;
  }
  collectComparisonPreds(node, out);
  return out;
}

/** 外側エイリアスを解決してから比較述語を収集 */
function collectComparisonPredsResolvingOuter(
  node: ConditionNode | undefined,
  outer: TableRef,
  out: string[] = [],
): string[] {
  if (!node) return out;
  if (
    node.type === 'comparison' ||
    node.type === 'like' ||
    node.type === 'in' ||
    node.type === 'between' ||
    node.type === 'is_null'
  ) {
    const left = normalizeExpr(rewriteOuterTableRefs(node.left ?? '', outer));
    const right = normalizeExpr(rewriteOuterTableRefs(node.right ?? '', outer));
    const op = normalizeExpr(node.operator) || node.type;
    if (op === '=' || op === '<=>') {
      out.push([left, right].sort().join(` ${op} `));
    } else {
      out.push(
        normalizeExpr(rewriteOuterTableRefs(node.label, outer)) || `${left}|${op}|${right}`,
      );
    }
  }
  for (const child of node.children ?? []) collectComparisonPredsResolvingOuter(child, outer, out);
  return out;
}

function sortedBagKey(preds: string[]): string {
  return [...preds].sort().join('\0');
}

function isExistsSemiJoinShape(query: ParsedQuery): boolean {
  if (query.statementType !== 'SELECT') return false;
  if (query.joins.length > 0) return false;
  if (query.tables.filter((t) => !t.isDerived).length !== 1) return false;
  if (query.groupBy.length > 0 || query.having) return false;
  if (query.limit || query.offset) return false;
  // OR/NOT 配下の EXISTS は半結合リファクタとみなさない（bag 比較の誤検知防止）
  if (!isAndOnlyConnectors(query.where)) return false;
  const existsNodes = collectExistsNodes(query.where);
  if (existsNodes.length !== 1) return false;
  // NOT EXISTS は反結合であり INNER JOIN+DISTINCT（半結合）とは意味が逆
  if (isNotExistsNode(existsNodes[0]!)) return false;
  const nested = existsNodes[0]?.nestedQuery;
  if (!nested) return false;
  if (nested.tables.filter((t) => !t.isDerived).length !== 1) return false;
  if (nested.joins.length > 0) return false;
  // ネスト側に集約・LIMIT があると DISTINCT JOIN への単純対応は崩れる
  if (nested.groupBy.length > 0 || nested.having) return false;
  if (nested.limit || nested.offset) return false;
  if (!isAndOnlyConnectors(nested.where)) return false;
  return true;
}

function isDistinctInnerJoinShape(query: ParsedQuery): boolean {
  if (query.statementType !== 'SELECT') return false;
  if (!query.distinct) return false;
  if (query.joins.length !== 1) return false;
  if (!isInnerLikeJoinType(query.joins[0]!.type)) return false;
  if (query.tables.filter((t) => !t.isDerived).length !== 2) return false;
  if (query.groupBy.length > 0 || query.having) return false;
  if (query.limit || query.offset) return false;
  if (!isAndOnlyConnectors(query.where) || !joinsHaveAndOnlyOn(query.joins)) return false;
  // SELECT 列は一方のテーブルのみ（半結合の典型）
  return query.tables.some((t) => !t.isDerived && columnsOnlyFromTable(query, t));
}

function detectExistsVsDistinctJoin(a: ParsedQuery, b: ParsedQuery): ReviewHint | null {
  const aExists = isExistsSemiJoinShape(a);
  const bExists = isExistsSemiJoinShape(b);
  const aJoin = isDistinctInnerJoinShape(a);
  const bJoin = isDistinctInnerJoinShape(b);
  if (!(aExists && bJoin) && !(bExists && aJoin)) return null;

  const existsQ = aExists ? a : b;
  const joinQ = aJoin ? a : b;
  const outer = existsQ.tables.find((t) => !t.isDerived);
  const joinOuter = joinQ.tables.find((t) => !t.isDerived && columnsOnlyFromTable(joinQ, t));
  if (!outer || !joinOuter) return null;
  if (physicalTableKey(outer) !== physicalTableKey(joinOuter)) return null;

  const existsInner = collectExistsNodes(existsQ.where)[0]?.nestedQuery?.tables.find(
    (t) => !t.isDerived,
  );
  const joinInner = joinQ.tables.find(
    (t) => !t.isDerived && physicalTableKey(t) !== physicalTableKey(joinOuter),
  );
  if (!existsInner || !joinInner) return null;
  if (physicalTableKey(existsInner) !== physicalTableKey(joinInner)) return null;

  const existsCols = columnExprs(existsQ).join('\0');
  const joinCols = columnExprs(joinQ).join('\0');
  if (existsCols !== joinCols) return null;

  // 外側 WHERE（EXISTS 以外）+ EXISTS 内 WHERE ≒ JOIN の WHERE + ON
  const existsBag = sortedBagKey([
    ...collectOuterPredsExcludingExists(existsQ.where),
    ...collectComparisonPredsResolvingOuter(
      collectExistsNodes(existsQ.where)[0]?.nestedQuery?.where,
      outer,
    ),
  ]);
  const joinBag = sortedBagKey([
    ...collectComparisonPreds(joinQ.where),
    ...collectJoinOnPreds(joinQ.joins),
  ]);
  if (!existsBag || existsBag !== joinBag) return null;

  return {
    id: 'exists-vs-distinct-join',
    title: '相関 EXISTS ↔ INNER JOIN + DISTINCT',
    message:
      '片方は相関 EXISTS、もう片方は INNER JOIN + DISTINCT で、外側テーブル・結合先・絞り込み条件が対応しています。多くの場合は結果セットは同じになります。保証はしません。実データでの確認を推奨します。',
  };
}

function predicateBagSignature(query: ParsedQuery): string {
  const preds: string[] = [];
  collectComparisonPreds(query.where, preds);
  collectJoinOnPreds(query.joins, preds);
  return preds.sort().join('\0');
}

function allJoinsInnerLike(query: ParsedQuery): boolean {
  return query.joins.length > 0 && query.joins.every((j) => isInnerLikeJoinType(j.type));
}

function detectWhereToOn(a: ParsedQuery, b: ParsedQuery): ReviewHint | null {
  if (a.statementType !== 'SELECT' || b.statementType !== 'SELECT') return null;
  if (!allJoinsInnerLike(a) || !allJoinsInnerLike(b)) return null;
  if (a.joins.length !== b.joins.length) return null;
  if (a.distinct !== b.distinct) return null;
  if (columnExprs(a).join('\0') !== columnExprs(b).join('\0')) return null;

  // bag 比較は OR/NOT を潰すため、AND のみのときに限る
  if (!isAndOnlyConnectors(a.where) || !isAndOnlyConnectors(b.where)) return null;
  if (!joinsHaveAndOnlyOn(a.joins) || !joinsHaveAndOnlyOn(b.joins)) return null;

  // WHERE↔ON 以外の差分があるときはヒントを出さない
  if (fragmentSetSignature(a.groupBy) !== fragmentSetSignature(b.groupBy)) return null;
  if (conditionSignature(a.having) !== conditionSignature(b.having)) return null;
  if (limitSignature(a) !== limitSignature(b)) return null;
  if (fragmentListSignature(a.orderBy) !== fragmentListSignature(b.orderBy)) return null;

  const tablesA = a.tables.map(physicalTableKey).sort().join('\0');
  const tablesB = b.tables.map(physicalTableKey).sort().join('\0');
  if (tablesA !== tablesB) return null;

  const joinStructA = joinStructureSignatures(a).join('\0');
  const joinStructB = joinStructureSignatures(b).join('\0');
  if (joinStructA !== joinStructB) return null;

  const whereA = conditionSignature(a.where);
  const whereB = conditionSignature(b.where);
  const bagA = predicateBagSignature(a);
  const bagB = predicateBagSignature(b);
  if (!bagA || bagA !== bagB) return null;
  // WHERE または ON の配置だけが違うとき
  if (whereA === whereB) return null;

  return {
    id: 'where-to-on',
    title: 'WHERE 条件と JOIN ON の配置違い',
    message:
      'INNER JOIN では、絞り込みを WHERE に書くか ON に書くかで行集合が同じになることが多いです。構文上は差分がありますが、意味的には同等の可能性があります。保証はしません。',
  };
}

/**
 * 構文差分はあるが、よくあるリファクタの可能性があるときの補助ヒント。
 * equalForResultSet は変更しない（誤って「同じ」に倒さない）。
 * @param resolved 省略時は内部で resolveForDiff する
 */
export function detectReviewHints(
  queryA: ParsedQuery,
  queryB: ParsedQuery,
  resolved?: { a: ParsedQuery; b: ParsedQuery },
): ReviewHint[] {
  const a = resolved?.a ?? resolveForDiff(queryA);
  const b = resolved?.b ?? resolveForDiff(queryB);
  const hints: ReviewHint[] = [];
  const existsHint = detectExistsVsDistinctJoin(a, b);
  if (existsHint) hints.push(existsHint);
  const whereOnHint = detectWhereToOn(a, b);
  if (whereOnHint) hints.push(whereOnHint);
  return hints;
}

function joinSignatureList(query: ParsedQuery): string {
  const idMap = buildTableIdMap(query.tables);
  const nameMap = buildTableNameMap(query.tables);
  return query.joins.map((j) => joinSignature(j, idMap, nameMap)).sort().join('\0');
}

/** JOIN の記述順・結合方向を含むシグネチャ */
function orderedJoinChainSignature(query: ParsedQuery): string {
  const idMap = buildTableIdMap(query.tables);
  return query.joins
    .map((join) => {
      const source = idMap.get(join.sourceId) ?? join.sourceId;
      const target = idMap.get(join.targetId) ?? join.targetId;
      const condition = normalizeJoinConditionText(join);
      const normalizedType = normalizeInnerJoinTypeName(join.type);
      return [normalizedType, source, target, condition].join('|');
    })
    .join('\0');
}

export function hasLimitWithoutOrder(query: ParsedQuery): boolean {
  return !!(query.limit || query.offset) && query.orderBy.length === 0;
}

const LIMIT_WITHOUT_ORDER_HINT: ReviewHint = {
  id: 'limit-without-order',
  title: 'LIMIT あり・ORDER BY なし',
  message:
    'JOIN の記述順が違います（カテゴリ比較では差分に出ません）。LIMIT 前の行集合は同じとみなされやすい一方、ORDER BY がないため LIMIT で返る行は実行依存で変わり得ます。実データでの確認を推奨します。',
};

const LIMIT_WITHOUT_ORDER_IDENTICAL_HINT: ReviewHint = {
  id: 'limit-without-order',
  title: 'LIMIT あり・ORDER BY なし',
  message:
    '構文上の差分はありませんが、ORDER BY がないため LIMIT / OFFSET で返る行は保証されません。実行のたびに変わり得るため、実データでの確認を推奨します。',
};

/**
 * 結果セット比較に使う正規化後クエリで JOIN 記述順差分を見る。
 * raw だと LEFT→実質 INNER のペアで JOIN 署名が不一致になり、ヒントを取りこぼす。
 * LIMIT / OFFSET 値や ORDER BY の差があるときは JOIN 順ヒントを出さない（誤案内防止）。
 */
function detectLimitWithoutOrderHint(
  normalizedA: ParsedQuery,
  normalizedB: ParsedQuery,
): ReviewHint | null {
  // 両側とも LIMIT/OFFSET あり・ORDER BY なしのときだけ JOIN 順を問題にする
  if (!hasLimitWithoutOrder(normalizedA) || !hasLimitWithoutOrder(normalizedB)) return null;
  if (limitSignature(normalizedA) !== limitSignature(normalizedB)) return null;
  if (joinSignatureList(normalizedA) !== joinSignatureList(normalizedB)) return null;
  if (orderedJoinChainSignature(normalizedA) === orderedJoinChainSignature(normalizedB)) {
    return null;
  }
  return LIMIT_WITHOUT_ORDER_HINT;
}

/**
 * JOIN 署名の再帰フィンガープリント（CTE・派生・UNION 内含む）。
 * クエリ全体ではなく JOIN だけを見ることで、将来ほかの正規化が入っても誤表示しにくくする。
 */
function joinGraphFingerprint(query: ParsedQuery): string {
  const idMap = buildTableIdMap(query.tables);
  const nameMap = buildTableNameMap(query.tables);
  const topLevel = query.joins
    .map((join) => joinSignature(join, idMap, nameMap))
    .sort()
    .join('\0');
  const nested: string[] = [];
  for (const table of query.tables) {
    if (!table.derivedQuery) continue;
    nested.push(
      `derived:${normalizeExpr(table.alias ?? table.displayName)}:${joinGraphFingerprint(table.derivedQuery)}`,
    );
  }
  for (const cte of query.ctes ?? []) {
    nested.push(`cte:${normalizeExpr(cte.name)}:${joinGraphFingerprint(cte.query)}`);
  }
  for (const [index, branch] of (query.unionBranches ?? []).entries()) {
    nested.push(`union:${index}:${joinGraphFingerprint(branch.query)}`);
  }
  return `${topLevel}##${nested.sort().join('\0')}`;
}

/** 正規化前は JOIN 種別が異なるが、実質 INNER JOIN として同等になったか（CTE・派生内含む） */
function detectMatchedViaEffectiveInner(
  rawA: ParsedQuery,
  rawB: ParsedQuery,
  normalizedA: ParsedQuery,
  normalizedB: ParsedQuery,
  equalForResultSet: boolean,
): boolean {
  if (!equalForResultSet) return false;
  if (joinGraphFingerprint(rawA) === joinGraphFingerprint(rawB)) return false;
  return joinGraphFingerprint(normalizedA) === joinGraphFingerprint(normalizedB);
}

/**
 * 2つの ParsedQuery を比較し、実行結果に影響しうる構文差分を返す。
 * 実データは使わず、エイリアス解決後の構造比較による推定。
 */
export function compareQueryResults(
  queryA: ParsedQuery,
  queryB: ParsedQuery,
): QueryResultDiff {
  const rawA = resolveForDiff(queryA);
  const rawB = resolveForDiff(queryB);
  const a = resolveForResultSetDiff(queryA);
  const b = resolveForResultSetDiff(queryB);

  const categories = compareTopLevel(a, b);
  const orderCategory = categories.find((c) => c.id === 'orderBy');
  const nonOrderDiffs = categories.filter((c) => c.id !== 'orderBy' && c.status === 'different');
  const orderDiffers = orderCategory?.status === 'different';
  const limitAffectsSet = orderAffectsResultSet(categories);
  const limitWithoutOrderActive = hasLimitWithoutOrder(a) || hasLimitWithoutOrder(b);
  const limitWithoutOrderHint = detectLimitWithoutOrderHint(a, b);

  // LIMIT/OFFSET があるとき ORDER BY 差分は行集合そのものを変え得る
  let equalForResultSet = nonOrderDiffs.length === 0 && !limitAffectsSet;
  if (limitWithoutOrderHint) {
    equalForResultSet = false;
  }
  const equalIncludingOrder = nonOrderDiffs.length === 0 && !orderDiffers && !limitWithoutOrderHint;

  if (limitAffectsSet && orderCategory && !orderCategory.details.some((d) => d.includes('LIMIT'))) {
    orderCategory.details.push(
      'LIMIT / OFFSET があるため、並びの違いは返る行の集合にも影響し得ます',
    );
  }

  let reviewHints = equalForResultSet
    ? []
    : detectReviewHints(queryA, queryB, {
        a: rawA,
        b: rawB,
      });

  if (limitWithoutOrderHint) {
    reviewHints = [
      ...reviewHints.filter((h) => h.id !== 'limit-without-order'),
      limitWithoutOrderHint,
    ];
  } else if (limitWithoutOrderActive && equalForResultSet) {
    reviewHints = [
      ...reviewHints.filter((h) => h.id !== 'limit-without-order'),
      LIMIT_WITHOUT_ORDER_IDENTICAL_HINT,
    ];
  }

  const matchedViaEffectiveInner = detectMatchedViaEffectiveInner(
    rawA,
    rawB,
    a,
    b,
    equalForResultSet,
  );

  return {
    equalForResultSet,
    equalIncludingOrder,
    categories,
    reviewHints,
    matchedViaEffectiveInner,
    limitWithoutOrderActive,
  };
}

/** テスト・デバッグ用: ORDER BY を除くシグネチャ */
export function resultSetSignature(query: ParsedQuery): string {
  return querySignature(resolveForResultSetDiff(query));
}

/** テスト・デバッグ用: ORDER BY シグネチャ */
export function orderSignature(query: ParsedQuery): string {
  return orderBySignature(resolveForDiff(query));
}
