/**
 * node-sql-parser（5.4.0 の MySQL ビルド）の論理演算子の優先順位の誤りを直す。
 *
 * WHERE・ON・HAVING の中で、AND と OR を同じ優先順位として左から結び付ける。
 * `a = 1 OR b = 2 AND c = 3` が `(a = 1 OR b = 2) AND c = 3` の木になり、
 * MySQL の意味（`a = 1 OR (b = 2 AND c = 3)`）と違う条件として表示・比較してしまう。
 * MySQL の優先順位は AND（&&）> XOR > OR（||）（MySQL 8.4 リファレンス 14.4.1 Operator Precedence）。
 *
 * 括弧の無い論理演算の並びを左から順に取り出し、優先順位どおりに組み直す。
 * 括弧で囲んだ式（parentheses: true）は 1 つのかたまりとして扱う。正しく組まれた木を組み直しても形は変わらない。
 */

type AstNode = Record<string, unknown> & {
  type?: unknown;
  operator?: unknown;
  left?: unknown;
  right?: unknown;
  parentheses?: unknown;
  loc?: { start: { offset: number; line?: number; column?: number }; end: { offset: number; line?: number; column?: number } };
};

/** 優先順位の低い順 */
const LOGICAL_LEVELS: string[][] = [['OR', '||'], ['XOR'], ['AND', '&&']];
const LOGICAL_OPERATORS = new Set(LOGICAL_LEVELS.flat());

function isNode(value: unknown): value is AstNode {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logicalOperator(node: unknown): string | null {
  if (!isNode(node) || node.type !== 'binary_expr' || typeof node.operator !== 'string') return null;
  const op = node.operator.toUpperCase();
  return LOGICAL_OPERATORS.has(op) ? op : null;
}

/** 括弧の無い論理演算の並びを、オペランドと演算子が交互に並ぶ列にする */
function flatten(node: AstNode, items: Array<AstNode | string>, isRoot: boolean): void {
  const op = logicalOperator(node);
  if (op === null || (!isRoot && node.parentheses)) {
    items.push(node);
    return;
  }
  flatten(node.left as AstNode, items, false);
  items.push(node.operator as string);
  flatten(node.right as AstNode, items, false);
}

function joinLoc(left: AstNode, right: AstNode): AstNode['loc'] {
  if (!left.loc || !right.loc) return left.loc ?? right.loc;
  return { start: left.loc.start, end: right.loc.end };
}

function build(items: Array<AstNode | string>): AstNode {
  for (const level of LOGICAL_LEVELS) {
    const splitAt: number[] = [];
    for (let i = 1; i < items.length; i += 2) {
      if (level.includes((items[i] as string).toUpperCase())) splitAt.push(i);
    }
    if (splitAt.length === 0) continue;
    let start = 0;
    let result: AstNode | null = null;
    let pendingOperator = '';
    for (const index of [...splitAt, items.length]) {
      const segment = build(items.slice(start, index));
      result = result
        ? { type: 'binary_expr', operator: pendingOperator, left: result, right: segment, loc: joinLoc(result, segment) }
        : segment;
      pendingOperator = items[index] as string;
      start = index + 1;
    }
    return result!;
  }
  return items[0] as AstNode;
}

/** node の中の論理演算の並びを、MySQL の優先順位どおりに組み直す（node をその場で書き換える） */
export function fixLogicalOperatorPrecedence(root: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as AstNode;
    if (logicalOperator(node) !== null) {
      const items: Array<AstNode | string> = [];
      flatten(node, items, true);
      if (items.length > 3) {
        const rebuilt = build(items);
        // 並び全体の範囲と括弧の印は、元の根の値を残す
        node.operator = rebuilt.operator;
        node.left = rebuilt.left;
        node.right = rebuilt.right;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(root);
}

const COMPARISON_OR_ARITHMETIC = /^(?:=|<=>|<>|!=|<|<=|>|>=|\+|-|\*|\/|%|DIV|MOD|LIKE|NOT LIKE|REGEXP|NOT REGEXP|RLIKE|IS|IS NOT|IN|NOT IN)$/i;

/**
 * `||` `&&` `XOR` を、比較や算術より強く結び付けた木を見つける。MySQL ではこれらは比較より弱いので、
 * 括弧の無い論理演算が比較の片側に来ることはない。見つけたら、その演算子を返す（無ければ null）。
 * 組み直しでは直せない（比較との境目から誤っている）ので、呼び出し側でエラーにする
 */
export function findMisboundLogicalOperator(root: unknown): string | null {
  const seen = new WeakSet<object>();
  let found: string | null = null;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as AstNode;
    if (node.type === 'binary_expr' && typeof node.operator === 'string' && COMPARISON_OR_ARITHMETIC.test(node.operator)) {
      for (const side of [node.left, node.right]) {
        const op = logicalOperator(side);
        if (op !== null && !(side as AstNode).parentheses) {
          found = op;
          return;
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(root);
  return found;
}
