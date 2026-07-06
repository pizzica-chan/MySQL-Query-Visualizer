import type { ConditionNode, JoinEdge, JoinType, ParsedQuery, TableRef } from './types';
import { resolveJoinConditionExpression } from './join-condition';

export interface EffectiveInnerReason {
  kind: 'inner_join' | 'where' | 'having';
  label: string;
}

export interface EffectiveInnerAnalysis {
  joinId: string;
  reasons: EffectiveInnerReason[];
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

function nullableTableId(join: JoinEdge): string | null {
  if (join.type === 'LEFT JOIN') return join.targetId;
  if (join.type === 'RIGHT JOIN') return join.sourceId;
  return null;
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

function isNullRejectingLeaf(node: ConditionNode, nullableTable: TableRef): boolean {
  if (isNullPreservingCondition(node)) return false;
  if (!NULL_REJECTING_CONDITION_TYPES.has(node.type)) return false;

  const expr = node.left ?? node.label;
  return expressionReferencesTable(expr, nullableTable) || expressionReferencesTable(node.label, nullableTable);
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

export function analyzeEffectiveInnerJoins(query: ParsedQuery): EffectiveInnerAnalysis[] {
  const results: EffectiveInnerAnalysis[] = [];

  query.joins.forEach((join, joinIndex) => {
    if (!isOuterJoinWithNullableSide(join.type)) return;

    const nullableId = nullableTableId(join);
    if (!nullableId) return;

    const nullableTable = query.tables.find((t) => t.id === nullableId);
    if (!nullableTable) return;

    const reasons = dedupeReasons([
      ...findSubsequentInnerJoinReasons(query.joins, query.tables, joinIndex, nullableTable),
      ...collectConditionReasons(query.where, 'where', nullableTable, false),
      ...collectConditionReasons(query.having, 'having', nullableTable, false),
    ]);

    if (reasons.length > 0) {
      results.push({ joinId: join.id, reasons });
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
