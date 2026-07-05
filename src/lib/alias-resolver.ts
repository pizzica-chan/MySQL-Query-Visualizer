import type { ConditionNode, JoinEdge, ParsedQuery, SetClause, DeleteTarget, TableRef } from './types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildAliasMap(tables: TableRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tables) {
    if (!t.alias || t.isDerived) continue;
    const physical = t.schema ? `${t.schema}.${t.table}` : t.table;
    map.set(t.alias, physical);
  }
  return map;
}

export function resolveAliasesInText(text: string, aliasMap: Map<string, string>): string {
  if (!text || aliasMap.size === 0) return text;

  let result = text;
  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const tableName = aliasMap.get(alias)!;
    const qualified = new RegExp(`(?<![\\w.])${escapeRegExp(alias)}\\.`, 'g');
    result = result.replace(qualified, `${tableName}.`);
  }

  return result;
}

function resolveStandaloneAlias(name: string, aliasMap: Map<string, string>): string {
  return aliasMap.get(name) ?? name;
}

function resolveConditionNode(node: ConditionNode, aliasMap: Map<string, string>): ConditionNode {
  return {
    ...node,
    label: resolveAliasesInText(node.label, aliasMap),
    left: node.left ? resolveAliasesInText(node.left, aliasMap) : undefined,
    right: node.right ? resolveAliasesInText(node.right, aliasMap) : undefined,
    children: node.children?.map((child) => resolveConditionNode(child, aliasMap)),
    nestedQuery: node.nestedQuery
      ? applyAliasResolution(node.nestedQuery, true)
      : undefined,
  };
}

function resolveTableRef(table: TableRef): TableRef {
  const displayName = table.isDerived
    ? table.displayName
    : table.schema
      ? `${table.schema}.${table.table}`
      : table.table;
  return {
    ...table,
    displayName,
    derivedQuery: table.derivedQuery
      ? applyAliasResolution(table.derivedQuery, true)
      : undefined,
  };
}

function resolveJoin(join: JoinEdge, aliasMap: Map<string, string>): JoinEdge {
  return {
    ...join,
    layoutCondition: join.layoutCondition ?? join.condition,
    layoutConditionParts: join.layoutConditionParts ?? join.conditionParts,
    layoutConditionRoot: join.layoutConditionRoot ?? join.conditionRoot,
    condition: resolveAliasesInText(join.condition, aliasMap),
    conditionParts: join.conditionParts
      ? {
          left: resolveAliasesInText(join.conditionParts.left, aliasMap),
          operator: join.conditionParts.operator,
          right: resolveAliasesInText(join.conditionParts.right, aliasMap),
        }
      : undefined,
    conditionRoot: join.conditionRoot
      ? resolveConditionNode(join.conditionRoot, aliasMap)
      : undefined,
  };
}

function resolveSetClause(set: SetClause, aliasMap: Map<string, string>): SetClause {
  return {
    ...set,
    label: resolveAliasesInText(set.label, aliasMap),
    table: set.table ? resolveStandaloneAlias(set.table, aliasMap) : undefined,
  };
}

function resolveDeleteTarget(target: DeleteTarget, aliasMap: Map<string, string>): DeleteTarget {
  const resolvedName = resolveStandaloneAlias(target.name, aliasMap);
  return {
    name: resolvedName,
    label: resolvedName,
  };
}

/** 解析結果の表示用にエイリアスを実テーブル名へ置換する */
export function applyAliasResolution(query: ParsedQuery, enabled: boolean): ParsedQuery {
  if (!enabled) return query;

  const aliasMap = buildAliasMap(query.tables);

  return {
    ...query,
    tables: query.tables.map(resolveTableRef),
    joins: query.joins.map((j) => resolveJoin(j, aliasMap)),
    where: query.where ? resolveConditionNode(query.where, aliasMap) : undefined,
    having: query.having ? resolveConditionNode(query.having, aliasMap) : undefined,
    columns: query.columns.map((col) => ({
      ...col,
      expression: resolveAliasesInText(col.expression, aliasMap),
    })),
    setClauses: query.setClauses?.map((s) => resolveSetClause(s, aliasMap)),
    deleteTargets: query.deleteTargets?.map((d) => resolveDeleteTarget(d, aliasMap)),
    groupBy: query.groupBy.map((g) => ({
      ...g,
      text: resolveAliasesInText(g.text, aliasMap),
    })),
    orderBy: query.orderBy.map((o) => ({
      ...o,
      text: resolveAliasesInText(o.text, aliasMap),
    })),
    unionBranches: query.unionBranches?.map((branch) => ({
      ...branch,
      query: applyAliasResolution(branch.query, true),
    })),
  };
}

export function formatTableLabel(table: TableRef, resolved: boolean): { primary: string; aliasNote?: string } {
  if (table.isDerived) {
    return { primary: table.displayName, aliasNote: table.alias };
  }
  if (!resolved || !table.alias) {
    return { primary: table.displayName };
  }
  const primary = table.schema ? `${table.schema}.${table.table}` : table.table;
  return { primary, aliasNote: table.alias };
}
