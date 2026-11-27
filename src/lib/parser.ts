/* eslint-disable @typescript-eslint/no-explicit-any */
// 既定エントリ（node-sql-parser のルート）は全方言のパーサを同梱する。
// このアプリは MySQL のみなので MySQL 専用ビルドを直接読む（オフライン配布の JS を大幅に軽くする）
import { Parser } from 'node-sql-parser/build/mysql';
import { normalizeConditionTree } from './condition-tree-normalize';
import { NO_JOIN_CONDITION, formatJoinConditionLabel } from './join-condition';
import { findMisboundLogicalOperator, fixLogicalOperatorPrecedence } from './logical-precedence';
import {
  displayIdentifier,
  findExecutableComment,
  findUnclosedLiteral,
  isWordChar,
  maskLiteralsAndComments,
  readBalancedParenEnd,
} from './sql-lex';
import {
  maskNonCode,
  preprocessSqlForParser,
  remapParsedQuerySpans,
  trimParsedQuerySpanEnds,
} from './sql-preprocess';
import {
  columnEntrySourceSpan,
  orderByEntrySourceSpan,
  toSourceSpan,
} from './source-span';
import type {
  ConditionNode,
  CteRef,
  JoinEdge,
  JoinType,
  ParseResult,
  ParsedQuery,
  SelectColumn,
  SetClause,
  DeleteTarget,
  SqlFragment,
  SourceSpan,
  TableModifier,
  TableRef,
  UnionTail,
} from './types';

const parser = new Parser();

let nodeCounter = 0;
/** 前処理後 SQL 上で NATURAL 由来の JOIN キーワード開始オフセット */
let naturalJoinStarts: number[] = [];
/** 前処理後の SQL。AST の位置（loc）はこの文字列上のオフセットで、NATURAL の判定と ORDER BY の範囲に使う */
let processedSqlForNatural = '';
/** SELECT 直後の STRAIGHT_JOIN ヒントを剥がした SELECT 開始オフセット */
let straightJoinHintSelectStarts: number[] = [];
/** 元 SQL 上の SELECT … STRAIGHT_JOIN 範囲（straightJoinHintSelectStarts と同じ順） */
let straightJoinHintOriginalSpans: SourceSpan[] = [];
/**
 * exprToString が要約したサブクエリの AST。いま組み立てているクエリの分だけを持つ
 * （collectEmbeddedSubqueries がクエリごとに差し替える）
 */
let embeddedSubqueryAsts: any[] = [];
/** 前処理で置き換えた関数名（大文字の仮の名前 → 元の名前） */
let renamedFunctions = new Map<string, string>();
/** maskedProcessedSql() の結果と、その元にした processedSqlForNatural */
let maskedProcessed = '';
let maskedProcessedFor = '';

function nextId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter}`;
}

function resetIds(): void {
  nodeCounter = 0;
  naturalJoinStarts = [];
  processedSqlForNatural = '';
  straightJoinHintSelectStarts = [];
  straightJoinHintOriginalSpans = [];
  embeddedSubqueryAsts = [];
  renamedFunctions = new Map();
  maskedProcessed = '';
  maskedProcessedFor = '';
}

function noteEmbeddedSubquery(ast: any): void {
  if (!embeddedSubqueryAsts.includes(ast)) embeddedSubqueryAsts.push(ast);
}

/**
 * build の間に exprToString が要約したサブクエリを解析し、embeddedSubqueries として持たせる。
 * 要約した文字列だけでは `(SELECT MAX(x) FROM t)` と `(SELECT MIN(x) FROM t)` の区別が付かない。
 */
function collectEmbeddedSubqueries(build: () => ParsedQuery): ParsedQuery {
  const outer = embeddedSubqueryAsts;
  embeddedSubqueryAsts = [];
  try {
    const query = build();
    const collected = embeddedSubqueryAsts;
    if (collected.length === 0) return query;
    return { ...query, embeddedSubqueries: collected.map((ast) => buildNestedSelect(ast)) };
  } finally {
    embeddedSubqueryAsts = outer;
  }
}

function formatIdentifier(name: unknown): string {
  if (name == null) return '';
  if (typeof name === 'string') return name;
  if (typeof name === 'object' && name !== null && 'value' in name) {
    const value = (name as { value?: unknown }).value;
    if (value != null) return String(value);
  }
  return String(name);
}

function formatTableName(db: string | undefined, table: string): string {
  if (db) return `${db}.${table}`;
  return table;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 関数名を大文字で返す。前処理で仮の名前に置き換えた関数（STD など）は、元の名前に戻す。
 * `db.f(x)` のスキーマは、パーサーが名前とは別の schema に入れる。落とすと、別のデータベースの関数
 * （db1.f と db2.f）が同じ関数に見え、比較でも同じとして扱ってしまう。データベース名は Unix では大文字小文字を
 * 区別する（MySQL 8.4 リファレンス 11.2.3）ので、スキーマは書いたとおりに残す
 */
function resolveFunctionName(nameField: unknown): string {
  const name = readFunctionName(nameField);
  const restored = renamedFunctions.get(name) ?? name;
  const schema =
    nameField && typeof nameField === 'object' ? formatIdentifier((nameField as { schema?: unknown }).schema) : '';
  return schema ? `${schema}.${restored}` : restored;
}

function readFunctionName(nameField: unknown): string {
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

/**
 * 文字列リテラルを引用符で囲んで書く。パーサーは引用符の中身を、エスケープ（`\'`、`''`、`\\`）も含めて
 * 書いたとおりに value に入れるので、エスケープし直さずにそのまま囲む。エスケープし直すと、`'a\'b'` が
 * `'a\''b'`（文字列として閉じない）に、`"a""b"` が `"a\"\"b"`（値が a""b）になり、別の値に見える
 */
function formatSingleQuotedString(value: string): string {
  return `'${value}'`;
}

function formatDoubleQuotedString(value: string): string {
  return `"${value}"`;
}

function formatQuotedLiteral(node: any): string {
  // `_binary'x'` の文字セット指定。落とすと、照合順序の違う比較が 'x' との比較と同じに見える。
  // パーサーは `BINARY 'x'`（BINARY 演算子）も同じく prefix に入れる。こちらは `_` で始まらないので、
  // 文字セットの指定と区別して、大文字にして空白を挟む（`binary'x'` と書くと SQL として読めない）
  const prefix = typeof node.prefix === 'string' ? node.prefix : '';
  const introducer = !prefix ? '' : prefix.startsWith('_') ? prefix : `${prefix.toUpperCase()} `;
  if (typeof node.raw === 'string' && node.raw.length > 0) {
    const raw = node.raw;
    if (raw.startsWith("'") || raw.startsWith('"')) return `${introducer}${raw}`;
  }
  if (node.type === 'double_quote_string') return `${introducer}${formatDoubleQuotedString(String(node.value))}`;
  return `${introducer}${formatSingleQuotedString(String(node.value))}`;
}

/**
 * 接頭辞の付くリテラル（X'41'、0x41、b'101'、N'abc'、DATE '2024-01-01'）。
 * パーサーは引用符の中身だけを value に入れるので、接頭辞を戻さないと b'101'（値は 5）が 101 に、
 * N'abc' が列名の abc に見え、比較モードでも別の値を同じ値として扱ってしまう
 */
function formatPrefixedLiteral(node: any): string | null {
  const value = String(node.value ?? '');
  const introducer = typeof node.prefix === 'string' && node.prefix ? `${node.prefix} ` : '';
  switch (node.type) {
    case 'hex_string':
      return `${introducer}X'${value}'`;
    case 'full_hex_string':
      return `${introducer}0x${value}`;
    case 'bit_string':
      return `${introducer}b'${value}'`;
    case 'natural_string':
      return `N${formatSingleQuotedString(value)}`;
    case 'date':
    case 'time':
    case 'timestamp':
    case 'datetime':
      return `${String(node.type).toUpperCase()} ${formatSingleQuotedString(value)}`;
    default:
      return null;
  }
}

/** LIKE の ESCAPE 句。右辺に付くので、比較を組み立てるときも忘れず添える */
function formatEscapeClause(node: any): string {
  const escape = node?.right?.escape;
  return escape ? ` ESCAPE ${exprToString(escape.value)}` : '';
}

/**
 * 関数の引数を並べる。`TRIM(BOTH ' ' FROM name)` のようにキーワードが引数列に混ざる形があり、
 * そこへカンマを入れると元の SQL と違う式に見えてしまう
 */
/**
 * 引数にキーワードを取るが、キーワードのあとも普通の引数と同じくカンマで区切る関数。
 * `TIMESTAMPDIFF(DAY, a, b)` を `TIMESTAMPDIFF(DAY a, b)` と書かないようにする
 */
const COMMA_SEPARATED_KEYWORD_ARG_FUNCTIONS = new Set(['TIMESTAMPDIFF', 'TIMESTAMPADD', 'GET_FORMAT']);

function formatFunctionArgs(args: any[], functionName = ''): string {
  const commaOnly = COMMA_SEPARATED_KEYWORD_ARG_FUNCTIONS.has(functionName);
  let out = '';
  let prevWasKeyword = false;
  args.forEach((arg: any, index: number) => {
    const isKeyword = arg?.type === 'origin';
    // キーワード（LEADING・FROM・DAY など）は、ほかのキーワードと同じく大文字で書く。パーサーは書いたとおりに持つ
    const text = isKeyword ? exprToString(arg).toUpperCase() : exprToString(arg);
    if (index > 0) out += !commaOnly && (isKeyword || prevWasKeyword) ? ' ' : ', ';
    out += text;
    prevWasKeyword = isKeyword;
  });
  return out;
}

/** CAST の変換先データ型。node-sql-parser は配列で返し、桁・精度は別フィールドに入る */
function formatCastTarget(target: any): string {
  const entry = Array.isArray(target) ? target[0] : target;
  if (!entry) return '';
  const dataType = String(entry.dataType ?? '');
  const params = [entry.length, entry.scale].filter((v) => v !== undefined && v !== null);
  return params.length > 0 ? `${dataType}(${params.join(',')})` : dataType;
}

/**
 * ウィンドウ枠。`ROWS BETWEEN a AND b` は BETWEEN の二項式、
 * `ROWS UNBOUNDED PRECEDING` は { type: 'rows', expr } の形で来る
 */
function formatWindowFrame(frame: any): string {
  if (!frame) return '';
  if (frame.type !== 'binary_expr' && typeof frame.type === 'string' && frame.expr) {
    return `${frame.type} ${exprToString(frame.expr)}`;
  }
  return exprToString(frame);
}

/** 分析関数の OVER 句。落とすと同じ関数呼び出しに見えてしまう */
function formatOverClause(over: any): string {
  const named = over?.as_window_specification;
  // `OVER w`（WINDOW 句で定義した名前の参照）は文字列で来る
  if (typeof named === 'string') return named ? ` OVER ${named}` : '';
  const spec = named?.window_specification;
  if (!spec) return named?.name ? ` OVER ${named.name}` : '';

  const parts: string[] = [];
  const partitionBy = toArray<any>(spec.partitionby)
    .map((p: any) => exprToString(p?.expr ?? p))
    .filter(Boolean);
  if (partitionBy.length > 0) parts.push(`PARTITION BY ${partitionBy.join(', ')}`);

  const orderBy = toArray<any>(spec.orderby)
    .map((o: any) => `${exprToString(o?.expr ?? o)}${o?.type ? ` ${o.type}` : ''}`)
    .filter((text) => text.trim().length > 0);
  if (orderBy.length > 0) parts.push(`ORDER BY ${orderBy.join(', ')}`);

  // 枠（ROWS BETWEEN 1 PRECEDING AND CURRENT ROW など）は集計する行の範囲を決める
  const frame = formatWindowFrame(spec.window_frame_clause);
  if (frame) parts.push(frame.toUpperCase());

  return ` OVER (${parts.join(' ')})`;
}

/** 式に付く COLLATE と、CONVERT(x USING charset) の USING。表示から外すと別の比較・変換が同じ式に見える */
function formatExprSuffix(node: any): string {
  let out = '';
  const collation = node?.collate?.collate?.name;
  if (collation) out += ` COLLATE ${formatIdentifier(collation)}`;
  if (typeof node?.suffix === 'string' && node.suffix) out += ` ${node.suffix}`;
  return out;
}

function exprToString(node: any): string {
  if (!node) return '';
  return `${exprToStringCore(node)}${formatExprSuffix(node)}`;
}

function exprToStringCore(node: any): string {
  // 元 SQL の括弧を落とすと (a + b) * 2 が a + b * 2 になり、表示が別の意味になる
  const wrap = (text: string): string => (node.parentheses ? `(${text})` : text);

  switch (node.type) {
    case 'column_ref': {
      const parts: string[] = [];
      // `sch.tab.k` の schema。落とすと、FROM の `sch.tab` と別の表に見える
      if (node.db && node.table) parts.push(displayIdentifier(formatIdentifier(node.db)));
      if (node.table) parts.push(displayIdentifier(formatIdentifier(node.table)));
      if (node.column) parts.push(displayIdentifier(formatIdentifier(node.column)));
      return parts.join('.') || '*';
    }
    case 'number':
      return String(node.value);
    case 'bool':
      // パーサーは true / false を JavaScript の真偽値で持つ。ほかのキーワードと同じく大文字で書く
      return String(node.value).toUpperCase();
    case 'string':
    case 'single_quote_string':
    case 'double_quote_string':
      return formatQuotedLiteral(node);
    case 'null':
      return 'NULL';
    case 'star':
      return node.table ? `${node.table}.*` : '*';
    case 'expr_list':
      // 行の値 `(a, b) = (1, 2)` の括弧。IN の値の並びには parentheses が付かないので、括弧は二重にならない
      return wrap(
        toArray(node.value)
          .map((a: any) => exprToString(a))
          .join(', '),
      );
    case 'hex_string':
    case 'full_hex_string':
    case 'bit_string':
    case 'natural_string':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'datetime':
      return formatPrefixedLiteral(node) ?? String(node.value);
    case 'var': {
      // @v / @@session.sql_mode。そのままだと AST の JSON が表示に出る
      const members = toArray<any>(node.members).map((m: any) => `.${formatIdentifier(m)}`).join('');
      return `${node.prefix ?? '@'}${formatIdentifier(node.name)}${members}`;
    }
    case 'fulltext_search': {
      const columns = toArray<any>(node.columns).map((c: any) => exprToString(c)).join(', ');
      const mode = node.mode?.value ? ` ${String(node.mode.value).toUpperCase()}` : '';
      return `MATCH (${columns}) AGAINST (${exprToString(node.expr)}${mode})`;
    }
    case 'binary_expr': {
      const betweenBounds =
        /^(NOT\s+)?BETWEEN$/i.test(String(node.operator ?? '')) && node.right?.type === 'expr_list'
          ? toArray<any>(node.right.value)
          : [];
      if (betweenBounds.length === 2) {
        return wrap(
          `${exprToString(node.left)} ${node.operator} ${exprToString(betweenBounds[0])} AND ${exprToString(betweenBounds[1])}`,
        );
      }
      // ESCAPE を落とすと LIKE の意味が変わって見える
      return wrap(
        `${exprToString(node.left)} ${node.operator} ${exprToString(node.right)}${formatEscapeClause(node)}`,
      );
    }
    case 'unary_expr':
      return wrap(`${node.operator} ${exprToString(node.expr)}`);
    case 'extract':
      return `EXTRACT(${node.args?.field ?? ''} FROM ${exprToString(node.args?.source)})`;
    case 'interval':
      return `INTERVAL ${exprToString(node.expr)} ${String(node.unit ?? '').toUpperCase()}`.trim();
    case 'function': {
      const fnName = resolveFunctionName(node.name);
      const args = formatFunctionArgs(extractFunctionArgs(node), fnName);
      // `a > ALL (SELECT …)` や `EXISTS (SELECT …)`。サブクエリの要約は括弧付きなので、関数の括弧を重ねない
      if (/^(?:ALL|ANY|SOME|EXISTS)$/.test(fnName) && /^\(SELECT .*\)$/.test(args)) return `${fnName} ${args}`;
      return `${fnName}(${args})${formatOverClause(node.over)}`;
    }
    case 'aggr_func': {
      let rawArgs = node.args?.expr ?? node.args?.value ?? node.args;
      let distinctPrefix = node.args?.distinct ? 'DISTINCT ' : '';
      // `SUM(DISTINCT a)` は前処理で `SUM(DISTINCT(a))` にしてから読むので、DISTINCT という名前の関数で来る
      if (
        !distinctPrefix &&
        rawArgs?.type === 'function' &&
        resolveFunctionName(rawArgs.name) === 'DISTINCT' &&
        !rawArgs.over
      ) {
        distinctPrefix = 'DISTINCT ';
        rawArgs = extractFunctionArgs(rawArgs);
      }
      const args = toArray<any>(rawArgs)
        .map((a: any) => exprToString(a))
        .join(', ');
      // GROUP_CONCAT の ORDER BY / SEPARATOR は結果の並びと区切りを決める。落とすと別物に見える
      const orderBy = toArray<any>(node.args?.orderby)
        .map((o: any) => `${exprToString(o?.expr ?? o)}${o?.type ? ` ${o.type}` : ''}`)
        .filter((text) => text.trim().length > 0);
      const orderPart = orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : '';
      const separator = node.args?.separator
        ? ` SEPARATOR ${exprToString(node.args.separator.value ?? node.args.separator)}`
        : '';
      return `${node.name}(${distinctPrefix}${args}${orderPart}${separator})${formatOverClause(node.over)}`;
    }
    case 'case': {
      // ELSE は args の末尾に type:'else' の要素として入る。条件のフィールド名は cond。
      // 単純 CASE（CASE 式 WHEN 値 …）は対象式が node.expr に来る
      const operand = node.expr ? ` ${exprToString(node.expr)}` : '';
      const branches = toArray<any>(node.args).map((arg: any) => {
        if (arg?.type === 'else') return `ELSE ${exprToString(arg.result)}`;
        const cond = exprToString(arg?.cond ?? arg?.condition);
        return `WHEN ${cond} THEN ${exprToString(arg?.result)}`;
      });
      return `CASE${operand} ${branches.join(' ')} END`;
    }
    case 'cast': {
      return `CAST(${exprToString(node.expr)} AS ${formatCastTarget(node.target)})`;
    }
    case 'datatype':
      // `CONVERT(a, CHAR(3))` の変換先の型。素通しすると AST の JSON が表示に出る
      return formatCastTarget(node);
    case 'assign':
      // `@x := a`。素通しすると AST の JSON が表示に出る
      return `${exprToString(node.left)} ${node.symbol ?? ':='} ${exprToString(node.right)}`;
    case 'subquery': {
      const inner = node.subquery?.ast ?? node.subquery ?? node.ast;
      if (inner?.type === 'select') {
        noteEmbeddedSubquery(inner);
        return summarizeSelect(inner);
      }
      return '(subquery)';
    }
    default: {
      // `SET col = (SELECT …)` や SELECT 列のスカラーサブクエリは、
      // type を持たず ast だけを抱えたノードで来る。素通しすると AST の JSON が表示に出る
      const inner = extractSubquerySelectAst(node);
      if (inner) {
        noteEmbeddedSubquery(inner);
        return summarizeSelect(inner);
      }
      if (node.value !== undefined) return String(node.value);
      if (node.raw) return node.raw;
      return JSON.stringify(node);
    }
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
  const cols = toArray<any>(ast.columns).length;
  // FROM がサブクエリなら、その別名で書く。別名が無ければ、画面に出す名前（派生テーブル）で書く
  if (first?.expr?.ast?.type === 'select') return `(SELECT ${cols}列 FROM ${first.as ?? '派生テーブル'})`;
  // `EXISTS (SELECT 1)` のように FROM の無いサブクエリ。FROM DUAL も FROM が無いのと同じ
  if (!first || first.type === 'dual') return `(SELECT ${cols}列)`;
  return `(SELECT ${cols}列 FROM ${first.table ?? '?'})`;
}

/**
 * 集合演算子を大文字の 1 つの形にそろえる。`UNION DISTINCT` は `UNION` と同じ意味（重複を除く。MySQL 8.4 リファレンス 15.2.18）なので、
 * `UNION` にそろえる。そろえないと、作用説明で UNION と UNION ALL が混ざったときの説明になり、比較でも違う演算子として扱う
 */
function normalizeSetOp(op: string | undefined): string {
  if (!op) return 'UNION';
  return op.replace(/\s+/g, ' ').trim().toUpperCase().replace(/^(UNION|INTERSECT|EXCEPT) DISTINCT$/, '$1');
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

function withConditionSpan(node: ConditionNode, astNode: any): ConditionNode {
  const sourceSpan = toSourceSpan(astNode?.loc);
  return sourceSpan ? { ...node, sourceSpan } : node;
}

function normalizeJoinType(join: string | undefined): JoinType {
  if (!join) return 'INNER JOIN';
  const upper = join.toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper.includes('STRAIGHT')) return 'STRAIGHT JOIN';
  if (upper.includes('LEFT')) return 'LEFT JOIN';
  if (upper.includes('RIGHT')) return 'RIGHT JOIN';
  if (upper.includes('FULL')) return 'FULL JOIN';
  if (upper.includes('CROSS')) return 'CROSS JOIN';
  if (upper === 'JOIN') return 'JOIN';
  return 'INNER JOIN';
}

function locStartOffset(node: any): number | null {
  const offset = node?.loc?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

function firstSelectItemOffset(ast: any): number | null {
  const col = ast?.columns?.[0];
  const offset = col?.expr?.loc?.start?.offset ?? col?.loc?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

function firstFromTableOffset(ast: any): number | null {
  const from = ast?.from;
  const first = Array.isArray(from) ? from[0] : from;
  return locStartOffset(first);
}

function pushSelectLocRange(node: any, ranges: Array<{ start: number; end: number }>): void {
  const start = locStartOffset(node);
  const end = node?.loc?.end?.offset;
  if (start != null && typeof end === 'number' && end > start) {
    ranges.push({ start, end });
  }
}

/** SELECT リスト内のスカラーサブクエリなど、このクエリ自身のヒント判定から除外する入れ子 SELECT */
function collectNestedSelectRangesFromExpr(
  node: any,
  ranges: Array<{ start: number; end: number }>,
  seen: Set<unknown> = new Set(),
): void {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) collectNestedSelectRangesFromExpr(item, ranges, seen);
    return;
  }

  const selectAst =
    node.type === 'select' ? node : node.ast?.type === 'select' ? node.ast : null;
  if (selectAst) {
    pushSelectLocRange(selectAst, ranges);
    return;
  }

  if (node.type === 'subquery') {
    collectNestedSelectRangesFromExpr(node.subquery?.ast ?? node.subquery, ranges, seen);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    collectNestedSelectRangesFromExpr(value, ranges, seen);
  }
}

/** WITH 内 SELECT や先頭列のスカラーサブクエリなど、このクエリ自身の SELECT に属さない入れ子範囲 */
function nestedSelectRangesToExclude(ast: any): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const entry of ast?.with ?? []) {
    const inner = entry?.stmt?.ast ?? entry?.stmt;
    pushSelectLocRange(inner, ranges);
  }
  for (const col of ast?.columns ?? []) {
    collectNestedSelectRangesFromExpr(col?.expr ?? col, ranges);
  }
  return ranges;
}

function matchStraightJoinHintIndex(ast: any): number {
  if (straightJoinHintSelectStarts.length === 0) return -1;
  const astStart = locStartOffset(ast);
  if (astStart == null) return -1;
  const exact = straightJoinHintSelectStarts.indexOf(astStart);
  if (exact >= 0) return exact;

  // 先頭列に loc が無いときは FROM 開始まで。クエリ全体 (ast.loc.end) まで広げると
  // SELECT リスト内サブクエリのヒントが外側 JOIN に漏れる
  const windowEnd = firstSelectItemOffset(ast) ?? firstFromTableOffset(ast);
  if (windowEnd == null) return -1;

  const excluded = nestedSelectRangesToExclude(ast);
  return straightJoinHintSelectStarts.findIndex((hintStart) => {
    if (hintStart < astStart || hintStart >= windowEnd) return false;
    return !excluded.some((range) => hintStart >= range.start && hintStart < range.end);
  });
}

function straightJoinHintSpanForAst(ast: any): SourceSpan | undefined {
  const index = matchStraightJoinHintIndex(ast);
  if (index < 0) return undefined;
  return straightJoinHintOriginalSpans[index];
}

/** JOIN 種別の表示用文字列（NATURAL JOIN 対応） */
export function formatJoinDisplayType(join: Pick<JoinEdge, 'type' | 'isNatural'>): string {
  if (!join.isNatural) return join.type;
  const base = join.type === 'JOIN' ? 'INNER JOIN' : join.type;
  return `NATURAL ${base}`;
}

function fromEntryRegionEnd(entry: any): number {
  return entry?.on?.loc?.end?.offset ?? entry?.loc?.end?.offset ?? 0;
}

function fromEntryTableStart(entry: any): number | null {
  const offset = entry?.loc?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

/** 同一 FROM 内で、このテーブルを導入する最初の JOIN が NATURAL 由来か */
function isNaturalJoinEntry(entry: any, prevEntry: any | null): boolean {
  if (naturalJoinStarts.length === 0 || !processedSqlForNatural) return false;
  const tableStart = fromEntryTableStart(entry);
  if (tableStart == null) return false;

  const regionStart = prevEntry ? fromEntryRegionEnd(prevEntry) : 0;
  if (tableStart <= regionStart) return false;

  const slice = processedSqlForNatural.slice(regionStart, tableStart);
  const re = /\b(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN\b/gi;
  const first = re.exec(slice);
  if (!first) return false;

  return naturalJoinStarts.includes(regionStart + first.index);
}

function parseWithClause(withClauses: any[] | null | undefined): CteRef[] {
  if (!withClauses?.length) return [];

  return withClauses.map((entry) => {
    const name = entry.name?.value ?? String(entry.name ?? 'cte');
    const innerAst = entry.stmt?.ast;
    const query =
      innerAst?.type === 'select'
        ? buildNestedSelect(innerAst)
        : buildSelectParsed({ type: 'select', columns: ['*'], from: [] });
    const columns = toArray<any>(entry.columns)
      .map((column: any) => formatIdentifier(column?.column ?? column))
      .filter(Boolean);
    return {
      name,
      columns: columns.length > 0 ? columns : undefined,
      query,
      sourceSpan: toSourceSpan(entry.loc),
    };
  });
}

function attachCteDefinitions(tables: TableRef[], ctes: CteRef[]): TableRef[] {
  if (!ctes.length) return tables;

  const byName = new Map(ctes.map((c) => [c.name, c]));
  return tables.map((table) => {
    const cte = byName.get(table.table) ?? (table.alias ? byName.get(table.alias) : undefined);
    if (!cte) return table;

    return {
      ...table,
      isDerived: true,
      derivedQuery: cte.query,
      displayName: `${cte.name}（CTE）`,
      table: cte.name,
      alias: table.alias && table.alias !== table.table ? table.alias : cte.name,
    };
  });
}

function applyCtesToQuery(query: ParsedQuery, ctes: CteRef[]): ParsedQuery {
  if (!ctes.length) return query;
  return {
    ...query,
    ctes,
    tables: attachCteDefinitions(query.tables, ctes),
  };
}

function parseComparison(node: any): ConditionNode {
  const left = exprToString(node.left);
  const right = exprToString(node.right);
  return withConditionSpan(
    {
      id: nextId('cond'),
      type: 'comparison',
      label: `${left} ${node.operator} ${right}${formatEscapeClause(node)}`,
      operator: node.operator,
      left,
      right,
    },
    node,
  );
}

function parseComparisonWithSubquery(node: any): ConditionNode {
  const left = exprToString(node.left);
  const subAst = extractSubquerySelectAst(node.right);
  if (subAst) {
    return withConditionSpan(
      {
        id: nextId('cond'),
        type: 'subquery',
        label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
        operator: node.operator,
        left,
        nestedQuery: buildNestedSelect(subAst),
      },
      node,
    );
  }
  return parseComparison(node);
}

/**
 * `NOT EXISTS (SELECT …)` の位置。SQL パーサーはこの形の条件に位置を返さない（`EXISTS (…)` には返す）ので、
 * 中の SELECT の位置から、前の `NOT EXISTS (` と後ろの `)` まで広げる。広げられなければ位置を持たせない
 */
function notExistsLoc(node: any): any | undefined {
  const inner = extractSubquerySelectAst(node.expr)?.loc;
  if (typeof inner?.start?.offset !== 'number' || typeof inner?.end?.offset !== 'number') return undefined;
  const masked = maskedProcessedSql();
  const head = /NOT\s+EXISTS\s*\(\s*$/i.exec(masked.slice(0, inner.start.offset));
  if (!head) return undefined;
  let end = inner.end.offset;
  while (end < masked.length && /\s/.test(masked[end]!)) end += 1;
  if (masked[end] !== ')') return undefined;
  return { start: { offset: head.index }, end: { offset: end + 1 } };
}

function parseConditionTree(node: any): ConditionNode | undefined {
  if (!node) return undefined;

  switch (node.type) {
    case 'binary_expr': {
      const rawOp = node.operator?.toUpperCase?.() ?? node.operator;
      // `&&` は AND、`||` は OR と同じ意味（MySQL 8.4 リファレンス 14.4.3）。比較として 1 つの条件にまとめない。
      // 括弧の無い `||` は parseMySqlQuery がエラーにするので、ここに来るのは `(a = 1) || (b = 2)` の形だけ
      const op = rawOp === '&&' ? 'AND' : rawOp === '||' ? 'OR' : rawOp;

      if (op === 'AND' || op === 'OR') {
        const children: ConditionNode[] = [];
        const left = parseConditionTree(node.left);
        const right = parseConditionTree(node.right);
        if (left) children.push(left);
        if (right) children.push(right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: op === 'AND' ? 'and' : 'or',
            label: op,
            operator: op,
            children,
          },
          node,
        );
      }

      if (op === 'IS') {
        const left = exprToString(node.left);
        const right = exprToString(node.right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'is_null',
            label: `${left} IS ${right}`,
            left,
            right,
          },
          node,
        );
      }

      if (op === 'IN' || op === 'NOT IN') {
        const left = exprToString(node.left);
        const subAst = extractSubquerySelectAst(node.right);
        if (subAst) {
          return withConditionSpan(
            {
              id: nextId('cond'),
              type: 'in',
              label: `${left} ${node.operator} ${summarizeSelect(subAst)}`,
              operator: node.operator,
              left,
              nestedQuery: buildNestedSelect(subAst),
            },
            node,
          );
        }
        const values =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a)).join(', ')
            : exprToString(node.right);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'in',
            label: `${left} ${node.operator} (${values})`,
            operator: node.operator,
            left,
            right: values,
          },
          node,
        );
      }

      if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        const left = exprToString(node.left);
        const [low, high] =
          node.right?.type === 'expr_list'
            ? toArray<any>(node.right.value).map((a: any) => exprToString(a))
            : [exprToString(node.right), ''];
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'between',
            label: `${left} ${node.operator} ${low} AND ${high}`,
            operator: node.operator,
            left,
            right: `${low} AND ${high}`,
          },
          node,
        );
      }

      return parseComparisonWithSubquery(node);
    }

    case 'subquery': {
      const subAst = extractSubquerySelectAst(node);
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'subquery',
          label: summarizeSelect(subAst ?? node),
          nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
        },
        node,
      );
    }

    case 'unary_expr': {
      const op = (node.operator?.toUpperCase?.() ?? node.operator ?? '').replace(/\s+/g, ' ').trim();

      if (op === 'NOT EXISTS' || op === 'EXISTS') {
        const subAst = extractSubquerySelectAst(node.expr);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'exists',
            label: subAst ? `${op} ${summarizeSelect(subAst)}` : `${op} (subquery)`,
            nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
          },
          node.loc ? node : { loc: notExistsLoc(node) },
        );
      }

      if (op === 'NOT') {
        const child = parseConditionTree(node.expr);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'not',
            label: 'NOT',
            operator: 'NOT',
            children: child ? [child] : [],
          },
          node,
        );
      }
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'raw',
          label: exprToString(node),
        },
        node,
      );
    }

    case 'function': {
      const name = resolveFunctionName(node.name);
      const args = extractFunctionArgs(node);

      if (name === 'NOT') {
        const child = args[0] ? parseConditionTree(args[0]) : undefined;
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'not',
            label: 'NOT',
            operator: 'NOT',
            children: child ? [child] : [],
          },
          node,
        );
      }

      if (name === 'IN') {
        const left = exprToString(args[0]);
        const values = args.slice(1).map((a: any) => exprToString(a)).join(', ');
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'in',
            label: `${left} IN (${values})`,
            left,
            right: values,
          },
          node,
        );
      }

      if (name === 'EXISTS') {
        const subAst = extractSubquerySelectAst(args[0]);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'exists',
            label: subAst ? `EXISTS ${summarizeSelect(subAst)}` : 'EXISTS (subquery)',
            nestedQuery: subAst ? buildNestedSelect(subAst) : undefined,
          },
          node,
        );
      }

      if (name === 'BETWEEN') {
        const expr = exprToString(args[0]);
        const low = exprToString(args[1]);
        const high = exprToString(args[2]);
        return withConditionSpan(
          {
            id: nextId('cond'),
            type: 'between',
            label: `${expr} BETWEEN ${low} AND ${high}`,
            left: expr,
            right: `${low} AND ${high}`,
          },
          node,
        );
      }

      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'function',
          label: exprToString(node),
        },
        node,
      );
    }

    default:
      return withConditionSpan(
        {
          id: nextId('cond'),
          type: 'raw',
          label: exprToString(node),
        },
        node,
      );
  }
}

function enrichConditionTree(node: ConditionNode): ConditionNode {
  let enriched: ConditionNode = node;
  if (node.type === 'comparison' && node.operator?.toUpperCase() === 'LIKE') {
    enriched = { ...node, type: 'like' };
  }
  if (enriched.children?.length) {
    enriched = { ...enriched, children: enriched.children.map(enrichConditionTree) };
  }
  return normalizeConditionTree(enriched);
}

function parseColumns(columns: any[]): SelectColumn[] {
  if (!columns || columns.length === 0) return [{ expression: '*' }];

  return columns.map((col) => {
    if (col === '*' || col.expr?.type === 'star') {
      const sourceSpan = toSourceSpan(col.expr?.loc ?? col.loc);
      return {
        expression: col.expr?.table ? `${col.expr.table}.*` : '*',
        sourceSpan,
      };
    }
    const expr = col.expr ? exprToString(col.expr) : exprToString(col);
    const alias = col.as ?? col.alias;
    const sourceSpan = columnEntrySourceSpan(col);
    return { expression: expr, alias: alias || undefined, sourceSpan };
  });
}

/** 前処理後の SQL の、文字列・コメント・バッククォートを伏せたもの。列の範囲を補うときに使う */
function maskedProcessedSql(): string {
  if (maskedProcessedFor !== processedSqlForNatural) {
    maskedProcessed = maskNonCode(processedSqlForNatural);
    maskedProcessedFor = processedSqlForNatural;
  }
  return maskedProcessed;
}

function keywordAt(masked: string, pos: number, keyword: string): boolean {
  if (masked.slice(pos, pos + keyword.length).toUpperCase() !== keyword) return false;
  return !/[\w$.]/.test(masked[pos - 1] ?? '') && !/[\w$]/.test(masked[pos + keyword.length] ?? '');
}

const SELECT_MODIFIERS_RE =
  /^(?:\s*(?:DISTINCTROW|DISTINCT|ALL|HIGH_PRIORITY|STRAIGHT_JOIN|SQL_SMALL_RESULT|SQL_BIG_RESULT|SQL_BUFFER_RESULT|SQL_NO_CACHE|SQL_CACHE|SQL_CALC_FOUND_ROWS)\b)+/i;
/** 列の並びの後ろに来る句。FROM の無い SELECT（`SELECT 1, 'a'`）でも、列の並びの終わりが分かる */
const SELECT_LIST_END_KEYWORDS = ['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'FOR', 'UNION', 'EXCEPT', 'INTERSECT'];

/**
 * パーサが位置（loc）を返さない列（CASE 式・文字列や数値・NULL など）の範囲を補う。
 * 範囲が無いと、その列をクリックしても、エディタのカーソルを置いても、SQL と連動しない。
 * SELECT の範囲の中で、括弧の深さ 0 の SELECT から FROM（無ければ次の句か SELECT の終わり）までを、
 * 深さ 0 のカンマで区切る（WITH の定義やサブクエリは括弧の中にあるので数えない）。
 * 区切った数が列の数と合わないときは補わない
 */
function fillMissingColumnSpans(columns: SelectColumn[], ast: any): SelectColumn[] {
  if (columns.every((column) => column.sourceSpan)) return columns;
  const astStart = ast?.loc?.start?.offset;
  const astEnd = ast?.loc?.end?.offset;
  if (typeof astStart !== 'number' || typeof astEnd !== 'number') return columns;
  const sql = processedSqlForNatural;
  const masked = maskedProcessedSql();

  let listStart: number | undefined;
  let listEnd: number | undefined;
  const commas: number[] = [];
  let depth = 0;
  for (let i = astStart; i < astEnd; i++) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth !== 0) continue;
    if (listStart === undefined) {
      if (keywordAt(masked, i, 'SELECT')) {
        listStart = i + 'SELECT'.length;
        const modifier = SELECT_MODIFIERS_RE.exec(masked.slice(listStart, astEnd));
        if (modifier) listStart += modifier[0].length;
        i = listStart - 1;
      }
    } else if (ch === ',') {
      commas.push(i);
    } else if (SELECT_LIST_END_KEYWORDS.some((keyword) => keywordAt(masked, i, keyword))) {
      listEnd = i;
      break;
    }
  }
  if (listStart === undefined) return columns;
  listEnd ??= astEnd;

  const bounds = [listStart, ...commas, listEnd];
  if (bounds.length - 1 !== columns.length) return columns;
  return columns.map((column, index) => {
    if (column.sourceSpan) return column;
    let start = index === 0 ? bounds[0]! : bounds[index]! + 1;
    let end = bounds[index + 1]!;
    // 文字列の中も伏せてあるので、空白かどうかは前処理後の SQL の文字で見る。
    // 範囲の後ろのコメントは trimParsedQuerySpanEnds が除く
    for (;;) {
      while (start < end && /\s/.test(sql[start]!)) start += 1;
      const comment = /^(?:(?:--|#)[^\n]*|\/\*[\s\S]*?\*\/)/.exec(sql.slice(start, end));
      if (!comment) break;
      start += comment[0].length;
    }
    while (end > start && /\s/.test(sql[end - 1]!)) end -= 1;
    return end > start ? { ...column, sourceSpan: { start, end } } : column;
  });
}

/**
 * インラインビューの範囲（`(SELECT …) v`）。パーサは FROM の項目としての位置を返さないので、
 * 中の SELECT の範囲から、囲む括弧と後ろの別名まで広げる。範囲が無いと、JOIN 図のノードや
 * 作用の説明の行をクリックしても、SQL と連動しない
 */
function derivedTableSourceSpan(inner: SourceSpan | undefined, alias: string | undefined): SourceSpan | undefined {
  if (!inner) return undefined;
  const masked = maskedProcessedSql();
  // 中の SELECT の前に続く「(」のうち、いちばん外のものがインラインビューの始まり。
  // `((SELECT …) UNION ALL (SELECT …)) d` では、中の SELECT の範囲の前に「(」が 2 つ並ぶ
  let open = -1;
  for (let i = inner.start - 1; i >= 0; i--) {
    const ch = masked[i]!;
    if (/\s/.test(ch)) continue;
    if (ch !== '(') break;
    open = i;
  }
  if (open < 0) return inner;
  const close = readBalancedParenEnd(masked, open);
  if (close == null) return inner;
  if (!alias) return { start: open, end: close };
  // 括弧と別名のあいだの空白・コメント・AS を飛ばす（伏せた SQL では、コメントは空白になっている）
  let pos = close;
  const skipBlank = () => {
    while (pos < masked.length && /\s/.test(masked[pos]!) && processedSqlForNatural[pos] !== '`') pos += 1;
  };
  skipBlank();
  const as = /^AS(?![\w$#])/i.exec(masked.slice(pos));
  if (as) {
    pos += as[0].length;
    skipBlank();
  }
  const name = /^(?:`(?:[^`]|``)*`|[^\s,()]+)/.exec(processedSqlForNatural.slice(pos))?.[0];
  // 取り出した語が別名と違うとき（`… ) UNION` のように、括弧の後ろが別名でないとき）は、別名を範囲に入れない
  const unquoted = name?.startsWith('`') ? name.slice(1, -1).replace(/``/g, '`') : name;
  if (!name || unquoted?.toUpperCase() !== alias.toUpperCase()) return { start: open, end: close };
  return { start: open, end: pos + name.length };
}

const PARENTHESIZED_JOIN_MESSAGE =
  '括弧でまとめた JOIN（例: a LEFT JOIN (b JOIN c ON …) ON …）には対応していません';

function buildTableRef(entry: any, index: number): TableRef {
  const sourceSpan = toSourceSpan(entry.loc);

  // `a LEFT JOIN (b JOIN c ON …) ON …` は括弧の中が配列で来る。
  // 1 つのテーブルとして読むと b と c が図から消え、`table_1` という実在しない名前が出る
  if (Array.isArray(entry.expr)) throw new Error(PARENTHESIZED_JOIN_MESSAGE);

  if (entry.expr?.ast?.type === 'select') {
    const givenAlias = entry.as ?? entry.alias;
    // 派生テーブルには別名が要る（MySQL 8.4 Reference Manual「Derived Tables」: The [AS] tbl_name clause is mandatory because
    // every table in a FROM clause must have a name）。受け付けると、仮の名前 derived_0 を画面に出してしまう
    if (!givenAlias) {
      throw new Error('FROM 句のサブクエリ（派生テーブル）には別名が要ります。閉じ括弧の後ろに別名を書いてください（例: (SELECT …) AS t）');
    }
    const alias = givenAlias;
    const derivedQuery = buildNestedSelect(entry.expr.ast);
    const span = toSourceSpan(entry.expr?.loc) ?? derivedQuery.sourceSpan;
    return {
      id: nextId('tbl'),
      table: alias,
      alias,
      displayName: `${alias}（派生テーブル）`,
      isDerived: true,
      isLateral: /^LATERAL$/i.test(String(entry.prefix ?? '')) || undefined,
      derivedQuery: span ? { ...derivedQuery, sourceSpan: span } : derivedQuery,
      sourceSpan: sourceSpan ?? derivedTableSourceSpan(span, givenAlias),
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
    sourceSpan,
  };
}

function parseJoinCondition(on: any): {
  condition: string;
  parts?: { left: string; operator: string; right: string };
  conditionRoot?: ConditionNode;
} {
  if (!on) return { condition: NO_JOIN_CONDITION };

  let conditionRoot = parseConditionTree(on);
  if (conditionRoot) conditionRoot = enrichConditionTree(conditionRoot);
  const condition = conditionRoot ? formatJoinConditionLabel(conditionRoot) : exprToString(on);

  if (on.type === 'binary_expr' && on.operator === '=') {
    return {
      condition,
      conditionRoot,
      parts: {
        left: exprToString(on.left),
        operator: '=',
        right: exprToString(on.right),
      },
    };
  }

  return { condition, conditionRoot };
}

function tableJoinQualifier(table: TableRef): string {
  return table.alias ?? table.table;
}

function parseUsingColumnName(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const value = (entry as { value?: unknown; column?: unknown }).value
      ?? (entry as { column?: unknown }).column;
    if (typeof value === 'string') return value;
  }
  return '';
}

function formatUsingClause(columns: string[]): string {
  return `USING (${columns.join(', ')})`;
}

function buildUsingComparison(
  column: string,
  source: TableRef,
  target: TableRef,
): ConditionNode {
  const left = `${tableJoinQualifier(source)}.${column}`;
  const right = `${tableJoinQualifier(target)}.${column}`;
  return {
    id: nextId('cond'),
    type: 'comparison',
    label: `${left} = ${right}`,
    operator: '=',
    left,
    right,
  };
}

function parseUsingJoinCondition(
  using: unknown[],
  source: TableRef,
  target: TableRef,
): {
  condition: string;
  parts?: { left: string; operator: string; right: string };
  conditionRoot?: ConditionNode;
} {
  const columns = using.map(parseUsingColumnName).filter(Boolean);
  if (columns.length === 0) return { condition: NO_JOIN_CONDITION };

  const comparisons = columns.map((col) => buildUsingComparison(col, source, target));
  const conditionRoot = enrichConditionTree(
    comparisons.length === 1
      ? comparisons[0]!
      : {
          id: nextId('cond'),
          type: 'and',
          label: 'AND',
          operator: 'AND',
          children: comparisons,
        },
  );

  const first = comparisons[0]!;
  const parts =
    comparisons.length === 1
      ? { left: first.left!, operator: '=', right: first.right! }
      : undefined;

  return {
    condition: formatUsingClause(columns),
    conditionRoot,
    parts,
  };
}

function parseJoinConditionFromEntry(
  entry: any,
  source: TableRef,
  target: TableRef,
): ReturnType<typeof parseJoinCondition> {
  const using = toArray(entry?.using);
  if (using.length > 0) {
    return parseUsingJoinCondition(using, source, target);
  }
  return parseJoinCondition(entry.on);
}

function parseFromClause(from: any[]): { tables: TableRef[]; joins: JoinEdge[] } {
  const tables: TableRef[] = [];
  const joins: JoinEdge[] = [];

  // `FROM (a JOIN b ON …)` のように FROM 句全体を括弧で囲むと、配列ではなく 1 つのオブジェクトで来る
  if (from && !Array.isArray(from)) throw new Error(PARENTHESIZED_JOIN_MESSAGE);
  if (!from || from.length === 0) return { tables, joins };
  // DUAL は、参照するテーブルが無いときに書ける仮のテーブル名で、FROM が無いのと同じ（MySQL 8.4 リファレンス 15.2.13）。
  // テーブルとして読むと、名前が無いので `table_0` という実在しない名前が図や説明に出る
  from = from.filter((entry) => entry?.type !== 'dual');

  from.forEach((entry, index) => {
    const tableRef = buildTableRef(entry, index);
    tables.push(tableRef);

    if (index === 0) return;

    const joinType = normalizeJoinType(entry.join);
    const prevTable = tables[index - 1]!;
    const prevEntry = from[index - 1];
    const isNatural = isNaturalJoinEntry(entry, prevEntry);
    let { condition, parts, conditionRoot } = parseJoinConditionFromEntry(entry, prevTable, tableRef);

    // NATURAL JOIN は同じ名前の列で結ぶので、ON も USING も書けない（MySQL 8.4 Reference Manual「JOIN Clause」の joined_table）
    if (isNatural && (entry.on || entry.using)) {
      throw new Error(`「${tableRef.alias ?? tableRef.table}」との NATURAL JOIN には、ON も USING も書けません`);
    }
    if (isNatural && condition === NO_JOIN_CONDITION) {
      condition = 'NATURAL JOIN';
    }

    // LEFT JOIN と RIGHT JOIN には ON か USING が要る（MySQL 8.4 Reference Manual「JOIN Clause」の joined_table の構文）。
    // 受け付けると、MySQL では動かない SQL を、結合条件の無い外部結合として説明してしまう
    if (condition === NO_JOIN_CONDITION && (joinType === 'LEFT JOIN' || joinType === 'RIGHT JOIN')) {
      const name = tableRef.alias ?? tableRef.table;
      throw new Error(`「${name}」との ${joinType} に ON（結合条件）がありません。ON か USING で結合条件を書いてください`);
    }

    // MySQL の joined_table の構文に FULL [OUTER] JOIN は無い（MySQL 8.4 Reference Manual「JOIN Clause」）。
    // FULL は予約語でもないので、MySQL では `t1 FULL JOIN t2` の FULL が t1 の別名になり、両側を残す結合にはならない。
    // 受け付けると、MySQL では動かない（または別の意味になる）SQL を FULL JOIN として説明してしまう
    if (joinType === 'FULL JOIN') {
      const name = tableRef.alias ?? tableRef.table;
      throw new Error(`「${name}」との FULL JOIN は、MySQL では書けません。LEFT JOIN か RIGHT JOIN で書いてください`);
    }

    joins.push({
      id: nextId('join'),
      type: joinType,
      sourceId: prevTable.id,
      targetId: tableRef.id,
      condition,
      conditionParts: parts,
      conditionRoot,
      isNatural: isNatural || undefined,
      sourceSpan: toSourceSpan(entry.on?.loc ?? entry.loc),
    });
  });

  return { tables, joins };
}

/** 1 本の SELECT（UNION の 1 ブランチ）を解析する。UNION と WITH は呼び出し側が扱う */
function buildSelectParsed(ast: any): ParsedQuery {
  return collectEmbeddedSubqueries(() => buildSelectParsedCore(ast));
}

function groupByModifierText(ast: any): string | undefined {
  const modifiers = toArray<any>(ast?.groupby?.modifiers)
    .map((m: any) => String(m?.value ?? '').trim().toUpperCase())
    .filter(Boolean);
  return modifiers.length > 0 ? modifiers.join(' ') : undefined;
}

function buildSelectParsedCore(ast: any): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  let having = parseConditionTree(ast.having);
  if (having) having = enrichConditionTree(having);

  const groupEntries = toArray<any>(ast.groupby?.columns ?? ast.groupby);
  const groupSpans = groupEntries.some((g: any) => !g?.loc) ? clauseItemSpans(ast, 'GROUP', groupEntries.length) : [];
  const groupBy: SqlFragment[] = groupEntries.map((g: any, index: number) => ({
    text: exprToString(g),
    sourceSpan: toSourceSpan(g.loc) ?? groupSpans[index],
  }));

  const orderEntries = toArray<any>(ast.orderby);
  const orderSpans = orderEntries.some((o: any) => !o?.expr?.loc) ? clauseItemSpans(ast, 'ORDER', orderEntries.length) : [];
  const orderBy: SqlFragment[] = orderEntries.map((o: any, index: number) => ({
    text: `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
    sourceSpan: orderByEntrySourceSpan(o, processedSqlForNatural) ?? orderSpans[index],
  }));

  const { limit, offset, limitSpan, offsetSpan, limitCommaOffset } = parseLimitOffset(ast);
  const straightJoinHintSpan = straightJoinHintSpanForAst(ast);

  return {
    rawSql: '',
    sourceSpan: toSourceSpan(ast?.loc),
    statementType: 'SELECT',
    tables,
    joins,
    where,
    having,
    columns: fillMissingColumnSpans(parseColumns(ast.columns), ast),
    groupBy,
    groupByModifier: groupByModifierText(ast),
    // `FOR UPDATE SKIP LOCKED` などの行ロックの指定。パーサーは位置を返さない
    lockingClause: typeof ast.locking_read === 'string' && ast.locking_read ? ast.locking_read.toUpperCase() : undefined,
    orderBy,
    limit,
    limitSpan,
    offset,
    offsetSpan,
    limitCommaOffset,
    distinct: Boolean(ast.distinct),
    straightJoinHint: Boolean(straightJoinHintSpan) || undefined,
    straightJoinHintSpan,
  };
}

/**
 * 入れ子の SELECT（派生テーブル・CTE の本体・サブクエリ）を解析する。
 * buildSelectParsed だけだと 2 本目以降の UNION ブランチと WITH 句を捨ててしまうので、
 * 最上位と同じ手順で組み立てる。
 */
function buildNestedSelect(ast: any): ParsedQuery {
  return parseSelectQuery(ast, '');
}

function parseSelectQuery(ast: any, rawSql: string): ParsedQuery {
  const ctes = parseWithClause(ast.with);
  const branches = collectUnionBranches(ast);
  let main = applyCtesToQuery(buildSelectParsed(branches[0].ast), ctes);
  main.rawSql = rawSql;

  if (branches.length > 1) {
    const lastAst = branches[branches.length - 1]!.ast;
    main.unionTail = parseUnionTail(ast, lastAst);
    // 括弧の無い最後のブランチの ORDER BY / LIMIT は UNION 全体のもの。ブランチにも残すと、
    // 作用説明でそのブランチだけが「最大 3 行」のように絞られて見える
    const tailFromLastBranch = Boolean(main.unionTail) && !ast._orderby && !ast._limit;
    main.unionBranches = branches.map((branch, index) => {
      let branchQuery = applyCtesToQuery(buildSelectParsed(branch.ast), ctes);
      if (tailFromLastBranch && branch.ast === lastAst) {
        branchQuery = {
          ...branchQuery,
          orderBy: [],
          limit: undefined,
          limitSpan: undefined,
          offset: undefined,
          offsetSpan: undefined,
          limitCommaOffset: undefined,
        };
      }
      const sourceSpan = toSourceSpan(branch.ast?.loc);
      return {
        id: nextId('union'),
        operator: index === 0 ? undefined : branch.unionOp,
        sourceSpan,
        query: {
          ...branchQuery,
          rawSql: '',
          sourceSpan: sourceSpan ?? branchQuery.sourceSpan,
        },
      };
    });
  }

  return main;
}

/**
 * UNION 全体に掛かる ORDER BY / LIMIT。node-sql-parser は書き方で置き場所を変える。
 * - `(SELECT …) UNION (SELECT …) ORDER BY … LIMIT …` は先頭の AST の _orderby / _limit
 * - `SELECT … UNION SELECT … ORDER BY … LIMIT …` は括弧の無い最後のブランチの orderby / limit
 * 括弧で囲んだ最後のブランチの ORDER BY / LIMIT は、そのブランチだけに掛かる
 */
function parseUnionTail(root: any, last: any): UnionTail | undefined {
  if (root._orderby || root._limit) {
    return parseLimitAndOrder({ orderby: root._orderby, limit: root._limit });
  }
  if (!last?.parentheses_symbol && (last?.orderby || last?.limit)) {
    return parseLimitAndOrder(last);
  }
  return undefined;
}

/** SQL に書かれた UNION / EXCEPT / INTERSECT の数（maskNonCode 済みの SQL を渡す） */
function countSetOperatorKeywords(masked: string): number {
  return masked.match(/\b(?:UNION|EXCEPT|INTERSECT)\b/gi)?.length ?? 0;
}

/** AST が持つ集合演算の数。サブクエリ・派生テーブル・CTE の中も数える */
function countSetOperatorsInAst(node: any, seen: Set<unknown> = new Set()): number {
  if (!node || typeof node !== 'object' || seen.has(node)) return 0;
  seen.add(node);
  let count = !Array.isArray(node) && node._next ? 1 : 0;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc') count += countSetOperatorsInAst(value, seen);
  }
  return count;
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
  return collectEmbeddedSubqueries(() => parseUpdateAstCore(ast, rawSql));
}

function parseUpdateAstCore(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.table);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const orderBy: SqlFragment[] = toArray<any>(ast.orderby).map((o: any) => ({
    text: `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
    sourceSpan: orderByEntrySourceSpan(o, processedSqlForNatural),
  }));

  const { limit, offset, limitSpan, offsetSpan, limitCommaOffset } = parseLimitOffset(ast);

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
    limitSpan,
    offset,
    offsetSpan,
    limitCommaOffset,
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

function limitOffsetValue(entry: any): string | undefined {
  if (entry?.value !== undefined) return String(entry.value);
  if (entry) return exprToString(entry);
  return undefined;
}

/** MySQL の LIMIT 句を limit / offset に分解（カンマ形式は offset, count） */
function parseLimitClause(limitAst: any): {
  limit?: string;
  offset?: string;
  limitSpan?: SourceSpan;
  offsetSpan?: SourceSpan;
  limitCommaOffset?: boolean;
} {
  if (!limitAst) return {};

  if (!limitAst.value?.length) {
    const limitSpan = toSourceSpan(limitAst.loc);
    return { limit: exprToString(limitAst), limitSpan };
  }

  const first = limitOffsetValue(limitAst.value[0]);
  const second = limitAst.value[1] ? limitOffsetValue(limitAst.value[1]) : undefined;
  const firstSpan = toSourceSpan(limitAst.value[0]?.loc);
  const secondSpan = limitAst.value[1] ? toSourceSpan(limitAst.value[1]?.loc) : undefined;
  const separator = String(limitAst.seperator ?? limitAst.separator ?? '').toLowerCase();

  if (second === undefined) {
    return { limit: first, limitSpan: firstSpan ?? toSourceSpan(limitAst.loc) };
  }

  if (separator === ',') {
    return {
      limit: second,
      offset: first,
      limitSpan: secondSpan,
      offsetSpan: firstSpan,
      limitCommaOffset: true,
    };
  }

  return {
    limit: first,
    offset: second,
    limitSpan: firstSpan,
    offsetSpan: secondSpan,
    limitCommaOffset: false,
  };
}

/**
 * GROUP BY / ORDER BY の項目の範囲（前処理後の SQL の座標）を、SQL の文から求める。SQL パーサーは数値（`ORDER BY 2`）や
 * CASE 式に位置を返さないので、その項目は作用説明をクリックしても SQL を選べなかった。この SELECT の範囲の中で、括弧の外にある
 * 最後のキーワードから、括弧の外の `,` で項目を区切る。区切った数が項目の数と合わないときは使わない
 */
function clauseItemSpans(ast: any, keyword: 'GROUP' | 'ORDER', count: number): Array<SourceSpan | undefined> {
  const start = locStartOffset(ast);
  const end = ast?.loc?.end?.offset;
  if (start == null || typeof end !== 'number' || count === 0) return [];
  const masked = maskedProcessedSql();
  const keywordRe = keyword === 'GROUP' ? /^GROUP\s+BY\b/i : /^ORDER\s+(?:SIBLINGS\s+)?BY\b/i;
  const stopRe = /^(?:HAVING|ORDER|UNION|INTERSECT|MINUS|EXCEPT|FETCH|OFFSET|LIMIT|FOR|WINDOW|LOCK|INTO|WITH)\b/i;
  const atWord = (i: number) => /[A-Za-z]/.test(masked[i] ?? '') && !/[\w$#]/.test(masked[i - 1] ?? ' ');
  let depth = 0;
  let clauseStart = -1;
  for (let i = start; i < end; i += 1) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && atWord(i)) {
      const hit = keywordRe.exec(masked.slice(i, i + 24));
      if (hit) clauseStart = i + hit[0].length;
    }
  }
  if (clauseStart < 0) return [];
  const spans: Array<SourceSpan | undefined> = [];
  const pushItem = (from: number, to: number) => {
    const text = masked.slice(from, to);
    const lead = text.length - text.trimStart().length;
    const body = text.trim();
    spans.push(body ? { start: from + lead, end: from + lead + body.length } : undefined);
  };
  depth = 0;
  let itemStart = clauseStart;
  let i = clauseStart;
  for (; i < masked.length; i += 1) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && ch === ',') {
      pushItem(itemStart, i);
      itemStart = i + 1;
    } else if (depth === 0 && (ch === ';' || (keyword === 'GROUP' && atWord(i) && stopRe.test(masked.slice(i, i + 12))))) {
      break;
    }
  }
  pushItem(itemStart, i);
  return spans.length === count ? spans : [];
}

function parseLimitOffset(ast: any): {
  limit?: string;
  offset?: string;
  limitSpan?: SourceSpan;
  offsetSpan?: SourceSpan;
  limitCommaOffset?: boolean;
} {
  if (!ast.limit) return {};
  return parseLimitClause(ast.limit);
}

function parseLimitAndOrder(ast: any): {
  orderBy: SqlFragment[];
  limit?: string;
  offset?: string;
  limitSpan?: SourceSpan;
  offsetSpan?: SourceSpan;
  limitCommaOffset?: boolean;
} {
  const orderBy: SqlFragment[] = toArray<any>(ast.orderby).map((o: any) => ({
    text: `${exprToString(o.expr)}${o.type ? ` ${o.type}` : ''}`,
    sourceSpan: orderByEntrySourceSpan(o, processedSqlForNatural),
  }));

  return { orderBy, ...parseLimitOffset(ast) };
}

function parseDeleteAst(ast: any, rawSql: string): ParsedQuery {
  return collectEmbeddedSubqueries(() => parseDeleteAstCore(ast, rawSql));
}

function parseDeleteAstCore(ast: any, rawSql: string): ParsedQuery {
  const { tables, joins } = parseFromClause(ast.from);

  let where = parseConditionTree(ast.where);
  if (where) where = enrichConditionTree(where);

  const { orderBy, limit, offset, limitSpan, offsetSpan, limitCommaOffset } = parseLimitAndOrder(ast);

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
    limitSpan,
    offset,
    offsetSpan,
    limitCommaOffset,
    distinct: false,
  };
}

/** 解析結果に含まれる表すべて。派生テーブル・サブクエリ・UNION のブランチ・WITH の中までたどる */
function allTablesOf(query: ParsedQuery): TableRef[] {
  const tables: TableRef[] = [];
  const seen = new Set<ParsedQuery>();
  const visitCondition = (node: ConditionNode | undefined): void => {
    if (!node) return;
    node.children?.forEach(visitCondition);
    if (node.nestedQuery) visitQuery(node.nestedQuery);
  };
  const visitQuery = (q: ParsedQuery): void => {
    if (seen.has(q)) return;
    seen.add(q);
    tables.push(...q.tables);
    visitCondition(q.where);
    visitCondition(q.having);
    q.joins.forEach((join) => visitCondition(join.conditionRoot));
    q.tables.forEach((table) => table.derivedQuery && visitQuery(table.derivedQuery));
    q.unionBranches?.forEach((branch) => visitQuery(branch.query));
    q.ctes?.forEach((cte) => visitQuery(cte.query));
    q.embeddedSubqueries?.forEach(visitQuery);
  };
  visitQuery(query);
  return tables;
}

/**
 * 前処理で取り除いた表の後ろの PARTITION (…) を、その表に持たせる。PARTITION は表の名前のすぐ後ろ（別名の前）に書くので、
 * 指定より前から始まる表のうち、いちばん近いものの指定とする。同じ表を別のオブジェクトとして持つことがあるので、
 * 同じ位置から始まる表すべてに持たせる
 */
function attachTableModifiers(query: ParsedQuery, modifiers: TableModifier[]): ParsedQuery {
  if (modifiers.length === 0) return query;
  const tables = allTablesOf(query).filter((t) => t.sourceSpan);
  for (const modifier of modifiers) {
    let best: number | undefined;
    for (const table of tables) {
      const start = table.sourceSpan!.start;
      if (start <= modifier.sourceSpan.start && (best === undefined || start > best)) best = start;
    }
    if (best === undefined) continue;
    for (const table of tables) {
      if (table.sourceSpan!.start !== best) continue;
      if (!table.modifiers?.includes(modifier)) table.modifiers = [...(table.modifiers ?? []), modifier];
    }
  }
  return query;
}

/** AST の中の SELECT・UPDATE・DELETE をすべて集める（サブクエリ・UNION のブランチ・WITH の中を含む） */
function statementAsts(node: any, out: any[] = [], seen = new Set<any>()): any[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((item) => statementAsts(item, out, seen));
    return out;
  }
  if (node.type === 'select' || node.type === 'update' || node.type === 'delete') out.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc') statementAsts(value, out, seen);
  }
  return out;
}

/** 1 つの問い合わせのブロックの中で、条件に合う AST のノードを探す。サブクエリ（別の SELECT）の中には入らない */
function findInBlockAst(node: any, match: (n: any) => boolean): any | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findInBlockAst(item, match);
      if (found) return found;
    }
    return undefined;
  }
  if (node.type === 'select' || node.ast) return undefined;
  if (match(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    const found = findInBlockAst(value, match);
    if (found) return found;
  }
  return undefined;
}

/**
 * WHERE に書けない関数。SQL パーサーは受け付けるので、MySQL では動かない SQL を説明してしまう。
 * - 集約関数は WHERE に書けない（行を絞ったあとで集約するので。集約した値で絞るなら HAVING）
 * - ウィンドウ関数は SELECT の列と ORDER BY にだけ書ける（MySQL 8.4 Reference Manual「Window Function Concepts and
 *   Syntax」: Window functions are permitted only in the select list and ORDER BY clause）
 */
function misplacedFunctionError(ast: any, sql: string, processedToInput: number[]): ParseResult | null {
  for (const statement of statementAsts(ast)) {
    const aggregate = findInBlockAst(statement.where, (n) => n.type === 'aggr_func' && !n.over);
    const windowed = findInBlockAst(statement.where, (n) => Boolean(n.over));
    const node = aggregate ?? windowed;
    if (!node) continue;
    const message = aggregate
      ? '集約関数は WHERE に書けません。集約した値で絞るなら HAVING に書いてください'
      : 'ウィンドウ関数（OVER (…)）は WHERE に書けません。サブクエリの外側で絞ってください';
    const start = processedToInput[node.loc?.start?.offset ?? -1];
    const last = processedToInput[(node.loc?.end?.offset ?? 0) - 1];
    if (start === undefined || last === undefined) return { success: false, error: { message } };
    // パーサーの位置は後ろの空白まで延びるので、範囲から除く
    let end = last + 1;
    while (end > start + 1 && /\s/.test(sql[end - 1] ?? '')) end -= 1;
    const at = lineColumnAt(sql, start);
    return { success: false, error: { message: `${at.line} 行 ${at.column} 列の${message}`, position: start, span: { start, end } } };
  }
  return null;
}

/**
 * Oracle の書き方で、MySQL には無いもの。SQL パーサーは原因の分からない構文エラーにするか、MINUS のように受け付けてしまう。
 * - 行制限は LIMIT だけ（MySQL 8.4 Reference Manual の SELECT の構文。FETCH FIRST と OFFSET … ROWS は無い）
 * - MINUS は無い（「Set Operations」: Some database systems, such as Oracle, use MINUS … This is not supported in MySQL）
 * - (+) の外部結合と、CONNECT BY の階層問い合わせは無い
 */
const ORACLE_ONLY_SYNTAX: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bFETCH\s+(?:FIRST|NEXT)\b/i, message: '「FETCH」は MySQL にありません。行の数を制限するなら LIMIT で書いてください' },
  { pattern: /\bOFFSET\s+\S+\s+ROWS?\b/i, message: '「OFFSET … ROWS」は MySQL にありません。LIMIT … OFFSET … で書いてください' },
  { pattern: /\bMINUS\b(?=\s+(?:ALL\s+|DISTINCT\s+)?(?:SELECT\b|\())/i, message: '「MINUS」は MySQL にありません。EXCEPT と書いてください' },
  { pattern: /\(\s*\+\s*\)/, message: '「(+)」は Oracle の外部結合の書き方で、MySQL にはありません。LEFT JOIN … ON で書いてください' },
  { pattern: /\b(?:CONNECT\s+BY|START\s+WITH)\b/i, message: '階層問い合わせ（START WITH / CONNECT BY）は MySQL にありません。WITH RECURSIVE で書いてください' },
];

function oracleOnlySyntaxError(trimmed: string, leadingTrim: number, sql: string): ParseResult | null {
  const masked = maskNonCode(trimmed);
  const hits = ORACLE_ONLY_SYNTAX.map(({ pattern, message }) => ({ match: pattern.exec(masked), message }))
    .filter((hit): hit is { match: RegExpExecArray; message: string } => hit.match !== null)
    .sort((a, b) => a.match.index - b.match.index);
  const first = hits[0];
  if (!first) return null;
  const start = first.match.index + leadingTrim;
  const end = start + first.match[0].length;
  const { line, column } = lineColumnAt(sql, start);
  return { success: false, error: { message: `${line} 行 ${column} 列の${first.message}`, position: start, span: { start, end } } };
}

/**
 * JOIN の ON から、FROM 句でその JOIN より後ろにある表を参照していないか。ON で参照できるのは、その JOIN までに出てきた表と
 * 外側の問い合わせの表だけで、後ろの表を参照すると MySQL はエラーにする（Unknown column … in 'on clause'）。SQL パーサーは
 * 受け付けるので、MySQL では動かない SQL を説明してしまう。正しい SQL をエラーにしないよう、ほかの問い合わせのブロックにも
 * ある名前（外側の問い合わせやサブクエリの表）は調べない
 */
function forwardJoinReferenceError(query: ParsedQuery, sql: string): ParseResult | null {
  const withNames = maskLiteralsAndComments(sql);
  const blocks: ParsedQuery[] = [];
  const seen = new Set<ParsedQuery>();
  const visitCondition = (node: ConditionNode | undefined): void => {
    if (!node) return;
    node.children?.forEach(visitCondition);
    if (node.nestedQuery) visitBlock(node.nestedQuery);
  };
  const visitBlock = (q: ParsedQuery): void => {
    if (seen.has(q)) return;
    seen.add(q);
    blocks.push(q);
    visitCondition(q.where);
    visitCondition(q.having);
    q.joins.forEach((join) => visitCondition(join.conditionRoot));
    q.tables.forEach((table) => table.derivedQuery && visitBlock(table.derivedQuery));
    q.unionBranches?.forEach((branch) => visitBlock(branch.query));
    q.ctes?.forEach((cte) => visitBlock(cte.query));
    q.embeddedSubqueries?.forEach(visitBlock);
  };
  visitBlock(query);
  const key = (t: TableRef) => (t.alias ?? t.table).toLowerCase();
  const reference = /(?<![\p{L}\p{N}\p{M}_$`.])(`(?:[^`]|``)*`|[\p{L}\p{N}\p{M}_$]+)\s*\.\s*(?:`(?:[^`]|``)*`|[\p{L}\p{N}\p{M}_$]+)/gu;
  for (const block of blocks) {
    const elsewhere = new Set(blocks.filter((b) => b !== block).flatMap((b) => b.tables.map(key)));
    for (const join of block.joins) {
      if (!join.sourceSpan || !join.conditionRoot) continue;
      const targetIndex = block.tables.findIndex((t) => t.id === join.targetId);
      if (targetIndex < 0) continue;
      const visible = new Set(block.tables.slice(0, targetIndex + 1).map(key));
      const later = new Set(block.tables.slice(targetIndex + 1).map(key));
      const text = withNames.slice(join.sourceSpan.start, join.sourceSpan.end);
      for (const match of text.matchAll(reference)) {
        const raw = match[1]!;
        const name = (raw.startsWith('`') ? raw.slice(1, -1).replace(/``/g, '`') : raw).toLowerCase();
        if (!later.has(name) || visible.has(name) || elsewhere.has(name)) continue;
        const start = join.sourceSpan.start + match.index!;
        const { line, column } = lineColumnAt(sql, start);
        return {
          success: false,
          error: {
            message: `${line} 行 ${column} 列の「${match[0]}」は、この JOIN より後ろの表を参照しています。ON では、それまでに結合した表だけを参照できます`,
            position: start,
            span: { start, end: start + match[0].length },
          },
        };
      }
    }
  }
  return null;
}

export function parseMySqlQuery(sql: string): ParseResult {
  resetIds();

  const trimmed = sql.trim();
  if (!trimmed) {
    return { success: false, error: { message: 'SQLを入力してください' } };
  }
  // MySQL は `/*! … */` の中身を SQL として実行するが、SQL パーサーはコメントとして読み飛ばす。
  // そのまま解析すると、中に書いた WHERE などが無い文として説明し、比較でもコメントの無い SQL と同じと判定してしまう
  const executable = findExecutableComment(sql);
  if (executable) {
    const at = lineColumnAt(sql, executable.start);
    const span = { start: executable.start, end: Math.min(executable.start + 3, executable.end) };
    return {
      success: false,
      error: {
        message: `${at.line} 行 ${at.column} 列の「/*!」のコメントは、MySQL では中身が SQL として実行されます。中身をコメントの外に書いてください`,
        position: span.start,
        span,
      },
    };
  }

  // 位置（sourceSpan）は呼び出し元が渡した sql 上のオフセットで返す。
  // 解析は前後の空白を取り除いた文字列で行うので、先頭の空白の分だけ後ろへずらす。
  // ずらさないと、空行や字下げで始まる SQL でエディタの強調位置がその分だけ手前にずれる
  const leadingTrim = sql.length - sql.trimStart().length;
  const toInputOffset = (offset: number): number => offset + leadingTrim;
  const oracleOnly = oracleOnlySyntaxError(trimmed, leadingTrim, sql);
  if (oracleOnly) return oracleOnly;
  /** 前処理後の SQL 上のオフセットと、入力 sql 上のオフセットの対応表。構文エラーの位置を戻すのに使う */
  let processedToInputForError: number[] | null = null;

  try {
    const {
      sql: preprocessed,
      naturalJoinStarts: starts,
      straightJoinHintSelectStarts: straightStarts,
      straightJoinHintOriginalSpans: straightSpans,
      processedToOriginal,
      renamedFunctions: renamed,
      lockingClause: strippedLocking,
      tableModifiers: strippedModifiers,
      dmlIgnoreSpan: strippedIgnore,
    } = preprocessSqlForParser(trimmed);
    processedToInputForError = processedToOriginal.map(toInputOffset);
    renamedFunctions = renamed;

    naturalJoinStarts = starts;
    straightJoinHintSelectStarts = straightStarts;
    straightJoinHintOriginalSpans = straightSpans.map((span) => ({
      start: toInputOffset(span.start),
      end: toInputOffset(span.end),
    }));
    processedSqlForNatural = preprocessed;
    const ast = parser.astify(preprocessed, {
      database: 'MySQL',
      parseOptions: { includeLocations: true },
    });
    // パーサーは WHERE などの中で AND と OR を同じ優先順位で結び付けるので、MySQL の優先順位で組み直す
    fixLogicalOperatorPrecedence(ast);
    const misplaced = misplacedFunctionError(ast, sql, processedToInputForError);
    if (misplaced) return misplaced;
    const misbound = findMisboundLogicalOperator(ast);
    if (misbound) {
      return {
        success: false,
        error: {
          message:
            `${misbound} の前後の比較を括弧で囲んでください（例: (a = 1) ${misbound} (b = 2)）。括弧が無いと、SQL パーサーが ${misbound} を比較より先に結び付けてしまい、MySQL と違う意味で解析されます` +
            // || は既定では OR だが、PIPES_AS_CONCAT を有効にした MySQL では文字列の連結になる（MySQL 8.4 リファレンス 14.4.1）
            (misbound === '||' ? '。文字列を連結するつもりなら、CONCAT() で書いてください' : ''),
        },
      };
    }
    // 先頭 `;` などで astify が type を持たない空要素を返すことがある。文数に数えない
    const statements = (Array.isArray(ast) ? ast : [ast]).filter((statement) => statement?.type);
    const first = statements[0];

    if (!first) {
      return { success: false, error: { message: '解析できるSQLが見つかりません' } };
    }

    // 2 文目以降を黙って捨てると、貼り付けミスに気づけないまま 1 文目の解析結果を見てしまう
    if (statements.length > 1) {
      return {
        success: false,
        error: {
          message: `複数の文が含まれています（${statements.length} 文）。1 文ずつ入力してください`,
        },
      };
    }

    const processedToInput = leadingTrim > 0 ? processedToOriginal.map(toInputOffset) : processedToOriginal;
    // 表の後ろの PARTITION (…) は、範囲を入力 sql の座標にずらしてから、直前の表に持たせる
    const tableModifiers = strippedModifiers.map((m) => ({
      ...m,
      sourceSpan: { start: toInputOffset(m.sourceSpan.start), end: toInputOffset(m.sourceSpan.end) },
    }));
    // UPDATE IGNORE / DELETE IGNORE の IGNORE。範囲は入力 sql の座標にずらしてから持たせる（remap はこの範囲を動かさない）
    const withIgnore = (query: ParsedQuery): ParsedQuery =>
      strippedIgnore
        ? { ...query, dmlIgnoreSpan: { start: toInputOffset(strippedIgnore.start), end: toInputOffset(strippedIgnore.end) } }
        : query;
    const remap = (query: ParsedQuery) =>
      attachTableModifiers(trimParsedQuerySpanEnds(remapParsedQuerySpans(processedToInput, query, sql), sql), tableModifiers);

    if (first.type === 'select') {
      // `SELECT … UNION (SELECT …)` は右側のブランチがエラーにならずに AST から消える。
      // サブクエリの中でも同じで、そのまま解析すると UNION の無い SELECT として表示・比較してしまう
      if (countSetOperatorKeywords(maskNonCode(preprocessed)) > countSetOperatorsInAst(first)) {
        return {
          success: false,
          error: {
            message:
              'UNION の一部のブランチを解析できませんでした。右側だけを括弧で囲む書き方（SELECT … UNION (SELECT …)）には対応していません。両側を括弧で囲むか、括弧を外してください',
          },
        };
      }
      const parsed = parseSelectQuery(first, sql);
      // 前処理で取り除いた文の最後の FOR UPDATE / FOR SHARE は、書いたとおりに表示する（OF の後ろの表の名前を大文字にしない）。
      // 範囲は前処理に渡した SQL の座標なので、入力 sql の座標へずらす。remap はこの範囲を動かさない
      const query = strippedLocking
        ? {
            ...parsed,
            lockingClause: strippedLocking.text,
            lockingClauseSpan: {
              start: toInputOffset(strippedLocking.sourceSpan.start),
              end: toInputOffset(strippedLocking.sourceSpan.end),
            },
          }
        : parsed;
      const mapped = remap(query);
      return forwardJoinReferenceError(mapped, sql) ?? { success: true, query: mapped };
    }

    if (first.type === 'update') {
      const query = remap(withIgnore(parseUpdateAst(first, sql)));
      return multiTableOrderLimitError(query, sql) ?? { success: true, query };
    }

    if (first.type === 'delete') {
      const query = withIgnore(parseDeleteAst(first, sql));
      // `DELETE FROM u JOIN x ON …` や `DELETE FROM u, x` は MySQL では構文エラー（複数のテーブルを使う DELETE は、
      // 削除するテーブルを DELETE の直後か USING の前に書く。MySQL 8.4 リファレンス 15.2.2）。
      // SQL パーサーは削除対象の無い文として読むので、そのまま表示すると何を削除するのかが出ない
      if (!query.deleteTargets?.length) {
        return {
          success: false,
          error: {
            message:
              'DELETE FROM の後ろに複数のテーブルや JOIN を書くときは、削除するテーブルを指定してください（例: DELETE u FROM u JOIN x ON … または DELETE FROM u USING u JOIN x ON …）',
          },
        };
      }
      const mapped = remap(query);
      return multiTableOrderLimitError(mapped, sql) ?? { success: true, query: mapped };
    }

    return {
      success: false,
      error: {
        message: `現在 SELECT / UPDATE / DELETE 文のみ対応しています（検出: ${first.type?.toUpperCase() ?? 'unknown'}）`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SQLの解析に失敗しました';
    const rawSpan = processedToInputForError
      ? syntaxErrorSpan(err, processedToInputForError, sql)
      : undefined;
    if (!rawSpan) {
      const reservedAlias = reservedAliasSpan(sql, message);
      return {
        success: false,
        error: {
          message: translateParserMessage(message),
          ...(reservedAlias ? { position: reservedAlias.start, span: reservedAlias } : {}),
        },
      };
    }
    const cause = likelySyntaxErrorCause(sql, rawSpan.start, syntaxErrorFound(message) === null);
    if (cause) {
      return { success: false, error: { message: cause.message, detail: message, position: cause.span.start, span: cause.span } };
    }
    // SQL パーサーは NULL 安全な等価演算子 <=> を読めず、`<=` のあとの `>` でエラーにする。
    // 「「>」で構文を解釈できません」では原因が分からないので、演算子ごと示して対応していないと書く
    if (rawSpan.start >= 2 && sql.slice(rawSpan.start - 2, rawSpan.start + 1) === '<=>') {
      const nullSafe = { start: rawSpan.start - 2, end: rawSpan.start + 1 };
      const at = lineColumnAt(sql, nullSafe.start);
      return {
        success: false,
        error: {
          message: `${at.line} 行 ${at.column} 列の「<=>」（NULL どうしも等しいとみなす等価演算子）には対応していません`,
          detail: message,
          position: nullSafe.start,
          span: nullSafe,
        },
      };
    }
    // SQL パーサーは INTERSECT ALL と EXCEPT ALL（重複を残す集合演算）を読めず、ALL の位置でエラーにする。
    // 「「ALL」で構文を解釈できません」では原因が分からないので、演算子ごと示して対応していないと書く
    const setAll = /\b(INTERSECT|EXCEPT)\s+$/i.exec(maskNonCode(sql).slice(0, rawSpan.start));
    if (setAll && /^ALL\b/i.test(sql.slice(rawSpan.start))) {
      const operatorSpan = { start: setAll.index, end: rawSpan.start + 'ALL'.length };
      const at = lineColumnAt(sql, operatorSpan.start);
      return {
        success: false,
        error: {
          message: `${at.line} 行 ${at.column} 列の「${setAll[1]!.toUpperCase()} ALL」（重複を残す集合演算）には対応していません`,
          detail: message,
          position: operatorSpan.start,
          span: operatorSpan,
        },
      };
    }
    // パーサーは 1 文字だけを指すので、語の途中で切れていたら語の終わりまで広げる（「ROW」を「R」とだけ示さない）
    const span = extendSpanToWordEnd(sql, rawSpan);
    const { line, column } = lineColumnAt(sql, span.start);
    const found = syntaxErrorFound(message);
    // 見つかった文字は、パーサーの文（前処理で書き換えたあとの SQL）からではなく、元の SQL のエラーの範囲から取る
    const foundText = sql.slice(span.start, span.end).trim();
    const summary =
      found === undefined
        ? `${line} 行 ${column} 列で構文を解釈できません（${message}）`
        : found === null
          ? `${line} 行 ${column} 列で構文を解釈できません（SQL が途中で終わっています）`
          : foundText
            ? `${line} 行 ${column} 列の「${foundText}」で構文を解釈できません`
            : `${line} 行 ${column} 列で構文を解釈できません`;
    return {
      success: false,
      error: {
        message: summary,
        ...(found === undefined ? {} : { detail: message }),
        position: span.start,
        span,
      },
    };
  }
}

/**
 * 複数のテーブルを使う UPDATE と DELETE には、ORDER BY と LIMIT を書けない（MySQL 8.4 リファレンス 15.2.17、15.2.2）。
 * SQL パーサーはそのまま読むので、MySQL では実行できない文を「最大 500 行を更新」のように説明してしまう。
 * テーブルが 1 つの `DELETE t FROM t … LIMIT 1` は、エラーになるかをリファレンスで確かめられないので、そのまま通す
 */
function multiTableOrderLimitError(query: ParsedQuery, sql: string): ParseResult | null {
  if (query.tables.length < 2) return null;
  const clause = query.orderBy.length > 0 ? 'ORDER BY' : query.limit ? 'LIMIT' : null;
  if (!clause) return null;
  const span = clause === 'ORDER BY' ? query.orderBy[0]?.sourceSpan : query.limitSpan;
  const at = span ? lineColumnAt(sql, span.start) : null;
  return {
    success: false,
    error: {
      message: `${at ? `${at.line} 行 ${at.column} 列: ` : ''}複数のテーブルを使う ${query.statementType} には、ORDER BY と LIMIT を書けません。MySQL では実行するとエラーになります`,
      ...(span ? { position: span.start, span } : {}),
    },
  };
}
/** span の始まりが語（識別子・キーワード）の文字なら、終わりを語の終わりまで広げる */
function extendSpanToWordEnd(sql: string, span: SourceSpan): SourceSpan {
  if (!isWordChar(sql[span.start])) return span;
  let end = Math.max(span.end, span.start);
  while (end < sql.length && isWordChar(sql[end])) end++;
  return end === span.end ? span : { start: span.start, end };
}

/**
 * 位置を持たない英語のエラーの文のうち、意味の分かるものを日本語にする。分からないものはそのまま返す。
 * `t AS OF ...` のように予約語を別名の位置に書くと、node-sql-parser は位置の無いエラーを投げる
 */
/** 予約語を別名にしたエラーは位置を持たないので、`AS 予約語` を元の SQL から探してエディタで示せるようにする */
function reservedAliasSpan(sql: string, message: string): SourceSpan | undefined {
  const reserved = /^Error: "(.+)" is a reserved word, can not as alias clause$/.exec(message);
  if (!reserved) return undefined;
  const word = reserved[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\bAS\\s+(${word})(?![\\w$])`, 'i').exec(maskNonCode(sql));
  if (!match) return undefined;
  const start = match.index + match[0].length - match[1]!.length;
  return { start, end: start + match[1]!.length };
}

/** 全角の空白と、半角に対応する全角の記号（，（）＝ など）。英数字の全角（ａ、１）は名前に使えるので含めない */
const FULL_WIDTH_SEPARATOR_RE = /[　！-／：-＠［-｀｛-～]/;

/**
 * パーサーのエラー位置より手前にある、本当の原因と考えられる所。
 * - 閉じていない文字列・バッククォート・コメント。パーサーは SQL の末尾を指し、「途中で終わっています」のエラーになる
 * - 全角の空白や記号。MySQL は U+0080〜U+FFFF を名前の文字として読む（MySQL 8.4 リファレンス 11.2）ので、
 *   `t　WHERE` は 1 つの名前になり、エラーはその先の語で出る
 */
function likelySyntaxErrorCause(
  sql: string,
  errorStart: number,
  endedEarly: boolean,
): { message: string; span: SourceSpan } | null {
  if (endedEarly) {
    const unclosed = findUnclosedLiteral(sql);
    if (unclosed) {
      const at = lineColumnAt(sql, unclosed.start);
      const what =
        unclosed.opener === '/*' ? 'コメント' : unclosed.opener === '`' ? 'バッククォートの名前' : '文字列';
      return {
        message: `${at.line} 行 ${at.column} 列の「${unclosed.opener}」で始まる${what}が閉じていません`,
        span: { start: unclosed.start, end: unclosed.start + unclosed.opener.length },
      };
    }
  }
  const masked = maskNonCode(sql);
  const index = masked.slice(0, errorStart + 1).search(FULL_WIDTH_SEPARATOR_RE);
  if (index < 0) {
    return (
      missingSelectItemCause(sql, masked, errorStart) ??
      nestedSetOperationCause(masked) ??
      missingOperandCause(sql, masked, errorStart) ??
      unbalancedParenCause(sql, masked, errorStart, endedEarly)
    );
  }
  const ch = masked[index]!;
  const at = lineColumnAt(sql, index);
  const message =
    ch === '　'
      ? `${at.line} 行 ${at.column} 列に全角の空白があります。全角の空白は区切りにならず、前後の語とつながった名前として読まれます。半角の空白にしてください`
      : `${at.line} 行 ${at.column} 列の「${ch}」は全角の文字です。SQL の記号は半角（「${String.fromCharCode(ch.charCodeAt(0) - 0xfee0)}」）で書いてください`;
  return { message, span: { start: index, end: index + 1 } };
}

const NESTED_SET_OPERATOR_RE = /\b(?:UNION|INTERSECT|EXCEPT)\b/i;
const SET_OPERAND_PREFIX_RE = /(?:^|\b(?:UNION|INTERSECT|EXCEPT)(?:\s+(?:ALL|DISTINCT))?)\s*$/i;

/**
 * 集合演算の項にした括弧の中に、さらに集合演算を書いた形（`(SELECT … UNION SELECT …) EXCEPT SELECT …`）。
 * SQL パーサーはこの括弧を読めず、括弧の中の 2 つ目の SELECT でエラーにするので、エラーの位置だけでは原因が分からない
 */
function nestedSetOperationCause(masked: string): { message: string; span: SourceSpan } | null {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === ')') depth -= 1;
    if (ch !== '(') continue;
    depth += 1;
    if (depth !== 1 || !SET_OPERAND_PREFIX_RE.test(masked.slice(0, i))) continue;
    const end = readBalancedParenEnd(masked, i);
    if (end == null) continue;
    let inner = masked.slice(i + 1, end - 1);
    if (!/^\s*(?:SELECT\b|\()/i.test(inner)) continue;
    // 括弧の中の括弧（サブクエリなど）を除いてから、集合演算の語を探す
    for (let previous = ''; previous !== inner; ) {
      previous = inner;
      inner = inner.replace(/\([^()]*\)/g, (group) => ' '.repeat(group.length));
    }
    if (!NESTED_SET_OPERATOR_RE.test(inner)) continue;
    return {
      message: '括弧の中で集合演算をまとめる書き方（(SELECT … UNION SELECT …) EXCEPT SELECT …）には対応していません',
      span: { start: i, end },
    };
  }
  return null;
}

/**
 * 括弧の数が合わないとき、閉じていない「(」か、対応する「(」の無い「)」。
 * 対応する「(」の無い「)」は、パーサーがそこでエラーにしたときだけ原因とみなす
 */
function unbalancedParenCause(
  sql: string,
  masked: string,
  errorStart: number,
  endedEarly: boolean,
): { message: string; span: SourceSpan } | null {
  const opens: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') opens.push(i);
    else if (masked[i] === ')') {
      if (opens.length > 0) {
        opens.pop();
        continue;
      }
      if (i !== errorStart) return null;
      const at = lineColumnAt(sql, i);
      return {
        message: `${at.line} 行 ${at.column} 列の「)」に対応する「(」がありません`,
        span: { start: i, end: i + 1 },
      };
    }
  }
  if (!endedEarly || opens.length === 0) return null;
  const open = opens[opens.length - 1]!;
  const at = lineColumnAt(sql, open);
  return { message: `${at.line} 行 ${at.column} 列の「(」が閉じていません`, span: { start: open, end: open + 1 } };
}

/** 後ろに来ると、前の語の項目や条件が抜けていると分かる語 */
const CLAUSE_WORDS =
  'AND|OR|WHERE|GROUP|ORDER|HAVING|FROM|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|UNION|MINUS|INTERSECT|EXCEPT|FETCH|OFFSET|LIMIT|ON|SET';

/**
 * 項目や条件を書き忘れた形。パーサーは次の語を名前として読み、さらに後ろの語でエラーにするので、
 * エラーの位置だけでは原因が分からない。エラーの位置がその形のすぐ後ろ（次の語まで）にあるときだけ原因とみなす
 */
const MISSING_OPERAND_RULES: Array<{ re: RegExp; message: (word: string) => string }> = [
  {
    // `GROUP BY a,` や `SET a = 1, WHERE`。`, FROM` は missingSelectItemCause が先に扱う
    re: new RegExp(String.raw`,\s*(?=$|\)|\b(?:${CLAUSE_WORDS})\b)`, 'gi'),
    message: () => '「,」の後ろに項目がありません。余分な「,」を消してください',
  },
  {
    // `IS NOT` の NOT は条件ではなく NULL などを取るので、次の規則で扱う
    re: new RegExp(String.raw`\b(WHERE|AND|OR|ON|HAVING|(?<!\bIS\s+)NOT)\b\s*(?=$|\)|\b(?:${CLAUSE_WORDS})\b)`, 'gi'),
    message: (word) => `「${word.toUpperCase()}」の後ろに条件がありません`,
  },
  {
    re: new RegExp(String.raw`\b(IS(?:\s+NOT)?)\b\s*(?=$|\)|\b(?:${CLAUSE_WORDS})\b)`, 'gi'),
    message: (word) => `「${word.toUpperCase().replace(/\s+/g, ' ')}」の後ろに NULL などがありません`,
  },
  {
    re: new RegExp(String.raw`\bSET\b\s*(?=$|\b(?:WHERE)\b)`, 'gi'),
    message: () => '「SET」の後ろに、更新する列と値がありません',
  },
  {
    re: new RegExp(String.raw`\bFROM\b\s*(?=$|\b(?:${CLAUSE_WORDS})\b)`, 'gi'),
    message: () => '「FROM」の後ろにテーブルがありません',
  },
  {
    re: new RegExp(String.raw`\bBY\b\s*(?=$|\b(?:${CLAUSE_WORDS})\b)`, 'gi'),
    message: () => '「BY」の後ろに項目がありません',
  },
  {
    // `WITHIN GROUP (ORDER BY …)` の GROUP は BY を取らない
    re: /(?<!\bWITHIN\s+)\b(GROUP|ORDER)\b(?!\s+(?:SIBLINGS\s+)?BY\b)/gi,
    message: (word) => `「${word.toUpperCase()}」の後ろに BY がありません`,
  },
  {
    re: /\bIN\s*\(\s*\)/gi,
    message: () => '「IN ( )」の括弧の中に値がありません',
  },
];

function missingOperandCause(
  sql: string,
  masked: string,
  errorStart: number,
): { message: string; span: SourceSpan } | null {
  for (const { re, message } of MISSING_OPERAND_RULES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      if (match.index > errorStart) break;
      // 一致の後ろの語（エラーの原因になった語）の終わりと、その後ろの空白まで
      let end = match.index + match[0].length;
      end += /^(?:[\w$#]+|\))?/.exec(masked.slice(end))![0].length;
      end += /^\s*/.exec(masked.slice(end))![0].length;
      if (errorStart > end) continue;
      const at = lineColumnAt(sql, match.index);
      const word = (match[1] ?? match[0]).trim();
      return {
        message: `${at.line} 行 ${at.column} 列の${message(word)}`,
        span: { start: match.index, end: match.index + Math.max(1, word.length) },
      };
    }
  }
  return null;
}

/**
 * 列を書き忘れた SELECT（`SELECT FROM t`、`SELECT a, FROM t`）。パーサーは FROM を列の名前として読み、
 * その後ろの語でエラーにするので、エラーの位置だけでは原因が分からない
 */
function missingSelectItemCause(
  sql: string,
  masked: string,
  errorStart: number,
): { message: string; span: SourceSpan } | null {
  const re = /\bSELECT(\s+(?:(?:DISTINCT|DISTINCTROW|ALL)\s+)?)FROM\b|,(\s*)FROM\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    if (match.index > errorStart) break;
    const at = lineColumnAt(sql, match.index);
    if (match[0].startsWith(',')) {
      return {
        message: `${at.line} 行 ${at.column} 列の「,」の後ろに列がありません。最後の列の後ろの「,」を消してください`,
        span: { start: match.index, end: match.index + 1 },
      };
    }
    return {
      message: `${at.line} 行 ${at.column} 列の SELECT の後ろに、表示する列がありません。列の名前か * を書いてください`,
      span: { start: match.index, end: match.index + 'SELECT'.length },
    };
  }
  return null;
}

export function translateParserMessage(message: string): string {
  const reserved = /^Error: "(.+)" is a reserved word, can not as alias clause$/.exec(message);
  if (reserved) {
    return `「${reserved[1]}」は予約語なので、そのままでは別名に使えません。別名にするならバッククォート（\`）で囲んでください`;
  }
  return message;
}

/**
 * node-sql-parser（peggy）の構文エラーの文 `Expected "#", "$", ... but "x" found.` から、見つかった文字を取り出す。
 * 入力の終わりで止まったときは null、この形の文でなければ undefined を返す。
 * 文の大半は期待していた字句の一覧（数百文字の英語）で、そのまま出すと読めず、スクリーンリーダーも全部読み上げる
 */
export function syntaxErrorFound(message: string): string | null | undefined {
  const match = /^Expected .* but (end of input|"((?:[^"\\]|\\.)*)") found\.$/s.exec(message);
  if (!match) return undefined;
  if (match[1] === 'end of input') return null;
  try {
    return JSON.parse(`"${match[2]}"`) as string;
  } catch {
    return match[2];
  }
}

/** オフセットを 1 始まりの行・列に変える */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

/**
 * node-sql-parser の構文エラー（location 付き）を、入力 sql 上の範囲に変える。
 * location は前処理後の SQL 上のオフセットなので、対応表で入力の座標へ戻す。
 * 入力の末尾で文が途切れたときは、最後の空白でない 1 文字を範囲にする（長さ 0 だとエディタに印を描けない）
 */
function syntaxErrorSpan(
  err: unknown,
  processedToInput: number[],
  sql: string,
): SourceSpan | undefined {
  const location = (err as { location?: { start?: { offset?: unknown }; end?: { offset?: unknown } } })
    ?.location;
  const startOffset = location?.start?.offset;
  if (typeof startOffset !== 'number') return undefined;
  const endOffset = typeof location?.end?.offset === 'number' ? location.end.offset : startOffset;

  const contentEnd = sql.trimEnd().length;
  if (contentEnd === 0) return undefined;
  const toInput = (offset: number): number =>
    offset < processedToInput.length ? processedToInput[offset]! : contentEnd;

  const start = toInput(startOffset);
  if (start >= contentEnd) return { start: contentEnd - 1, end: contentEnd };
  const end = Math.min(Math.max(toInput(endOffset), start + 1), contentEnd);
  return { start, end };
}

export const SAMPLE_SQL = `SELECT
  u.id,
  u.name,
  u.email,
  o.order_no,
  o.total_amount,
  p.product_name,
  c.category_name,
  lm.metric_score,
  hot.order_cnt
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
INNER JOIN products p ON p.id = oi.product_id AND (p.status = 'active' OR p.clearance = 1)
LEFT JOIN line_metrics lm ON lm.user_id = u.id AND lm.order_id = o.id AND lm.product_id = p.id
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
  AND p.category_id IN (
    SELECT c2.id FROM categories c2
    WHERE c2.active = 1
      AND EXISTS (
        SELECT 1 FROM category_stats cs
        WHERE cs.category_id = c2.id AND cs.product_cnt > 0
      )
  )
  AND oi.quantity BETWEEN 1 AND 10
  AND EXISTS (
    SELECT 1 FROM payments pay
    INNER JOIN payment_methods pm ON pm.id = pay.method_id
    WHERE pay.order_id = o.id AND pay.status = 'paid' AND pm.enabled = 1
  )
  AND u.id NOT IN (
    SELECT bu.user_id FROM banned_users bu
    WHERE bu.banned_at >= '2023-01-01'
      OR bu.reason IN (SELECT code FROM ban_reasons WHERE severity = 'high')
  )
GROUP BY u.id, u.name, u.email, o.order_no, o.total_amount, p.product_name, c.category_name, lm.metric_score, hot.order_cnt
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
  AND oi.quantity BETWEEN 1 AND 100;`;

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
  AND u.email NOT LIKE '%@keep.example';`;

export const UNION_SAMPLE_SQL = `SELECT
  u.id,
  u.name,
  u.email,
  o.order_no,
  o.total_amount,
  'active' AS source
FROM users u
INNER JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
INNER JOIN products p ON p.id = oi.product_id
WHERE u.status = 'active'
  AND o.created_at >= '2024-01-01'
  AND o.total_amount > (
    SELECT AVG(total_amount) FROM orders WHERE status = 'completed'
  )
  AND EXISTS (
    SELECT 1 FROM payments pay
    INNER JOIN payment_methods pm ON pm.id = pay.method_id
    WHERE pay.order_id = o.id AND pay.status = 'paid' AND pm.enabled = 1
  )
GROUP BY u.id, u.name, u.email, o.order_no, o.total_amount
HAVING COUNT(oi.id) > 0

UNION ALL

SELECT
  au.id,
  au.name,
  au.email,
  NULL AS order_no,
  0 AS total_amount,
  'archived' AS source
FROM archived_users au
LEFT JOIN user_profiles up ON up.user_id = au.id
INNER JOIN (
  SELECT user_id, MAX(archived_at) AS last_archived
  FROM audit_log
  WHERE action = 'archive'
  GROUP BY user_id
) al ON al.user_id = au.id
WHERE au.archived_at IS NOT NULL
  AND au.id IN (
    SELECT user_id FROM audit_log
    WHERE action = 'archive' AND details IS NOT NULL
  )

UNION

SELECT
  g.id,
  g.name,
  g.email,
  NULL AS order_no,
  0 AS total_amount,
  'guest' AS source
FROM guest_users g
LEFT JOIN guest_sessions gs ON gs.guest_id = g.id
WHERE g.trial_ends_at < NOW()
  AND gs.last_seen_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
  AND NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = g.id
  )
  AND g.id NOT IN (
    SELECT guest_id FROM converted_guests WHERE converted_at IS NOT NULL
  );`;

export { exprToString };
