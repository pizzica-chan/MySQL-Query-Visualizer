import type { ConditionNode, JoinEdge, JoinType, ParsedQuery, TableRef } from './types';
import { NO_JOIN_CONDITION, joinConditionDisplayText } from './join-condition';
import { maskNonCode } from './sql-lex';

export interface EffectiveInnerReason {
  kind: 'inner_join' | 'where' | 'having';
  label: string;
  /** kind === 'inner_join' のときの結合種別 */
  joinType?: JoinType;
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
 * 例: `ISNULL(o.x)`、`CASE WHEN o.x IS NULL THEN 1 ELSE 0 END = 1`、`a.x IN (o.y, 1)`、`o.x <=> NULL`。
 * IFNULL / COALESCE / NVL は引数の位置まで見て別に判定する（expressionOnlyReferencesTableViaNullCoalescing）。
 */
const NULL_SWALLOWING_RE =
  /\b(?:isnull|if|nullif|concat_ws|field|elt|interval|make_set|export_set|char|json_\w+)\s*\(|\b(?:case|exists|select|is|in|or|xor|and)\b|<=>|\|\||&&/i;

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
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
}

function innerJoinReasonLabel(join: JoinEdge, tables: TableRef[]): string {
  const target = tables.find((t) => t.id === join.targetId);
  const name = target ? tableDisplayLabel(target) : join.targetId;
  const typeLabel = join.type === 'JOIN' ? 'INNER JOIN' : join.type;
  return `${typeLabel} ${name}`;
}

/** IFNULL / COALESCE / NVL の引数範囲（開き括弧の直後〜閉じ括弧直前） */
function findNullCoalescingArgSpans(rawExpr: string): Array<{ start: number; end: number }> {
  const expr = maskExprLiterals(rawExpr);
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\b(?:ifnull|coalesce|nvl)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(expr)) !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParen + 1;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    while (i < expr.length && depth > 0) {
      const ch = expr[i]!;
      if (inSingle) {
        if (ch === "'" && expr[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (ch === "'") inSingle = false;
        i++;
        continue;
      }
      if (inDouble) {
        if (ch === '"' && expr[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (ch === '"') inDouble = false;
        i++;
        continue;
      }
      if (inBacktick) {
        if (ch === '`') inBacktick = false;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i++;
        continue;
      }
      if (ch === '`') {
        inBacktick = true;
        i++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) {
      spans.push({ start: openParen + 1, end: i - 1 });
    }
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
 * nullable 側への参照がすべて IFNULL / COALESCE / NVL の引数内にあるか。
 * 例: IFNULL(o.total, 0) = 0 は未結合行（NULL→0）が残りうるため実質 INNER にしない。
 */
function expressionOnlyReferencesTableViaNullCoalescing(
  expr: string,
  identifiers: string[],
): boolean {
  if (!expressionReferencesTable(expr, identifiers)) return false;
  const spans = findNullCoalescingArgSpans(expr);
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
  // 参照が NULL 置換関数の引数にしか無いときは未結合行を残しうる（過検出回避）
  if (expressionOnlyReferencesTableViaNullCoalescing(expr, identifiers)) return false;
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
        // 未結合行で真にならないのは `x IS NOT NULL` だけ。IS NULL / IS NOT TRUE / IS UNKNOWN は真になる
        return (
          !negated &&
          operator === 'IS NOT' &&
          /^null$/i.test((node.right ?? '').trim()) &&
          expressionPropagatesNull(node.left, identifiers)
        );
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
    default:
      // is_null（IS NULL / IS TRUE など）と exists は根拠にしない
      return false;
  }
}

/**
 * 条件木から「未結合行では決して真にならない」葉を集める。
 * OR の枝は、もう一方の枝が真なら行が残るので根拠にしない。
 * NOT の内側では AND と OR が入れ替わる（`NOT (A AND B)` は `NOT A OR NOT B`）。
 */
function collectNullRejectingLeaves(
  node: ConditionNode | undefined,
  identifiers: string[],
  underOr = false,
  negated = false,
): ConditionNode[] {
  if (!node) return [];

  if (node.type === 'not') {
    return (node.children ?? []).flatMap((child) =>
      collectNullRejectingLeaves(child, identifiers, underOr, !negated),
    );
  }

  if (node.type === 'and' || node.type === 'or') {
    const actsAsOr = (node.type === 'or') !== negated;
    return (node.children ?? []).flatMap((child) =>
      collectNullRejectingLeaves(child, identifiers, underOr || actsAsOr, negated),
    );
  }

  if (underOr || !isNullRejectingLeaf(node, identifiers, negated)) return [];
  return [node];
}

function collectConditionReasons(
  node: ConditionNode | undefined,
  kind: 'where' | 'having',
  identifiers: string[],
): EffectiveInnerReason[] {
  const prefix = kind === 'where' ? 'WHERE' : 'HAVING';
  return collectNullRejectingLeaves(node, identifiers).map((leaf) => ({
    kind,
    label: `${prefix}: ${leaf.label}`,
  }));
}

function findSubsequentInnerJoinReasons(
  joins: JoinEdge[],
  tables: TableRef[],
  joinIndex: number,
  identifiers: string[],
): EffectiveInnerReason[] {
  const reasons: EffectiveInnerReason[] = [];

  for (let i = joinIndex + 1; i < joins.length; i++) {
    const join = joins[i]!;
    if (!isInnerLikeJoin(join)) continue;
    // ON に nullable 側の列が出てくるだけでは足りない。`ON p.id = o.pid OR p.aid = a.id` や
    // `ON p.id = COALESCE(o.pid, a.pid)` は未結合行でも成り立つので、WHERE と同じ基準で葉を調べる
    const root = join.layoutConditionRoot ?? join.conditionRoot;
    if (collectNullRejectingLeaves(root, identifiers).length === 0) continue;
    reasons.push({
      kind: 'inner_join',
      label: innerJoinReasonLabel(join, tables),
      joinType: join.type,
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
): EffectiveInnerReason[] {
  const identifiers = tableReferenceIdentifiers(nullableTable, query.tables);
  if (identifiers.length === 0) return [];

  return dedupeReasons([
    ...findSubsequentInnerJoinReasons(query.joins, query.tables, joinIndex, identifiers),
    ...collectConditionReasons(query.where, 'where', identifiers),
    ...collectConditionReasons(query.having, 'having', identifiers),
  ]);
}

export function analyzeEffectiveInnerJoins(query: ParsedQuery): EffectiveInnerAnalysis[] {
  const results: EffectiveInnerAnalysis[] = [];

  query.joins.forEach((join, joinIndex) => {
    if (!isOuterJoinWithNullableSide(join.type)) return;

    const sideTables = nullableSideTables(join, query.tables);
    if (sideTables.length === 0) return;

    const reasons: EffectiveInnerReason[] = [];
    const nullableTableIds: string[] = [];

    for (const nullableTable of sideTables) {
      const tableReasons = reasonsForNullableTable(query, joinIndex, nullableTable);
      if (tableReasons.length === 0) continue;
      nullableTableIds.push(nullableTable.id);
      reasons.push(...tableReasons);
    }

    if (reasons.length > 0) {
      results.push({
        joinId: join.id,
        reasons: dedupeReasons(reasons),
        nullableTableIds,
      });
    }
  });

  return results;
}

export function formatEffectiveInnerCausePhrase(reasons: EffectiveInnerReason[]): string {
  const innerReasons = reasons.filter((r) => r.kind === 'inner_join');
  if (innerReasons.length > 0) {
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
  return `${preservedLabel} と ${nullableLabel}は実質 INNER JOIN — 結合条件「${joinConditionDisplayText(join.condition)}」を満たす組み合わせのみ残る。SQL上は ${join.type}（${nullableLabel}が無い行も${preservedLabel}は残る）だが、${cause}${nullableLabel}が無い行も除外される`;
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
