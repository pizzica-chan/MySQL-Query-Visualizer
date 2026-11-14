import { applyAliasResolution } from './alias-resolver';
import { proveCqEquivalence, type CqEquivalenceResult } from './cq-equivalence';
import {
  isInnerLikeJoin,
  joinHasOnCondition,
  normalizeEffectiveInnerJoins,
} from './join-effective-inner';
import { joinTreeSignature, type JoinCondition, type JoinKind } from './join-tree';
import { residualTokenDiff } from './residual-token-diff';
import { maskNonCode, readBacktickIdentifierEnd, readQuotedStringEnd } from './sql-lex';
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
  UnionTail,
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
  | 'deleteTargets'
  | 'other';

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
  /**
   * 合接クエリ断片に収まる場合の等価性証明。
   * 構文差分があっても証明できれば結果セットは同じと言い切れる。証明できないときは not-proven。
   */
  equivalenceProof: CqEquivalenceResult;
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
  /** 合接クエリ断片で等価性を証明できたときの説明 */
  proofNote?: string;
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

/** 「証明済み」の範囲を毎回明示し、一般の意味等価と誤解されないようにする */
const CQ_SCOPE_NOTE =
  '判定対象は INNER 相当の JOIN・AND・= のみで構成される範囲（合接クエリ）に限定しています。';

function buildSummaryBody(
  diff: QueryResultDiff,
  tone: ResultDiffSummary['tone'],
  limitWithoutOrderCaution: boolean,
  proofStatus: CqEquivalenceResult['status'],
): string {
  if (limitWithoutOrderCaution) {
    if (diff.equalForResultSet) {
      return '構文上の差分はありませんが、ORDER BY がないため LIMIT / OFFSET で返る行は保証されません。';
    }
    return 'JOIN の記述順などの構文差は、下のカテゴリ一覧には出ない場合があります。ORDER BY がない LIMIT の返る行は実行依存です。';
  }
  if (proofStatus === 'proven-equivalent') {
    return '構文には差分がありますが、書き換え後も返る行の集合が変わらないことを構造から証明しました。';
  }
  if (proofStatus === 'proven-equivalent-set-only') {
    return '重複を除いた行の集合が一致することは証明しました。重複行の個数までは一致しない可能性があります。';
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
  const proof = diff.equivalenceProof ?? { status: 'not-proven' as const };
  const proven = proof.status === 'proven-equivalent';
  const provenSetOnly = proof.status === 'proven-equivalent-set-only';

  let order: ResultDiffSummary['order'];
  if (!orderCategory) {
    order = { status: 'not-specified', label: '指定なし' };
  } else if (orderDiffers) {
    order = { status: 'different', label: '異なる' };
  } else {
    order = { status: 'same', label: '同じ' };
  }

  let resultSetStatus: ResultDiffSummary['resultSet']['status'];
  let resultSetLabel: string;
  if (limitWithoutOrderCaution) {
    resultSetStatus = 'uncertain';
    resultSetLabel = '要確認';
  } else if (diff.equalForResultSet) {
    resultSetStatus = 'same';
    resultSetLabel = '同じ';
  } else if (proven) {
    resultSetStatus = 'same';
    resultSetLabel = '同じ（証明済み）';
  } else if (provenSetOnly) {
    resultSetStatus = 'uncertain';
    resultSetLabel = '重複を除けば同じ';
  } else {
    resultSetStatus = 'different';
    resultSetLabel = '異なる';
  }

  let tone: ResultDiffSummary['tone'];
  if (limitWithoutOrderCaution) {
    tone = 'review-needed';
  } else if (diff.equalForResultSet) {
    tone = diff.equalIncludingOrder ? 'same' : 'order-only';
  } else if (proven) {
    tone = orderDiffers ? 'order-only' : 'same';
  } else if (provenSetOnly || hints.length > 0) {
    tone = 'review-needed';
  } else {
    tone = 'different';
  }

  let title: string;
  if (limitWithoutOrderCaution) {
    title = '要確認（LIMIT あり・ORDER BY なし）';
  } else if (proven) {
    title = '比較結果（結果セットの一致を証明）';
  } else if (provenSetOnly) {
    title = '要確認（重複行の扱いのみ差分）';
  } else if (tone === 'review-needed') {
    title = '要確認（構文差分あり）';
  } else {
    title = '比較結果';
  }

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

  const proofNote =
    proven || provenSetOnly
      ? [proof.reason, CQ_SCOPE_NOTE].filter(Boolean).join(' ')
      : undefined;

  const body = buildSummaryBody(diff, tone, limitWithoutOrderCaution, proof.status);

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
    proofNote,
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
  other: 'その他の記述',
};

/**
 * 比較用に式を正規化する。空白を 1 つにまとめ、識別子とキーワードを小文字にし、
 * 識別子のバッククォートを外す。
 * 文字列リテラルは 1 文字も変えない。`'A'` と `'a'`、`'a  b'` と `'a b'` は別の値なので、
 * ここで揃えると結果が異なるクエリを「同じ」と判定してしまう。
 */
export function normalizeExpr(text: string | undefined | null): string {
  if (!text) return '';
  const src = text.trim();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"') {
      const end = readQuotedStringEnd(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = readBacktickIdentifierEnd(src, i);
      const closed = end - i >= 2 && src[end - 1] === '`';
      out += src
        .slice(i + 1, closed ? end - 1 : end)
        .replace(/``/g, '`')
        .toLowerCase();
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
      i += 1;
      continue;
    }
    // `!=` と `<>` は同じ演算子
    if (ch === '!' && src[i + 1] === '=') {
      out += '<>';
      i += 2;
      continue;
    }
    out += ch.toLowerCase();
    i += 1;
  }
  return out;
}

/**
 * 比較用のエイリアス解決。
 * 自己結合の別名は残す — u1 / u2 を同じ実テーブル名に潰すと
 * 「どちらのインスタンスを出力・絞り込みしているか」の違いが消え、別結果のクエリを同一と誤判定する。
 */
function resolveForDiff(query: ParsedQuery): ParsedQuery {
  const resolved = applyAliasResolution(query, true, { keepSelfJoinAliases: true });
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
  // テーブル名は大文字小文字を区別する。Linux の MySQL（lower_case_table_names=0）では
  // `Users` と `users` は別のテーブル
  const name = table.schema ? `${table.schema}.${table.table}` : table.table;
  return `table:${name.replace(/`/g, '').trim()}`;
}

/** テーブルの差分の表示。派生テーブルのキーは中身のシグネチャを含むので、別名だけを見せる */
function formatTableDetails(details: string[]): string[] {
  const label = (key: string): string => {
    if (!key.startsWith('derived:')) return key.replace(/^table:/, '');
    const alias = key.slice('derived:'.length).split(':')[0] ?? '';
    return `派生テーブル ${alias}`;
  };
  const parsed = details.map((line) => {
    const match = line.match(/^(A のみ|B のみ): (.*)$/s);
    return match ? { side: match[1]!, key: match[2]!, text: '' } : { side: '', key: line, text: line };
  });
  const labelsA = new Set(parsed.filter((p) => p.side === 'A のみ').map((p) => label(p.key)));
  const labelsB = new Set(parsed.filter((p) => p.side === 'B のみ').map((p) => label(p.key)));
  const out: string[] = [];
  const reported = new Set<string>();
  for (const p of parsed) {
    if (!p.side) {
      out.push(p.text);
      continue;
    }
    const name = label(p.key);
    // 同じ別名の派生テーブルが両方にあるなら、中身が違うということ
    if (p.key.startsWith('derived:') && labelsA.has(name) && labelsB.has(name)) {
      if (!reported.has(name)) out.push(`${name} の中身が異なります`);
      reported.add(name);
      continue;
    }
    out.push(`${p.side}: ${name}`);
  }
  return out;
}

function physicalName(table: TableRef): string {
  return normalizeExpr(table.schema ? `${table.schema}.${table.table}` : table.table);
}

/** 同じ実テーブルを 2 回以上参照している（自己結合の）実テーブル名 */
function selfJoinedNames(tables: TableRef[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const t of tables) {
    if (t.isDerived) continue;
    const name = physicalName(t);
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  return duplicated;
}

/**
 * 結合の端点を表すキー。
 * 自己結合では別名も含める。実テーブル名だけにすると
 * `users u1 LEFT JOIN users u2` と `users u2 LEFT JOIN users u1` の端点がどちらも
 * `users->users` になり、保持する側が逆の LEFT JOIN を同じ結合と判定してしまう。
 */
function tableLookupKey(table: TableRef, selfJoined: Set<string>): string {
  if (table.isDerived) {
    return normalizeExpr(table.alias ?? table.displayName) || table.id;
  }
  const name = physicalName(table);
  if (selfJoined.has(name)) return `${name}@${normalizeExpr(table.alias) || table.id}`;
  return name;
}

function buildTableIdMap(tables: TableRef[]): Map<string, string> {
  const selfJoined = selfJoinedNames(tables);
  const map = new Map<string, string>();
  for (const t of tables) {
    map.set(t.id, tableLookupKey(t, selfJoined));
  }
  return map;
}

/** エイリアス／テーブル名 → 比較用キー（ON 条件から結合相手を復元するため） */
function buildTableNameMap(tables: TableRef[]): Map<string, string> {
  const selfJoined = selfJoinedNames(tables);
  const map = new Map<string, string>();
  for (const t of tables) {
    const key = tableLookupKey(t, selfJoined);
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

/**
 * 端点の並べ替えで結果集合が変わらない結合種別。
 * 直積の CROSS JOIN（ON なし）も含む。行の絞り込みとしての INNER 相当は isInnerLikeJoin。
 */
function isCommutativeJoinType(type: JoinType | string): boolean {
  const t = normalizeExpr(type);
  return t === 'inner join' || t === 'join' || t === 'cross join' || t === 'straight join';
}

/** JOIN / STRAIGHT JOIN / CROSS JOIN ON を結果集合比較では INNER JOIN に寄せる */
function normalizeInnerJoinTypeName(join: JoinEdge): string {
  const t = normalizeExpr(join.type);
  if (t === 'join' || t === 'straight join') return 'inner join';
  if (t === 'cross join' && joinHasOnCondition(join)) return 'inner join';
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

  if (isCommutativeJoinType(join.type)) {
    const fromCondition = endpointsFromJoinCondition(join.condition, nameMap);
    const endpoints =
      fromCondition.length >= 2
        ? fromCondition.join('~')
        : [source, target].sort().join('~');
    return [normalizeInnerJoinTypeName(join), natural, endpoints].filter(Boolean).join('|');
  }

  if (rawType === 'right join') {
    return ['left join', natural, `${target}->${source}`].filter(Boolean).join('|');
  }

  if (rawType === 'full join') {
    return ['full join', natural, [source, target].sort().join('~')].filter(Boolean).join('|');
  }

  return [rawType, natural, `${source}->${target}`].filter(Boolean).join('|');
}

/** 条件の中で、修飾の無い列名ではない語（キーワード・単位） */
const CONDITION_KEYWORDS = new Set([
  'and', 'or', 'not', 'xor', 'is', 'null', 'true', 'false', 'unknown', 'in', 'like', 'between',
  'escape', 'case', 'when', 'then', 'else', 'end', 'interval', 'binary', 'collate', 'div', 'mod',
  'regexp', 'rlike', 'sounds', 'distinct', 'asc', 'desc', 'microsecond', 'second', 'minute', 'hour',
  'day', 'week', 'month', 'quarter', 'year',
]);

/** 修飾子（別名・テーブル名・スキーマ.テーブル名）→ テーブルのキー。同じ名前の参照が 2 つあれば両方 */
function buildQualifierIndex(query: ParsedQuery, idMap: Map<string, string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const t of query.tables) {
    const key = idMap.get(t.id) ?? t.id;
    for (const name of [t.alias, t.table, t.displayName, t.schema ? `${t.schema}.${t.table}` : undefined]) {
      if (!name) continue;
      const normalized = normalizeExpr(name);
      const keys = index.get(normalized) ?? new Set<string>();
      keys.add(key);
      index.set(normalized, keys);
    }
  }
  return index;
}

/**
 * 条件の式が読むテーブル。修飾の無い列名、どのテーブルか決まらない修飾子、
 * 中身を表示しないサブクエリの要約を含むときは 'unknown'
 */
function conditionTables(text: string, index: Map<string, Set<string>>): JoinCondition['tables'] {
  let masked = maskNonCode(text.replace(/`/g, ''));
  const tables = new Set<string>();
  const qualified = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:[A-Za-z_$][\w$]*|\*)/g;
  for (const match of masked.matchAll(qualified)) {
    const keys = index.get(match[1]!.toLowerCase());
    if (!keys || keys.size !== 1) return 'unknown';
    tables.add([...keys][0]!);
  }
  masked = masked.replace(qualified, (m) => ' '.repeat(m.length));
  for (const match of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const word = match[0].toLowerCase();
    const isFunction = /^\s*\(/.test(masked.slice(match.index! + match[0].length));
    if (!isFunction && !CONDITION_KEYWORDS.has(word)) return 'unknown';
  }
  return tables;
}

/** 条件の 1 項の比較用シグネチャ。`=` と `<=>` は左右を入れ替えても同じ */
function conjunctSignature(node: ConditionNode): string {
  const operator = (node.operator ?? '').trim();
  if (node.type === 'comparison' && (operator === '=' || operator === '<=>')) {
    return [normalizeExpr(node.left), normalizeExpr(node.right)].sort().join(` ${operator} `);
  }
  return conditionSignature(node);
}

function joinKind(join: JoinEdge): JoinKind {
  const type = normalizeExpr(join.type);
  if (join.isNatural) return { fixed: `natural ${type}` };
  if (type === 'inner join' || type === 'join' || type === 'straight join' || type === 'cross join') {
    return 'inner';
  }
  if (type === 'left join') return 'left';
  if (type === 'right join') return 'right';
  return { fixed: type };
}

function joinConditions(join: JoinEdge, index: Map<string, Set<string>>): JoinCondition[] {
  const root = join.conditionRoot;
  if (!root) {
    if (!joinHasOnCondition(join)) return [];
    return [{ signature: normalizeJoinConditionText(join), tables: conditionTables(join.condition, index) }];
  }
  const conjuncts = root.type === 'and' ? (root.children ?? []) : [root];
  return conjuncts.map((node) => ({
    signature: conjunctSignature(node),
    tables: conditionNodeTables(node, index),
  }));
}

/** 条件木が読むテーブル。AND / OR / NOT の label は演算子名だけなので、子をたどって集める */
function conditionNodeTables(node: ConditionNode, index: Map<string, Set<string>>): JoinCondition['tables'] {
  if (!node.children?.length) return conditionTables(node.label, index);
  const tables = new Set<string>();
  for (const child of node.children) {
    const childTables = conditionNodeTables(child, index);
    if (childTables === 'unknown') return 'unknown';
    for (const key of childTables) tables.add(key);
  }
  return tables;
}

/** FROM 句の結合の比較用シグネチャ（join-tree.ts）。木を組み立てられないときは null */
function joinTree(query: ParsedQuery): string | null {
  const idMap = buildTableIdMap(query.tables);
  const index = buildQualifierIndex(query, idMap);
  return joinTreeSignature(query, {
    tableKey: (id) => idMap.get(id) ?? id,
    kind: joinKind,
    conditions: (join) => joinConditions(join, index),
  });
}

/** 結合の比較用シグネチャ。木を組み立てられないときは、辺の集合で比べる */
function joinsSignature(query: ParsedQuery): string {
  const tree = joinTree(query);
  if (tree !== null) return `tree:${tree}`;
  const idMap = buildTableIdMap(query.tables);
  const nameMap = buildTableNameMap(query.tables);
  return `edges:${query.joins.map((j) => joinSignature(j, idMap, nameMap)).sort().join(',')}`;
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

/**
 * SET 句全体のシグネチャ。
 * 単一テーブルの UPDATE では、MySQL は代入を左から順に評価する（`SET x = x + 1, y = x` の y は更新後の x）。
 * 複数テーブルの UPDATE では順序が保証されないので、並べ替えると同じ結果になるとは言えない。
 * ほかの代入先の列を右辺で読んでいるときは、並び順も結果を決めるので並べ替えない。
 */
function setClausesSignature(sets: SetClause[]): string {
  const signatures = sets.map(setClauseSignature);
  // 列名だけで照らす。複数テーブルの UPDATE では `SET a.x = b.x, b.x = 1` のように
  // 同じ列名を別のテーブルで代入するので、自分と同じ列名を除くと順序の依存を見落とす
  const orderMatters = sets.some((set, index) => {
    const value = maskNonCode(set.value ?? '').toLowerCase();
    return sets.some((other, otherIndex) => {
      const column = normalizeExpr(other.column);
      return (
        otherIndex !== index &&
        column !== '' &&
        new RegExp(`(?<![\\w$])${escapeRegExp(column)}(?![\\w$])`).test(value)
      );
    });
  });
  return (orderMatters ? signatures : [...signatures].sort()).join('\0');
}

/**
 * 結果全体に掛かる ORDER BY / LIMIT。
 * UNION の orderBy / limit は先頭ブランチだけのものなので、unionTail を使う
 */
function resultTail(query: ParsedQuery): UnionTail {
  if (!query.unionBranches?.length) return query;
  return query.unionTail ?? { orderBy: [] };
}

function limitSignature(query: UnionTail): string {
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
  const columns = (cte.columns ?? []).map(normalizeExpr).join(',');
  return `${normalizeExpr(cte.name)}(${columns}):${querySignature(cte.query)}`;
}

/**
 * 入れ子のクエリ（派生テーブル・CTE・サブクエリ・UNION ブランチ）の ORDER BY。
 * LIMIT / OFFSET があるときは、並び順が「どの行を返すか」を決めるので行集合の比較に含める。
 */
function nestedOrderSignature(query: UnionTail): string {
  if (!query.limit && !query.offset) return '';
  return fragmentListSignature(query.orderBy);
}

function embeddedSubqueriesSignature(query: ParsedQuery): string {
  return (query.embeddedSubqueries ?? []).map(querySignature).join('||');
}

/** 入れ子のクエリの比較用シグネチャ（LIMIT が無いときの ORDER BY は除外） */
function querySignature(query: ParsedQuery): string {
  const parts = [
    query.statementType,
    query.distinct ? 'distinct' : '',
    query.columns.map(columnSignature).join(','),
    [...query.tables.map(tableKey)].sort().join(','),
    joinsSignature(query),
    conditionSignature(query.where),
    conditionSignature(query.having),
    query.groupByModifier ? fragmentListSignature(query.groupBy) : fragmentSetSignature(query.groupBy),
    limitSignature(query),
    nestedOrderSignature(query),
    embeddedSubqueriesSignature(query),
    setClausesSignature(query.setClauses ?? []),
    (query.deleteTargets ?? [])
      .map((d) => normalizeExpr(d.name))
      .sort()
      .join(','),
    (query.unionBranches ?? []).map(unionBranchSignature).join('||'),
    query.unionTail
      ? `tail:${limitSignature(query.unionTail)}:${nestedOrderSignature(query.unionTail)}`
      : '',
    (query.ctes ?? []).map(cteSignature).sort().join('||'),
    normalizeExpr(query.groupByModifier),
  ];
  return parts.join('##');
}

function orderBySignature(query: ParsedQuery): string {
  return fragmentListSignature(resultTail(query).orderBy);
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

/**
 * 修飾なしの `*` は FROM 句に書いた順にテーブルの列を並べ、USING / NATURAL の結合列を 1 つにまとめる。
 * 列の式が同じ `*` でも、テーブルの並びや USING の有無が違えば出力列が変わる。
 */
function starExpansionDetails(a: ParsedQuery, b: ParsedQuery): string[] {
  const hasBareStar = (q: ParsedQuery) => q.columns.some((c) => c.expression.trim() === '*');
  if (!hasBareStar(a) && !hasBareStar(b)) return [];

  const shape = (q: ParsedQuery): string => {
    const idMap = buildTableIdMap(q.tables);
    const tables = q.tables.map((t) => idMap.get(t.id) ?? t.id);
    const merged = q.joins.map((j) => {
      if (j.isNatural) return 'natural';
      return /^using\s*\(/i.test(j.condition.trim()) ? normalizeExpr(j.condition) : '';
    });
    return [tables.join(', '), merged.filter(Boolean).join(' ')].filter(Boolean).join(' / ');
  };

  const shapeA = shape(a);
  const shapeB = shape(b);
  if (shapeA === shapeB) return [];
  return [
    '`*` が展開する列の並び（FROM 句のテーブル順、USING / NATURAL でまとまる列）が異なります',
    `A: ${shapeA}`,
    `B: ${shapeB}`,
  ];
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
      ? category('columns', starExpansionDetails(a, b))
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
  const tableDetails = formatTableDetails(diffSortedLists(aTables, bTables));

  const aJoins = a.joins.map((j) => joinSignature(j, aIdMap, aNameMap)).sort();
  const bJoins = b.joins.map((j) => joinSignature(j, bIdMap, bNameMap)).sort();
  let joinDetails: string[] = [];
  if (joinsSignature(a) !== joinsSignature(b)) {
    joinDetails = diffSortedLists(aJoins, bJoins, (sig) => {
      const parts = sig.split('|');
      return parts.slice(0, 4).join(' / ') || sig;
    });
    if (joinDetails.length === 0) {
      // 結合の 1 つずつは同じでも、どの結合の結果に外部結合するかで行が変わる
      joinDetails = [
        '結合の組み立てが異なります（外部結合で行を残す側のテーブル、または外部結合と内部結合の順序）',
      ];
    }
  }

  const whereA = conditionSignature(a.where);
  const whereB = conditionSignature(b.where);
  const whereDetails = conditionDiffDetails(a.where, b.where, whereA, whereB);

  const havingA = conditionSignature(a.having);
  const havingB = conditionSignature(b.having);
  const havingDetails = conditionDiffDetails(a.having, b.having, havingA, havingB);

  const groupA = [...a.groupBy.map((g) => normalizeExpr(g.text))].sort();
  const groupB = [...b.groupBy.map((g) => normalizeExpr(g.text))].sort();
  const rollupA = normalizeExpr(a.groupByModifier);
  const rollupB = normalizeExpr(b.groupByModifier);
  // WITH ROLLUP は列の並び順どおりに小計を作るので、付いているときは順序も比べる
  const groupTextA = (rollupA ? a.groupBy.map((g) => normalizeExpr(g.text)) : groupA).join(', ');
  const groupTextB = (rollupB ? b.groupBy.map((g) => normalizeExpr(g.text)) : groupB).join(', ');
  const groupDetails =
    groupTextA === groupTextB && rollupA === rollupB
      ? []
      : diffScalar(
          'GROUP BY',
          [groupTextA, rollupA].filter(Boolean).join(' ') || '(なし)',
          [groupTextB, rollupB].filter(Boolean).join(' ') || '(なし)',
        );

  const tailA = resultTail(a);
  const tailB = resultTail(b);
  const orderA = tailA.orderBy.map((o) => normalizeExpr(o.text));
  const orderB = tailB.orderBy.map((o) => normalizeExpr(o.text));
  const orderDetails =
    orderA.join('\0') === orderB.join('\0')
      ? []
      : diffScalar('ORDER BY', orderA.join(', ') || '(なし)', orderB.join(', ') || '(なし)');

  const limitDetails =
    limitSignature(tailA) === limitSignature(tailB)
      ? []
      : diffScalar(
          'LIMIT',
          [tailA.limit && `LIMIT ${tailA.limit}`, tailA.offset && `OFFSET ${tailA.offset}`]
            .filter(Boolean)
            .join(' ') ||
            '(なし)',
          [tailB.limit && `LIMIT ${tailB.limit}`, tailB.offset && `OFFSET ${tailB.offset}`]
            .filter(Boolean)
            .join(' ') ||
            '(なし)',
        );

  const setLabelsA = (a.setClauses ?? []).map((s) => normalizeExpr(s.label) || setClauseSignature(s));
  const setLabelsB = (b.setClauses ?? []).map((s) => normalizeExpr(s.label) || setClauseSignature(s));
  let setDetails: string[] = [];
  if (setClausesSignature(a.setClauses ?? []) !== setClausesSignature(b.setClauses ?? [])) {
    setDetails = diffSortedLists(setLabelsA, setLabelsB);
    if (setDetails.length === 0) {
      setDetails = [
        '代入の順序が異なります（ほかの代入先の列を読む式があるため、順序によって結果が変わります）',
        `A: ${setLabelsA.join(', ')}`,
        `B: ${setLabelsB.join(', ')}`,
      ];
    }
  }

  const embeddedDetails =
    embeddedSubqueriesSignature(a) === embeddedSubqueriesSignature(b)
      ? []
      : ['式の中のサブクエリ（SELECT 列・関数の引数・SET の右辺など）の内容が異なります'];

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
    category('other', embeddedDetails),
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
    orderBy: tailA.orderBy.length > 0 || tailB.orderBy.length > 0 || orderDetails.length > 0,
    limit: !!(tailA.limit || tailB.limit || tailA.offset || tailB.offset) || limitDetails.length > 0,
    union: !!(a.unionBranches?.length || b.unionBranches?.length) || unionDetails.length > 0,
    cte: !!(a.ctes?.length || b.ctes?.length) || cteDetails.length > 0,
    set: !!(a.setClauses?.length || b.setClauses?.length) || setDetails.length > 0,
    deleteTargets:
      !!(a.deleteTargets?.length || b.deleteTargets?.length) || deleteDetails.length > 0,
    other: false,
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
    if (!isInnerLikeJoin(join)) continue;
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
  if (!isInnerLikeJoin(query.joins[0]!)) return false;
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
  return query.joins.length > 0 && query.joins.every((j) => isInnerLikeJoin(j));
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
  if (limitSignature(resultTail(a)) !== limitSignature(resultTail(b))) return null;
  if (orderBySignature(a) !== orderBySignature(b)) return null;

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
      const normalizedType = normalizeInnerJoinTypeName(join);
      return [normalizedType, source, target, condition].join('|');
    })
    .join('\0');
}

export function hasLimitWithoutOrder(query: ParsedQuery): boolean {
  const tail = resultTail(query);
  return !!(tail.limit || tail.offset) && tail.orderBy.length === 0;
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
  if (limitSignature(resultTail(normalizedA)) !== limitSignature(resultTail(normalizedB))) return null;
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

const RESIDUAL_TOKEN_PREVIEW = 8;

function formatResidualTokens(tokens: string[]): string {
  const shown = tokens.slice(0, RESIDUAL_TOKEN_PREVIEW).join(' ');
  return tokens.length > RESIDUAL_TOKEN_PREVIEW ? `${shown} …` : shown;
}

/**
 * カテゴリ比較で差分が出なかったときだけ、元 SQL の字句の過不足を確かめる。
 * パーサが表示用文字列にしない構文の違いを「同じ」と判定しないための確認で、
 * 過不足があれば「その他の記述」カテゴリの差分として足す。
 */
function applyResidualTokenGuard(
  categories: DiffCategoryResult[],
  queryA: ParsedQuery,
  queryB: ParsedQuery,
): void {
  if (categories.some((c) => c.id !== 'orderBy' && c.status === 'different')) return;
  const { onlyA, onlyB } = residualTokenDiff(queryA, queryB);
  if (onlyA.length === 0 && onlyB.length === 0) return;

  const details = ['カテゴリ別の比較が扱わない記述に違いがあります。結果が同じとは判定できません'];
  if (onlyA.length > 0) details.push(`A のみ: ${formatResidualTokens(onlyA)}`);
  if (onlyB.length > 0) details.push(`B のみ: ${formatResidualTokens(onlyB)}`);

  const index = categories.findIndex((c) => c.id === 'other');
  const result = category('other', details);
  if (index >= 0) categories[index] = result;
  else categories.push(result);
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
  applyResidualTokenGuard(categories, queryA, queryB);
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

  // エイリアス解決前の生クエリで判定する（自己結合を潰さないため）
  const equivalenceProof: CqEquivalenceResult = equalForResultSet
    ? { status: 'not-proven', reason: '構文差分がないため証明は不要です' }
    : proveCqEquivalence(queryA, queryB);
  const proven = equivalenceProof.status !== 'not-proven';

  let reviewHints =
    equalForResultSet || proven
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
    equivalenceProof,
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
