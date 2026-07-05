/* eslint-disable @typescript-eslint/no-explicit-any */
import { Parser } from 'node-sql-parser';
import type {
  ConditionNode,
  JoinEdge,
  JoinType,
  ParseResult,
  ParsedQuery,
  SelectColumn,
  SetClause,
  DeleteTarget,
  TableRef,
} from './types';

const parser = new Parser();

let nodeCounter = 0;
function nextId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter}`;
}

function resetIds(): void {
  nodeCounter = 0;
}

function formatIdentifier(name: string | undefined): string {
  if (!name) return '';
  return name;
}

function formatTableName(db: string | undefined, table: string): string {
  if (db) return `${db}.${table}`;
  return table;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveFunctionName(nameField: unknown): string {
  if (typeof nameField === 'string') return nameField.toUpperCase();
  if (!nameField || typeof nameField !== 'object') return '';

  const inner = (nameField as { name?: unknown }).name;

  if (typeof inner === 'string') return inner.toUpperCase();

  if (Array.isArray(inner)) {
    return inner
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'value' in item) {
          return String((item as { value: unknown }).value);
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
  }

  return '';
}

function extractFunctionArgs(node: any): any[] {
  const raw = node.args?.value ?? node.args;
  if (raw?.type === 'expr_list') return toArray(raw.value);
  return toArray(raw);
}

function exprToString(node: any): string {
  if (!node) return '';

  switch (node.type) {
    case 'column_ref': {
      const parts: string[] = [];
      if (node.table) parts.push(formatIdentifier(node.table));
      if (node.column) parts.push(formatIdentifier(node.column));
      return parts.join('.') || '*';
    }
    case 'number':
    case 'bool':
    case 'single_quote_string':
    case 'double_quote_string':
      return String(node.value);
    case 'null':
      return 'NULL';
    case 'star':
      return node.table ? `${node.table}.*` : '*';
    case 'expr_list':
      return toArray(node.value)
        .map((a: any) => exprToString(a))
        .join(', ');
    case 'binary_expr':
      return `${exprToString(node.left)} ${node.operator} ${exprToString(node.right)}`;
    case 'unary_expr':
      return `${node.operator} ${exprToString(node.expr)}`;
    case 'function': {
      const fnName = resolveFunctionName(node.name);
      const args = extractFunctionArgs(node)
        .map((a: any) => exprToString(a))
        .join(', ');
      return `${fnName}(${args})`;
    }
    case 'aggr_func': {
      const rawArgs = node.args?.expr ?? node.args?.value ?? node.args;
      const args = toArray<any>(rawArgs)
        .map((a: any) => exprToString(a))
        .join(', ');
      return `${node.name}(${args})`;
    }
    case 'case': {
      const whens = (node.args ?? [])
        .map((w: any) => `WHEN ${exprToString(w.condition)} THEN ${exprToString(w.result)}`)
        .join(' ');
      const elsePart = node['else'] ? ` ELSE ${exprToString(node['else'])}` : '';
      return `CASE ${whens}${elsePart} END`;
    }
    case 'cast': {
      return `CAST(${exprToString(node.expr)} AS ${node.target?.dataType ?? ''})`;
    }
    case 'subquery': {
      const inner = node.subquery?.ast ?? node.subquery ?? node.ast;
      if (inner?.type === 'select') {
        return summarizeSelect(inner);
      }
      return '(subquery)';
    }
    default:
      if (node.value !== undefined) return String(node.value);
      if (node.raw) return node.raw;
      return JSON.stringify(node);
  }
}

function extractSubquerySelectAst(node: any): any | null {
  if (!node) return null;
  if (node.type === 'subquery') {
    const inner = node.subquery?.ast ?? node.subquery;
    return inner?.type === 'select' ? inner : null;
  }
  if (node.ast?.type === 'select') return node.ast;
  if (node.type === 'select') return node;
  if (node.type === 'expr_list') {
    for (const item of toArray<any>(node.value)) {
      const found = extractSubquerySelectAst(item);
      if (found) return found;
    }
  }
  return null;
}

function summarizeSelect(ast: any): string {
  const from = toArray<any>(ast.from);
  const first = from[0];
  if (first?.expr?.ast?.type === 'select') {
    const alias = first.as ?? 'derived';
    return `(SELECT ... AS ${alias})`;
  }
  const table = first?.table ?? '?';
  const cols = toArray<any>(ast.columns).length;
  return `(SELECT ${cols}列 FROM ${table})`;
}

function normalizeSetOp(op: string | undefined): string {
  if (!op) return 'UNION';
  return op.replace(/\s+/g, ' ').trim().toUpperCase();
}

function collectUnionBranches(root: any): Array<{ ast: any; unionOp?: string }> {
  const branches: Array<{ ast: any; unionOp?: string }> = [{ ast: root }];
  let node = root;
  while (node._next) {
    branches.push({ ast: node._next, unionOp: normalizeSetOp(node.set_op) });
    node = node._next;
  }
  return branches;
}

function normalizeJoinType(join: string | undefined): JoinType {
  if (!join) return 'INNER JOIN';
  const upper = join.toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper.includes('LEFT')) return 'LEFT JOIN';
  if (upper.includes('RIGHT')) return 'RIGHT JOIN';
  if (upper.includes('FULL')) return 'FULL JOIN';
  if (upper.includes('CROSS')) return 'CROSS JOIN';
  if (upper === 'JOIN') return 'JOIN';
  return 'INNER JOIN';
}

function parseComparison(node: any): ConditionNode {
  const left = exprToString(node.left);
  const right = exprToString(node.right);
  return {
    id: nextId('cond'),
    type: 'comparison',
    label: `${left} ${node.operator} ${right}`,
    operator: node.operator,
    left,
    right,
  };
}

function parseComparisonWithSubquery(node: any): ConditionNode {
  const left = exprToString(node.left);
  const subAst = extractSubquerySelectAst(node.right);
  if (subAst) {
    return {
      id: nextId('cond'),
      type: 'subquery',
      label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
      operator: node.operator,
      left,
      nestedQuery: buildSelectParsed(subAst),
    };
  }
  return parseComparison(node);
}

function parseConditionTree(node: any): ConditionNode | undefined {
  if (!node) return undefined;

  switch (node.type) {
    case 'binary_expr': {
      const op = node.operator?.toUpperCase?.() ?? node.operator;

      if (op === 'AND' || op === 'OR') {
        const children: ConditionNode[] = [];
        const left = parseConditionTree(node.left);
        const right = parseConditionTree(node.right);
        if (left) children.push(left);
        if (right) children.push(right);
        return {
          id: nextId('cond'),
          type: op === 'AND' ? 'and' : 'or',
          label: op,
          operator: op,
          children,
        };
      }

      if (op === 'IS') {
        const left = exprToString(node.left);
        const right = exprToString(node.right);
        return {
          id: nextId('cond'),
          type: 'is_null',
          label: `${left} IS ${right}`,
          left,
          right,
        };
      }

      if (op === 'IN' || op === 'NOT IN') {
        const left = exprToString(node.left);
        const subAst = extractSubquerySelectAst(node.right);
        if (subAst) {
          return {
            id: nextId('cond'),
            type: 'in',
            label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
            operator: node.operator,
            left,
            nestedQuery: buildSelectParsed(subAst),
          };
        }
        const values =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a)).join(', ')
            : exprToString(node.right);
        return {
          id: nextId('cond'),
          type: 'in',
          label: `${left} ${node.operator} (${values})`,
          operator: node.operator,
          left,
          right: values,
        };
      }

      if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        const left = exprToString(node.left);
        const [low, high] =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a))
            : [exprToString(node.right), ''];
        return {
          id: nextId('cond'),
          type: 'between',
          label: `${left} ${node.operator} ${low} AND ${high}`,
          operator: node.operator,
          left,
          right: `${low} AND ${high}`,
        };
      }

      return parseComparisonWithSubquery(node);
    }

    case 'subquery': {
      const subAst = extractSubquerySelectAst(node);
      return {
        id: nextId('cond'),
        type: 'subquery',
        label: summarizeSelect(subAst ?? node),
        nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
      };
    }

    case 'unary_expr': {
      const op = (node.operator?.toUpperCase?.() ?? node.operator ?? '').replace(/\s+/g, ' ').trim();

      if (op === 'NOT EXISTS' || op === 'EXISTS') {
        const subAst = extractSubquerySelectAst(node.expr);
        return {
          id: nextId('cond'),
          type: 'exists',
          label: subAst ? `${op} ${summarizeSelect(subAst)}` : `${op} (subquery)`,
          nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
        };
      }

      if (op === 'NOT') {
        const child = parseConditionTree(node.expr);
        return {
          id: nextId('cond'),
          type: 'not',
          label: 'NOT',
          operator: 'NOT',
          children: child ? [child] : [],
        };
      }
      return {
        id: nextId('cond'),
        type: 'raw',
        label: exprToString(node),
      };
    }

    case 'function': {
      const name = resolveFunctionName(node.name);
      const args = extractFunctionArgs(node);

      if (name === 'NOT') {
        const child = args[0] ? parseConditionTree(args[0]) : undefined;
        return {
          id: nextId('cond'),
          type: 'not',
          label: 'NOT',
          operator: 'NOT',
          children: child ? [child] : [],
        };
      }

      if (name === 'IN') {
        const left = exprToString(args[0]);
        const values = args.slice(1).map((a: any) => exprToString(a)).join(', ');
        return {
          id: nextId('cond'),
          type: 'in',
          label: `${left} IN (${values})`,
          left,
          right: values,
        };
      }

      if (name === 'EXISTS') {
        const subAst = extractSubquerySelectAst(args[0]);
        return {
          id: nextId('cond'),
          type: 'exists',
          label: subAst ? `EXISTS ${summarizeSelect(subAst)}` : 'EXISTS (subquery)',
          nestedQuery: subAst ? buildSelectParsed(subAst) : undefined,
        };
      }

      if (name === 'BETWEEN') {
        const expr = exprToString(args[0]);
        const low = exprToString(args[1]);
        const high = exprToString(args[2]);
        return {
          id: nextId('cond'),
          type: 'between',
          label: `${expr} BETWEEN ${low} AND ${high}`,
          left: expr,
          right: `${low} AND ${high}`,
        };
      }

      return {
        id: nextId('cond'),
        type: 'function',
        label: exprToString(node),
      };
    }

    default:
      return {
        id: nextId('cond'),
        type: 'raw',
        label: exprToString(node),
      };
  }
}

function enrichConditionTree(node: ConditionNode): ConditionNode {
  if (node.type === 'comparison' && node.operator?.toUpperCase() === 'LIKE') {
    return { ...node, type: 'like' };
  }
  if (node.children) {
    return { ...node, children: node.children.map(enrichConditionTree) };
  }
  return node;
}

function parseColumns(columns: any[]): SelectColumn[] {
  if (!columns || columns.length === 0) return [{ expression: '*' }];

  return columns.map((col) => {
    if (col === '*' || col.expr?.type === 'star') {
      return { expression: col.expr?.table ? `${col.expr.table}.*` : '*' };
    }
    const expr = col.expr ? exprToString(col.expr) : exprToString(col);
    const alias = col.as ?? col.alias;
    return { expression: expr, alias: alias || undefined };
  });
}

function buildTableRef(entry: any, index: number): TableRef {
  if (entry.expr?.ast?.type === 'select') {
    const alias = entry.as ?? entry.alias ?? `derived_${index}`;
    const derivedQuery = buildSelectParsed(entry.expr.ast);
    return {
      id: nextId('tbl'),
      table: alias,
      alias,
      displayName: `${alias} (派生テーブル)`,
      isDerived: true,
      derivedQuery,
    };
  }

  const table = entry.table ?? entry.name ?? `table_${index}`;
  const schema = entry.db ?? entry.schema;
  const alias = entry.as ?? entry.alias;
  const displayName = alias || formatTableName(schema, table);
  return {
    id: nextId('tbl'),
    schema: schema || undefined,
    table,
    alias: alias || undefined,
    displayName,
  };
}

function parseJoinCondition(on: any): {
  condition: string;
  parts?: { left: string; operator: string; right: string };
} {
  if (!on) return { condition: '(no condition)' };
  const condition = exprToString(on);

  if (on.type === 'binary_expr' && on.operator === '=') {
    return {
      condition,
      parts: {
        left: exprToString(on.left),
        operator: '=',
        right: exprToString(on.right),
      },
    };
  }

  return { condition };
}

function parseFromClause(from: any[]): { tables: TableRef[]; joins: JoinEdge[] } {
  const tables: TableRef[] = [];
  const joins: JoinEdge[] = [];

  if (!from || from.length === 0) return { tables, joins };

  from.forEach((entry, index) => {
    const tableRef = buildTableRef(entry, index);
    tables.push(tableRef);

    if (index === 0) return;

    const joinType = normalizeJoinType(entry.join);
    const prevTable = tables[index - 1];
    const { condition, parts } = parseJoinCondition(entry.on);

    joins.push({
      id: nextId('join'),
      type: joinType,
      sourceId: prevTable.id,
      targetId: tableRef.id,
      condition,
      conditionParts: parts,
    });
  });

  return { tables, joins };
}

function buildSelectParsed(ast: any): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  let having = parseConditionTree(ast.having);
  if (having) having = enrichConditionTree(having);

  const groupBy = toArray<any>(ast.groupby?.columns ?? ast.groupby).map((g: any) =>
    exprToString(g),
  );

  const orderBy = toArray<any>(ast.orderby).map(
    (o: any) => `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
  );

  const limit =
    ast.limit?.value?.[0]?.value !== undefined
      ? String(ast.limit.value[0].value)
      : ast.limit
        ? exprToString(ast.limit)
        : undefined;

  return {
    rawSql: '',
    statementType: 'SELECT',
    tables,
    joins,
    where,
    having,
    columns: parseColumns(ast.columns),
    groupBy,
    orderBy,
    limit,
    distinct: Boolean(ast.distinct),
  };
}

function parseSelectQuery(ast: any, rawSql: string): ParsedQuery {
  const branches = collectUnionBranches(ast);
  const main = buildSelectParsed(branches[0].ast);
  main.rawSql = rawSql;

  if (branches.length > 1) {
    main.unionBranches = branches.map((branch, index) => ({
      id: nextId('union'),
      operator: index === 0 ? undefined : branch.unionOp,
      query: { ...buildSelectParsed(branch.ast), rawSql: '' },
    }));
  }

  return main;
}

function parseSetClauses(set: any[]): SetClause[] {
  if (!set || set.length === 0) return [];

  return set.map((entry) => {
    const column = entry.column ?? '';
    const table = entry.table || undefined;
    const value = exprToString(entry.value);
    const qualified = table ? `${table}.${column}` : column;
    return {
      column,
      table,
      value,
      label: `${qualified} = ${value}`,
    };
  });
}

function parseUpdateAst(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.table);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const orderBy = toArray<any>(ast.orderby).map(
    (o: any) => `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
  );

  const limit =
    ast.limit?.value?.[0]?.value !== undefined
      ? String(ast.limit.value[0].value)
      : ast.limit
        ? exprToString(ast.limit)
        : undefined;

  return {
    rawSql,
    statementType: 'UPDATE',
    tables,
    joins,
    where,
    columns: [],
    setClauses: parseSetClauses(ast.set),
    groupBy: [],
    orderBy,
    limit,
    distinct: false,
  };
}

function parseDeleteTargets(targets: any[], tables: TableRef[]): DeleteTarget[] {
  return toArray(targets).map((entry) => {
    const name = entry.table ?? entry.as ?? '';
    const matched = tables.find(
      (t) => t.alias === name || t.table === name || t.displayName === name,
    );
    const label = matched
      ? matched.alias
        ? `${matched.table} AS ${matched.alias}`
        : matched.schema
          ? `${matched.schema}.${matched.table}`
          : matched.table
      : name;
    return { name, label };
  });
}

function parseLimitAndOrder(ast: any): { orderBy: string[]; limit?: string } {
  const orderBy = toArray<any>(ast.orderby).map(
    (o: any) => `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
  );

  const limit =
    ast.limit?.value?.[0]?.value !== undefined
      ? String(ast.limit.value[0].value)
      : ast.limit
        ? exprToString(ast.limit)
        : undefined;

  return { orderBy, limit };
}

function parseDeleteAst(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const { orderBy, limit } = parseLimitAndOrder(ast);

  return {
    rawSql,
    statementType: 'DELETE',
    tables,
    joins,
    where,
    columns: [],
    deleteTargets: parseDeleteTargets(ast.table, tables),
    groupBy: [],
    orderBy,
    limit,
    distinct: false,
  };
}

export function parseMySqlQuery(sql: string): ParseResult {
  resetIds();

  const trimmed = sql.trim();
  if (!trimmed) {
    return { success: false, error: { message: 'SQLを入力してください' } };
  }

  try {
    const ast = parser.astify(trimmed, { database: 'MySQL' });
    const statements = Array.isArray(ast) ? ast : [ast];
    const first = statements[0];

    if (!first) {
      return { success: false, error: { message: '解析できるSQLが見つかりません' } };
    }

    if (first.type === 'select') {
      return { success: true, query: parseSelectQuery(first, trimmed) };
    }

    if (first.type === 'update') {
      return { success: true, query: parseUpdateAst(first, trimmed) };
    }

    if (first.type === 'delete') {
      return { success: true, query: parseDeleteAst(first, trimmed) };
    }

    return {
      success: false,
      error: {
        message: `現在 SELECT / UPDATE / DELETE 文のみ対応しています（検出: ${first.type?.toUpperCase() ?? 'unknown'}）`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SQLの解析に失敗しました';
    return { success: false, error: { message } };
  }
}

export const SAMPLE_SQL = `SELECT
  u.id,
  u.name,
  u.email,
  o.order_no,
  o.total_amount,
  p.product_name,
  c.category_name,
  hot.order_cnt
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
INNER JOIN products p ON p.id = oi.product_id
LEFT JOIN categories c ON c.id = p.category_id
INNER JOIN (
  SELECT user_id, COUNT(*) AS order_cnt
  FROM orders
  GROUP BY user_id
  HAVING COUNT(*) >= 2
) hot ON hot.user_id = u.id
WHERE u.status = 'active'
  AND o.created_at >= '2024-01-01'
  AND (
    o.total_amount > 1000
    OR u.email LIKE '%@example.com'
  )
  AND p.category_id IN (SELECT id FROM categories WHERE active = 1)
  AND oi.quantity BETWEEN 1 AND 10
  AND EXISTS (
    SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'paid'
  )
  AND u.id NOT IN (SELECT user_id FROM banned_users)
GROUP BY u.id, u.name, u.email, o.order_no, o.total_amount, p.product_name, c.category_name, hot.order_cnt
HAVING SUM(oi.quantity) > (
  SELECT AVG(item_cnt) FROM (
    SELECT COUNT(*) AS item_cnt FROM order_items GROUP BY order_id
  ) avg_items
)
ORDER BY o.created_at DESC, o.total_amount DESC
LIMIT 100;`;

export const UPDATE_SAMPLE_SQL = `UPDATE users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
SET
  u.status = 'inactive',
  u.updated_at = NOW(),
  o.closed = 1,
  oi.shipped = 1
WHERE u.last_login_at < '2023-01-01'
  AND o.total_amount > 0
  AND (
    o.status IN ('pending', 'hold')
    OR u.email LIKE '%@deprecated.example'
  )
  AND oi.quantity BETWEEN 1 AND 100
ORDER BY o.updated_at DESC
LIMIT 500;`;

export const DELETE_SAMPLE_SQL = `DELETE u, oi
FROM users u
INNER JOIN orders o ON o.user_id = u.id
INNER JOIN order_items oi ON oi.order_id = o.id
WHERE u.status = 'deleted'
  AND o.created_at < '2022-01-01'
  AND (
    o.total_amount = 0
    OR oi.quantity IS NULL
  )
  AND u.email NOT LIKE '%@keep.example'
ORDER BY o.created_at ASC
LIMIT 200;`;

export const UNION_SAMPLE_SQL = `SELECT id, name, email, 'active' AS source
FROM users
WHERE status = 'active' AND created_at >= '2024-01-01'

UNION ALL

SELECT id, name, email, 'archived' AS source
FROM archived_users
WHERE archived_at IS NOT NULL

UNION

SELECT id, name, email, 'guest' AS source
FROM guest_users g
WHERE g.trial_ends_at < NOW()
  AND NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = g.id
  );`;

export { exprToString };
