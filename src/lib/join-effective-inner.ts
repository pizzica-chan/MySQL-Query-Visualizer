import type { ConditionNode, JoinEdge, JoinType, ParsedQuery, TableRef } from './types';
import { resolveJoinConditionExpression } from './join-condition';

export interface EffectiveInnerReason {
  kind: 'inner_join' | 'where' | 'having';
  label: string;
}

export interface EffectiveInnerAnalysis {
  joinId: string;
  reasons: EffectiveInnerReason[];
  /** 実質 INNER 判定の根拠となった nullable 側テーブル id（RIGHT JOIN は左側の複数可） */
  nullableTableIds: string[];
}

const NULL_REJECTING_CONDITION_TYPES = new Set<ConditionNode['type']>([
  'comparison',
  'between',
  'in',
  'like',
  'function',
  'exists',
  'subquery',
  'raw',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableIdentifiers(table: TableRef): string[] {
  const ids = [table.alias, table.table, table.displayName].filter(Boolean) as string[];
  return [...new Set(ids)];
}

function expressionReferencesTable(expr: string, table: TableRef): boolean {
  if (!expr) return false;
  return tableIdentifiers(table).some((id) => {
    const pattern = new RegExp(`\\b${escapeRegex(id)}\\.`, 'i');
    return pattern.test(expr);
  });
}

function isInnerJoinType(type: JoinType): boolean {
  return type === 'INNER JOIN' || type === 'JOIN';
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
  return `INNER JOIN ${name}`;
}

function isNullPreservingCondition(node: ConditionNode): boolean {
  if (node.type !== 'is_null') return false;
  const upper = node.label.toUpperCase();
  return upper.includes(' IS NULL') && !upper.includes(' IS NOT NULL');
}

/** IFNULL / COALESCE / NVL の引数範囲（開き括弧の直後〜閉じ括弧直前） */
function findNullCoalescingArgSpans(expr: string): Array<{ start: number; end: number }> {
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

function tableRefStartPositions(expr: string, table: TableRef): number[] {
  const positions: number[] = [];
  for (const id of tableIdentifiers(table)) {
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
  table: TableRef,
): boolean {
  if (!expressionReferencesTable(expr, table)) return false;
  const spans = findNullCoalescingArgSpans(expr);
  if (spans.length === 0) return false;
  const refs = tableRefStartPositions(expr, table);
  if (refs.length === 0) return false;
  return refs.every((pos) => spans.some((span) => pos >= span.start && pos < span.end));
}

function isNullRejectingLeaf(node: ConditionNode, nullableTable: TableRef): boolean {
  if (isNullPreservingCondition(node)) return false;
  if (!NULL_REJECTING_CONDITION_TYPES.has(node.type)) return false;

  const exprs = [node.left, node.label].filter((e): e is string => !!e);
  if (!exprs.some((e) => expressionReferencesTable(e, nullableTable))) return false;

  // 参照が NULL 置換関数の引数にしか無いときは未結合行を残しうる（過検出回避）
  const coalescedOnly = exprs.every(
    (e) =>
      !expressionReferencesTable(e, nullableTable) ||
      expressionOnlyReferencesTableViaNullCoalescing(e, nullableTable),
  );
  if (coalescedOnly) return false;

  return true;
}

function collectConditionReasons(
  node: ConditionNode | undefined,
  kind: 'where' | 'having',
  nullableTable: TableRef,
  underOr: boolean,
): EffectiveInnerReason[] {
  if (!node) return [];

  if (node.type === 'or') {
    return (node.children ?? []).flatMap((child) =>
      collectConditionReasons(child, kind, nullableTable, true),
    );
  }

  if (node.type === 'and') {
    return (node.children ?? []).flatMap((child) =>
      collectConditionReasons(child, kind, nullableTable, underOr),
    );
  }

  if (node.type === 'not') {
    return (node.children ?? []).flatMap((child) =>
      collectConditionReasons(child, kind, nullableTable, underOr),
    );
  }

  if (underOr || !isNullRejectingLeaf(node, nullableTable)) return [];

  const prefix = kind === 'where' ? 'WHERE' : 'HAVING';
  return [{ kind, label: `${prefix}: ${node.label}` }];
}

function findSubsequentInnerJoinReasons(
  joins: JoinEdge[],
  tables: TableRef[],
  joinIndex: number,
  nullableTable: TableRef,
): EffectiveInnerReason[] {
  const reasons: EffectiveInnerReason[] = [];

  for (let i = joinIndex + 1; i < joins.length; i++) {
    const join = joins[i]!;
    if (!isInnerJoinType(join.type)) continue;
    if (!expressionReferencesTable(resolveJoinConditionExpression(join), nullableTable)) continue;
    reasons.push({
      kind: 'inner_join',
      label: innerJoinReasonLabel(join, tables),
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
  return dedupeReasons([
    ...findSubsequentInnerJoinReasons(query.joins, query.tables, joinIndex, nullableTable),
    ...collectConditionReasons(query.where, 'where', nullableTable, false),
    ...collectConditionReasons(query.having, 'having', nullableTable, false),
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
  if (reasons.some((r) => r.kind === 'inner_join')) {
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
  return `${preservedLabel} と ${nullableLabel}は実質 INNER JOIN — 結合条件「${join.condition}」を満たす組み合わせのみ残る。SQL上は ${join.type}（${nullableLabel}が無い行も${preservedLabel}は残る）だが、${cause}${nullableLabel}が無い行も除外される`;
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
  const effectiveByJoinId = new Map(
    analysesForNormalization(query, options).map((analysis) => [analysis.joinId, analysis]),
  );
  return {
    ...query,
    joins:
      effectiveByJoinId.size === 0
        ? query.joins
        : query.joins.map((join) =>
            effectiveByJoinId.has(join.id) ? { ...join, type: 'INNER JOIN' } : join,
          ),
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
  };
}
