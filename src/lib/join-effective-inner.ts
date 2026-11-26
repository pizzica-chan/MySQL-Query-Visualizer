import type { ConditionNode, JoinEdge, JoinType, ParsedQuery, TableRef } from './types';
import { NO_JOIN_CONDITION, joinConditionDisplayText } from './join-condition';
import { maskNonCode, readBalancedParenEnd } from './sql-lex';

export interface EffectiveInnerReason {
  kind: 'inner_join' | 'where' | 'having';
  label: string;
  /** kind === 'inner_join' のときの結合種別 */
  joinType?: JoinType;
  /** kind === 'inner_join' で、後続の結合が SQL 上は外部結合で、実質 INNER JOIN になっているもの */
  viaEffectiveInner?: boolean;
}

export interface EffectiveInnerAnalysis {
  joinId: string;
  reasons: EffectiveInnerReason[];
  /** 実質 INNER 判定の根拠となった nullable 側テーブル id（RIGHT JOIN は左側の複数可） */
  nullableTableIds: string[];
}

/**
 * NULL を受け取っても NULL 以外を返しうる構文。
 * これを含む式は、nullable 側の列が NULL でも真になりうるので、NULL 行を除外する根拠にしない。
 * 例: `CASE WHEN o.x IS NULL THEN 1 ELSE 0 END = 1`、`a.x IN (o.y, 1)`、`o.x <=> NULL`。
 * 関数（ISNULL・IFNULL・QUOTE など）は、引数の位置まで見て別に判定する（referencesTableOnlyInsideNonPropagatingCalls）
 */
const NULL_SWALLOWING_RE = /\b(?:case|exists|select|is|in|or|xor|and)\b|<=>|\|\||&&/i;

/**
 * 集約関数の呼び出し（MySQL 8.4 リファレンス 14.19.1）。
 * ANY_VALUE は集約関数ではないが、グループの中のどれか 1 行の値を返すので含める
 */
const AGGREGATE_CALL_RE =
  /\b(?:count|sum|avg|min|max|group_concat|bit_and|bit_or|bit_xor|std|stddev|stddev_pop|stddev_samp|var_pop|var_samp|variance|json_arrayagg|json_objectagg|any_value)\s*\(/i;

/**
 * 値がすべて NULL のグループでも NULL を返さない集約。COUNT は 0、BIT_AND などはビットの初期値、
 * JSON_ARRAYAGG は [null] を返す（14.19.1）
 */
const NON_NULL_AGGREGATE_CALL_RE = /\b(?:count|bit_and|bit_or|bit_xor|json_arrayagg|json_objectagg)\s*\(/i;

/** 両辺のどちらかが NULL でも真偽が決まる演算子。葉として来ても NULL 行を除外する根拠にしない */
const NON_NULL_PROPAGATING_OPERATORS = new Set(['<=>', '||', '&&', 'OR', 'AND', 'XOR']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableIdentifiers(table: TableRef): string[] {
  const ids = [table.alias, table.table, table.displayName].filter(Boolean) as string[];
  return [...new Set(ids)];
}

/** SQL 本文でこのテーブル参照を指す名前。別名を付けたら別名でしか参照できない */
function primaryIdentifier(table: TableRef): string | undefined {
  return table.alias || table.table || table.displayName || undefined;
}

/**
 * 式の中でこのテーブル参照だけを指す識別子。
 *
 * tableIdentifiers は主名のほかに、別名解決後のテキスト（`u.` が `users.` になる）用に
 * 実テーブル名も候補に含む。自己結合ではこの副次名が別インスタンスと衝突するため、
 * `FROM users LEFT JOIN users u2` の `users.` を u2 への参照と誤読していた。
 *
 * そこで副次名は、他の参照の主名でも他の参照の副次名でもないときだけ採用する。
 * 主名（上の例の無別名 `users`）はそのインスタンスを一意に指すので落とさない。
 */
function tableReferenceIdentifiers(table: TableRef, allTables: TableRef[]): string[] {
  const primaryCounts = new Map<string, number>();
  const secondaryCounts = new Map<string, number>();

  for (const other of allTables) {
    const primary = primaryIdentifier(other)?.toLowerCase();
    if (primary) primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
    for (const id of tableIdentifiers(other)) {
      const key = id.toLowerCase();
      if (key === primary) continue;
      secondaryCounts.set(key, (secondaryCounts.get(key) ?? 0) + 1);
    }
  }

  const own = primaryIdentifier(table)?.toLowerCase();
  return tableIdentifiers(table).filter((id) => {
    const key = id.toLowerCase();
    // 主名は、他の参照と重複していなければそのインスタンスを一意に指す
    if (key === own) return (primaryCounts.get(key) ?? 0) === 1;
    // 副次名は、他の参照の主名・副次名と衝突したら誰を指すか決められない
    if ((primaryCounts.get(key) ?? 0) > 0) return false;
    return (secondaryCounts.get(key) ?? 0) === 1;
  });
}

/**
 * テーブル参照を走査する前に文字列リテラル・コメントを空白へ潰す。
 * `WHERE u.note = 'o.id'` の `'o.id'` を orders への参照と誤読すると、
 * 絞り込みが無い LEFT JOIN を実質 INNER と判定してしまう。
 * maskNonCode は長さを保つので、マスク後の位置は元の式の位置と一致する。
 */
function maskExprLiterals(expr: string): string {
  return maskNonCode(expr);
}

function expressionReferencesTable(expr: string, identifiers: string[]): boolean {
  if (!expr) return false;
  const masked = maskExprLiterals(expr);
  return identifiers.some((id) => {
    const pattern = new RegExp(`\\b${escapeRegex(id)}\\.`, 'i');
    return pattern.test(masked);
  });
}

export function isInnerJoinType(type: JoinType): boolean {
  return type === 'INNER JOIN' || type === 'JOIN' || type === 'STRAIGHT JOIN';
}

/** ON / USING があるか（直積の CROSS JOIN と INNER 相当の CROSS JOIN ON を区別する） */
export function joinHasOnCondition(join: JoinEdge): boolean {
  if (join.conditionRoot) return true;
  const condition = join.condition.trim();
  return condition.length > 0 && condition !== NO_JOIN_CONDITION;
}

/**
 * すべての行の組み合わせ（直積）を作る結合か。ON / USING の無い CROSS JOIN のほか、
 * ON の無い INNER JOIN・JOIN・STRAIGHT_JOIN とカンマ結合も、MySQL では CROSS JOIN と同じ結果になる
 * （MySQL 8.4 リファレンス 15.2.13.2 JOIN Clause）
 */
export function isCartesianJoin(join: JoinEdge): boolean {
  return (join.type === 'CROSS JOIN' || isInnerJoinType(join.type)) && !joinHasOnCondition(join);
}

/**
 * 結果行を絞り込む INNER 相当（ON / USING 付き CROSS JOIN を含む）。
 * 直積の CROSS JOIN は含めない。端点の可換比較は query-result-diff の isCommutativeJoinType。
 */
export function isInnerLikeJoin(join: JoinEdge): boolean {
  if (isInnerJoinType(join.type)) return true;
  return join.type === 'CROSS JOIN' && joinHasOnCondition(join);
}

function isOuterJoinWithNullableSide(type: JoinType): boolean {
  return type === 'LEFT JOIN' || type === 'RIGHT JOIN';
}

function tableIndexInFrom(tables: TableRef[], tableId: string): number {
  return tables.findIndex((t) => t.id === tableId);
}

/** 外部結合で NULL 埋めされうる側のテーブル（RIGHT JOIN はターゲットより左の全体） */
function nullableSideTables(join: JoinEdge, tables: TableRef[]): TableRef[] {
  if (join.type === 'LEFT JOIN') {
    const target = tables.find((t) => t.id === join.targetId);
    return target ? [target] : [];
  }
  if (join.type === 'RIGHT JOIN') {
    const targetIdx = tableIndexInFrom(tables, join.targetId);
    if (targetIdx < 0) return [];
    return tables.filter((_, i) => i < targetIdx);
  }
  return [];
}

function tableDisplayLabel(table: TableRef): string {
  if (table.isDerived) {
    if (/派生テーブル/.test(table.displayName)) return table.displayName;
    return `${table.displayName}（派生テーブル）`;
  }
  const physical = table.schema ? `${table.schema}.${table.table}` : table.table;
  if (table.alias && table.alias !== table.table) {
    return `${physical}（${table.alias}）`;
  }
  return physical;
}

function innerJoinReasonLabel(join: JoinEdge, tables: TableRef[]): string {
  const target = tables.find((t) => t.id === join.targetId);
  const name = target ? tableDisplayLabel(target) : join.targetId;
  const typeLabel = join.type === 'JOIN' ? 'INNER JOIN' : join.type;
  return `${typeLabel} ${name}`;
}

/**
 * 引数が NULL なら NULL を返すと MySQL 8.4 リファレンスで確かめた関数（14.8 文字列、14.6 数値、14.7 日付と時刻、
 * 14.10 CAST と CONVERT、14.4.2 の GREATEST と LEAST）。ROW と NOT は関数ではないが、同じく NULL をそのまま伝える。
 * ここに無い関数は、NULL を受け取っても NULL 以外を返しうるものとして扱う。QUOTE(NULL) は文字列の 'NULL' を返し、
 * IFNULL や COALESCE は別の値に置き換え、利用者が作ったストアドファンクションは何を返すか分からない
 */
const NULL_PROPAGATING_FUNCTIONS = new Set([
  'upper', 'lower', 'ucase', 'lcase', 'trim', 'ltrim', 'rtrim', 'concat', 'substring', 'substr', 'mid', 'left',
  'right', 'length', 'char_length', 'character_length', 'replace', 'lpad', 'rpad', 'reverse', 'repeat', 'locate',
  'instr', 'substring_index', 'hex',
  'abs', 'ceil', 'ceiling', 'floor', 'round', 'truncate', 'mod', 'sign', 'sqrt', 'pow', 'power',
  'date', 'time', 'year', 'month', 'day', 'dayofmonth', 'hour', 'minute', 'second', 'weekday', 'dayofweek',
  'date_format', 'datediff', 'to_days', 'str_to_date',
  'cast', 'convert', 'greatest', 'least',
  'row', 'not',
  // 値がすべて NULL のグループで NULL を返す集約（14.19.1）。COUNT などの NULL を返さない集約は isGroupLevelNullRejecting で除く
  'sum', 'avg', 'min', 'max', 'group_concat', 'std', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop',
  'var_samp', 'any_value',
]);

/** 関数の呼び出し（名前と開き括弧）。名前には MySQL が識別子に認める U+0080〜U+FFFF も含める */
const FUNCTION_CALL_RE = /(?<![\w$\u0080-\uFFFF])([\w$\u0080-\uFFFF]+)\s*\(/gu;

/** NULL を伝えると確かめていない関数の、引数の範囲（開き括弧の直後〜閉じ括弧の直前） */
function findNonPropagatingCallArgSpans(rawExpr: string): Array<{ start: number; end: number }> {
  const expr = maskExprLiterals(rawExpr);
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of expr.matchAll(FUNCTION_CALL_RE)) {
    // `db.upper(x)` は、そのデータベースのストアドファンクション。名前が組み込みの関数と同じでも別の関数になる
    const qualified = expr[match.index - 1] === '.';
    if (!qualified && NULL_PROPAGATING_FUNCTIONS.has(match[1]!.toLowerCase())) continue;
    const openParen = match.index + match[0].length - 1;
    const callEnd = readBalancedParenEnd(expr, openParen);
    spans.push({ start: openParen + 1, end: callEnd === null ? expr.length : callEnd - 1 });
  }
  return spans;
}
function tableRefStartPositions(rawExpr: string, identifiers: string[]): number[] {
  const expr = maskExprLiterals(rawExpr);
  const positions: number[] = [];
  for (const id of identifiers) {
    const pattern = new RegExp(`\\b${escapeRegex(id)}\\.`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(expr)) !== null) {
      positions.push(match.index);
    }
  }
  return positions;
}

/**
 * nullable 側への参照がすべて、NULL を伝えると確かめていない関数の引数の中にあるか。
 * 例: `IFNULL(o.total, 0) = 0` や `QUOTE(o.x) = 'NULL'` は、未結合行（列が NULL）でも真になりうるので実質 INNER にしない。
 * 引数の外に参照が 1 つでもあれば（`f(a.x) = o.y`）、その列が NULL の行では式全体も NULL になる
 */
function referencesTableOnlyInsideNonPropagatingCalls(
  expr: string,
  identifiers: string[],
): boolean {
  if (!expressionReferencesTable(expr, identifiers)) return false;
  const spans = findNonPropagatingCallArgSpans(expr);
  if (spans.length === 0) return false;
  const refs = tableRefStartPositions(expr, identifiers);
  if (refs.length === 0) return false;
  return refs.every((pos) => spans.some((span) => pos >= span.start && pos < span.end));
}
/**
 * 式がこのテーブルの列を読み、その列が NULL なら式全体も NULL になるか。
 * 式の中身までは解析せず、NULL を別の値に変えうる構文が 1 つでもあれば false にする。
 */
function expressionPropagatesNull(expr: string | undefined, identifiers: string[]): boolean {
  if (!expr || !expressionReferencesTable(expr, identifiers)) return false;
  if (NULL_SWALLOWING_RE.test(maskExprLiterals(expr))) return false;
  // 参照が、NULL を伝えると確かめていない関数の引数の中にしか無いときは、未結合行を残しうる
  if (referencesTableOnlyInsideNonPropagatingCalls(expr, identifiers)) return false;
  return true;
}

/**
 * この葉の条件が、nullable 側の列がすべて NULL の行（未結合行）では決して真にならないか。
 * negated は NOT の内側にあるとき true。値が NULL になる条件は NOT を付けても NULL のままだが、
 * `IS NOT NULL` や `IN (サブクエリ)` は NOT を付けると未結合行で真になる。
 */
function isNullRejectingLeaf(
  node: ConditionNode,
  identifiers: string[],
  negated: boolean,
): boolean {
  const operator = (node.operator ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

  switch (node.type) {
    case 'comparison':
    case 'like': {
      if (NON_NULL_PROPAGATING_OPERATORS.has(operator)) return false;
      if (operator === 'IS' || operator === 'IS NOT') {
        return isTestRejectsNull(node, identifiers, operator === 'IS NOT' ? !negated : negated);
      }
      const quantifier = /^(ALL|ANY|SOME)\s*\(/i.exec((node.right ?? '').trim())?.[1]?.toUpperCase();
      if (quantifier) {
        // サブクエリが 0 行のとき、`x <> ALL (…)` は x が NULL でも真、`x = ANY (…)` は偽になる
        // （MySQL 8.4 リファレンス 15.2.15.3、15.2.15.4）。1 行以上なら x が NULL のときはどちらも NULL。
        // 真にならないのは ALL を否定したときと、ANY を否定しないとき
        if ((quantifier === 'ALL') !== negated) return false;
        return expressionPropagatesNull(node.left, identifiers);
      }
      return (
        expressionPropagatesNull(node.left, identifiers) ||
        expressionPropagatesNull(node.right, identifiers)
      );
    }
    case 'between':
      // 境界側だけが NULL のとき、NOT BETWEEN は真になりうる（`5 NOT BETWEEN NULL AND 1`）。左辺だけを見る
      return expressionPropagatesNull(node.left, identifiers);
    case 'in':
      // `NULL NOT IN (空のサブクエリ)` は真。サブクエリ相手は否定の無い IN だけを根拠にする
      if (node.nestedQuery && (negated || operator !== 'IN')) return false;
      // リスト側にだけ参照があるとき（`a.x IN (o.y, 1)`）は未結合行でも真になりうる。左辺だけを見る
      return expressionPropagatesNull(node.left, identifiers);
    case 'subquery':
      if (NON_NULL_PROPAGATING_OPERATORS.has(operator)) return false;
      return expressionPropagatesNull(node.left, identifiers);
    case 'function':
    case 'raw':
      return expressionPropagatesNull(node.label, identifiers);
    case 'is_null':
      return isTestRejectsNull(node, identifiers, negated);
    default:
      // exists は根拠にしない
      return false;
  }
}

/**
 * `x IS NULL` / `x IS TRUE` などで、x が NULL の行では決して真にならないか。
 * inverted は IS NOT と外側の NOT を合わせて、否定が奇数回掛かっているとき true。
 * x が NULL のとき `IS NULL` / `IS UNKNOWN` は真、`IS TRUE` / `IS FALSE` は偽になる（否定するとそれぞれ逆）
 */
function isTestRejectsNull(node: ConditionNode, identifiers: string[], inverted: boolean): boolean {
  const target = (node.right ?? '').trim().toUpperCase();
  let rejects: boolean;
  if (target === 'NULL' || target === 'UNKNOWN') rejects = inverted;
  else if (target === 'TRUE' || target === 'FALSE') rejects = !inverted;
  else return false;
  return rejects && expressionPropagatesNull(node.left, identifiers);
}

interface NullRejectingLeaf {
  node: ConditionNode;
  /** NOT の内側にある葉。理由に出すときは NOT を付けて、元の条件と同じ意味の文にする */
  negated: boolean;
}

/** 条件木を、理由の文に書く SQL の形にする（AND / OR の入れ子は括弧で囲む） */
function conditionText(node: ConditionNode): string {
  if (node.type === 'not') return `NOT (${(node.children ?? []).map(conditionText).join(' AND ')})`;
  if (node.type === 'and' || node.type === 'or') {
    const joiner = node.type === 'and' ? ' AND ' : ' OR ';
    return (node.children ?? [])
      .map((child) => (child.type === 'and' || child.type === 'or' ? `(${conditionText(child)})` : conditionText(child)))
      .join(joiner);
  }
  return node.label;
}

/**
 * 条件木から「未結合行では決して真にならない」葉を集める。
 * AND は、どれか 1 つの枝が真にならなければ全体も真にならない。
 * OR は、すべての枝が真にならないときだけ全体も真にならない（`b.x = 1 OR b.z = 2` は b の無い行で両方とも
 * 真にならない）。そのときは OR 全体を 1 つの葉として返す。1 つでも真になりうる枝があれば根拠にしない。
 * NOT の内側では AND と OR が入れ替わる（`NOT (A AND B)` は `NOT A OR NOT B`）。
 */
function collectNullRejectingLeaves(
  node: ConditionNode | undefined,
  identifiers: string[],
  negated = false,
): NullRejectingLeaf[] {
  if (!node) return [];

  if (node.type === 'not') {
    return (node.children ?? []).flatMap((child) =>
      collectNullRejectingLeaves(child, identifiers, !negated),
    );
  }

  if (node.type === 'and' || node.type === 'or') {
    const actsAsOr = (node.type === 'or') !== negated;
    const perChild = (node.children ?? []).map((child) =>
      collectNullRejectingLeaves(child, identifiers, negated),
    );
    if (!actsAsOr) return perChild.flat();
    if (perChild.length === 0 || perChild.some((leaves) => leaves.length === 0)) return [];
    return [{ node: { ...node, label: conditionText(node) }, negated }];
  }

  if (!isNullRejectingLeaf(node, identifiers, negated)) return [];
  return [{ node, negated }];
}

function leafReasonText(leaf: NullRejectingLeaf): string {
  return leaf.negated ? `NOT (${leaf.node.label})` : leaf.node.label;
}

/**
 * HAVING の葉が、未結合の行のグループを除く根拠になるか。
 *
 * 集約はグループの行をまとめた値なので、次のときは根拠にしない。
 * - NULL だけのグループでも NULL を返さない集約を含む（`HAVING COUNT(o.id) = 0` は未結合の行だけを残す）
 * - GROUP BY が無い、または WITH ROLLUP が付く。未結合の行と結合できた行が同じグループ（小計の行を含む）に入る
 *
 * `GROUP BY u.id HAVING SUM(o.x) > 0` は、u.id が一意なら未結合の u の行だけのグループができ、
 * SUM が NULL になり、HAVING で除かれる。GROUP BY の列が一意かは SQL だけでは分からないので、ここは一意とみなしている
 */
function isGroupLevelNullRejecting(leaf: NullRejectingLeaf, query: ParsedQuery): boolean {
  const text = maskExprLiterals(leaf.node.label);
  if (!AGGREGATE_CALL_RE.test(text)) return true;
  if (NON_NULL_AGGREGATE_CALL_RE.test(text)) return false;
  return query.groupBy.length > 0 && !query.groupByModifier;
}

function collectConditionReasons(
  query: ParsedQuery,
  kind: 'where' | 'having',
  identifiers: string[],
): EffectiveInnerReason[] {
  const prefix = kind === 'where' ? 'WHERE' : 'HAVING';
  const leaves = collectNullRejectingLeaves(kind === 'where' ? query.where : query.having, identifiers);
  const usable = kind === 'having' ? leaves.filter((leaf) => isGroupLevelNullRejecting(leaf, query)) : leaves;
  return usable.map((leaf) => ({
    kind,
    label: `${prefix}: ${leafReasonText(leaf)}`,
  }));
}

function findSubsequentInnerJoinReasons(
  joins: JoinEdge[],
  tables: TableRef[],
  joinIndex: number,
  identifiers: string[],
  effectiveInnerJoinIds: ReadonlySet<string>,
): EffectiveInnerReason[] {
  const reasons: EffectiveInnerReason[] = [];

  for (let i = joinIndex + 1; i < joins.length; i++) {
    const join = joins[i]!;
    // 後続の外部結合が実質 INNER JOIN なら、その結合条件も行を絞る（`a LEFT JOIN b … LEFT JOIN c ON c.b_id = b.id
    // WHERE c.z > 0` は、c の無い行が除かれ、c と結び付いた b の無い行も残らない）
    const viaEffectiveInner = !isInnerLikeJoin(join);
    if (viaEffectiveInner && !effectiveInnerJoinIds.has(join.id)) continue;
    // ON に nullable 側の列が出てくるだけでは足りない。`ON p.id = o.pid OR p.aid = a.id` や
    // `ON p.id = COALESCE(o.pid, a.pid)` は未結合行でも成り立つので、WHERE と同じ基準で葉を調べる
    const root = join.layoutConditionRoot ?? join.conditionRoot;
    if (collectNullRejectingLeaves(root, identifiers).length === 0) continue;
    reasons.push({
      kind: 'inner_join',
      label: innerJoinReasonLabel(join, tables),
      joinType: join.type,
      ...(viaEffectiveInner ? { viaEffectiveInner } : {}),
    });
  }

  return reasons;
}

function dedupeReasons(reasons: EffectiveInnerReason[]): EffectiveInnerReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.kind}:${reason.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reasonsForNullableTable(
  query: ParsedQuery,
  joinIndex: number,
  nullableTable: TableRef,
  effectiveInnerJoinIds: ReadonlySet<string>,
): EffectiveInnerReason[] {
  const identifiers = tableReferenceIdentifiers(nullableTable, query.tables);
  if (identifiers.length === 0) return [];

  return dedupeReasons([
    ...findSubsequentInnerJoinReasons(query.joins, query.tables, joinIndex, identifiers, effectiveInnerJoinIds),
    ...collectConditionReasons(query, 'where', identifiers),
    ...collectConditionReasons(query, 'having', identifiers),
  ]);
}

export function analyzeEffectiveInnerJoins(query: ParsedQuery): EffectiveInnerAnalysis[] {
  const results: EffectiveInnerAnalysis[] = [];
  const effectiveInnerJoinIds = new Set<string>();

  // 後ろの結合から順に調べる。ある外部結合が実質 INNER JOIN かどうかは、それより後ろの結合で決まる
  for (let joinIndex = query.joins.length - 1; joinIndex >= 0; joinIndex--) {
    const join = query.joins[joinIndex]!;
    if (!isOuterJoinWithNullableSide(join.type)) continue;

    const sideTables = nullableSideTables(join, query.tables);
    if (sideTables.length === 0) continue;

    const reasons: EffectiveInnerReason[] = [];
    const nullableTableIds: string[] = [];

    for (const nullableTable of sideTables) {
      const tableReasons = reasonsForNullableTable(query, joinIndex, nullableTable, effectiveInnerJoinIds);
      if (tableReasons.length === 0) continue;
      nullableTableIds.push(nullableTable.id);
      reasons.push(...tableReasons);
    }

    if (reasons.length > 0) {
      effectiveInnerJoinIds.add(join.id);
      results.push({
        joinId: join.id,
        reasons: dedupeReasons(reasons),
        nullableTableIds,
      });
    }
  }

  // 呼び出し元には、結合の順に返す
  return results.reverse();
}

export function formatEffectiveInnerCausePhrase(reasons: EffectiveInnerReason[]): string {
  const innerReasons = reasons.filter((r) => r.kind === 'inner_join');
  if (innerReasons.length > 0) {
    if (innerReasons.every((r) => r.viaEffectiveInner)) return '後続の実質 INNER JOIN により';
    const types = innerReasons.map((r) => r.joinType ?? 'INNER JOIN');
    const only = types[0];
    if (only && types.every((t) => t === only)) {
      if (only === 'STRAIGHT JOIN') return '後続の STRAIGHT JOIN により';
      if (only === 'CROSS JOIN') return '後続の CROSS JOIN により';
    }
    return '後続の INNER JOIN により';
  }
  const parts: string[] = [];
  if (reasons.some((r) => r.kind === 'where')) parts.push('WHERE');
  if (reasons.some((r) => r.kind === 'having')) parts.push('HAVING');
  if (parts.length === 0) return '後続条件により';
  if (parts.length === 1) return `${parts[0]!} により`;
  return `${parts.join(' / ')} により`;
}

export function formatEffectiveInnerJoinScopeLine(
  join: JoinEdge,
  preservedLabel: string,
  nullableTable: TableRef,
  reasons: EffectiveInnerReason[],
): string {
  const nullableLabel = tableDisplayLabel(nullableTable);
  const cause = formatEffectiveInnerCausePhrase(reasons);
  return `${preservedLabel} と ${nullableLabel} は実質 INNER JOIN — 結合条件「${joinConditionDisplayText(join.condition)}」を満たす組み合わせのみ残る。SQL 上は ${join.type}（${nullableLabel} が無い行も ${preservedLabel} は残る）だが、${cause} ${nullableLabel} が無い行も除外される`;
}

export function effectiveInnerAnalysisByJoinId(
  query: ParsedQuery,
): Map<string, EffectiveInnerAnalysis> {
  return new Map(analyzeEffectiveInnerJoins(query).map((analysis) => [analysis.joinId, analysis]));
}

export interface NormalizeEffectiveInnerOptions {
  /**
   * HAVING 理由を正規化判定から除外する。
   * 結果セット比較向け: 集約条件（例: COUNT(右表列) >= 0）の過検出で INNER 同等と誤らないため。
   */
  ignoreHavingReasons?: boolean;
}

function analysesForNormalization(
  query: ParsedQuery,
  options?: NormalizeEffectiveInnerOptions,
): EffectiveInnerAnalysis[] {
  const analyses = analyzeEffectiveInnerJoins(query);
  if (!options?.ignoreHavingReasons) return analyses;
  return analyses
    .map((analysis) => ({
      ...analysis,
      reasons: analysis.reasons.filter((reason) => reason.kind !== 'having'),
    }))
    .filter((analysis) => analysis.reasons.length > 0);
}

/** 実質 INNER JOIN と判定された外部結合を INNER JOIN として比較用に正規化する（CTE・派生・UNION 内も再帰） */
export function normalizeEffectiveInnerJoins(
  query: ParsedQuery,
  options?: NormalizeEffectiveInnerOptions,
): ParsedQuery {
  // INNER にした結合が、さらに前の外部結合を実質 INNER にすることがある。
  // `a LEFT JOIN b … LEFT JOIN c ON c.bid = b.id WHERE c.x = 1` は、c が INNER になると
  // `ON c.bid = b.id` が b の未結合行を落とすので b も INNER になる。変わらなくなるまで繰り返す
  let joins = query.joins;
  for (let round = 0; round <= query.joins.length; round += 1) {
    const effective = new Set(
      analysesForNormalization({ ...query, joins }, options).map((analysis) => analysis.joinId),
    );
    if (effective.size === 0) break;
    joins = joins.map((join) => (effective.has(join.id) ? { ...join, type: 'INNER JOIN' } : join));
  }
  return {
    ...query,
    joins,
    tables: query.tables.map((table) =>
      table.derivedQuery
        ? {
            ...table,
            derivedQuery: normalizeEffectiveInnerJoins(table.derivedQuery, options),
          }
        : table,
    ),
    ctes: query.ctes?.map((cte) => ({
      ...cte,
      query: normalizeEffectiveInnerJoins(cte.query, options),
    })),
    unionBranches: query.unionBranches?.map((branch) => ({
      ...branch,
      query: normalizeEffectiveInnerJoins(branch.query, options),
    })),
    embeddedSubqueries: query.embeddedSubqueries?.map((sub) =>
      normalizeEffectiveInnerJoins(sub, options),
    ),
  };
}
