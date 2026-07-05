export type JoinType =
  | 'INNER JOIN'
  | 'LEFT JOIN'
  | 'RIGHT JOIN'
  | 'FULL JOIN'
  | 'CROSS JOIN'
  | 'JOIN';

export interface TableRef {
  id: string;
  schema?: string;
  table: string;
  alias?: string;
  displayName: string;
  /** FROM句の派生テーブル `(SELECT ...) AS t` */
  isDerived?: boolean;
  derivedQuery?: ParsedQuery;
}

export interface UnionBranch {
  id: string;
  /** 先頭ブランチは undefined */
  operator?: string;
  query: ParsedQuery;
}

export interface JoinEdge {
  id: string;
  type: JoinType;
  sourceId: string;
  targetId: string;
  condition: string;
  conditionParts?: { left: string; operator: string; right: string };
}

export type ConditionNodeType =
  | 'and'
  | 'or'
  | 'not'
  | 'comparison'
  | 'in'
  | 'between'
  | 'like'
  | 'is_null'
  | 'exists'
  | 'subquery'
  | 'function'
  | 'raw';

export interface ConditionNode {
  id: string;
  type: ConditionNodeType;
  label: string;
  operator?: string;
  left?: string;
  right?: string;
  children?: ConditionNode[];
  highlight?: boolean;
  /** IN / EXISTS / 比較式内のサブクエリ */
  nestedQuery?: ParsedQuery;
}

export interface SelectColumn {
  expression: string;
  alias?: string;
}

export interface SetClause {
  column: string;
  table?: string;
  value: string;
  label: string;
}

export interface DeleteTarget {
  name: string;
  label: string;
}

export interface ParsedQuery {
  rawSql: string;
  statementType: 'SELECT' | 'UPDATE' | 'DELETE';
  tables: TableRef[];
  joins: JoinEdge[];
  where?: ConditionNode;
  having?: ConditionNode;
  columns: SelectColumn[];
  setClauses?: SetClause[];
  deleteTargets?: DeleteTarget[];
  groupBy: string[];
  orderBy: string[];
  limit?: string;
  distinct: boolean;
  /** UNION / UNION ALL 等の各ブランチ（2本以上のとき） */
  unionBranches?: UnionBranch[];
}

export interface ParseError {
  message: string;
  position?: number;
}

export type ParseResult =
  | { success: true; query: ParsedQuery }
  | { success: false; error: ParseError };
