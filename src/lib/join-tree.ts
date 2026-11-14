/**
 * FROM 句の結合を木として組み立て、結果を変えない書き換えだけで正規化した比較用の文字列を作る。
 *
 * FROM 句は左から順に結合する木（left-deep）として評価される。
 * `a JOIN x ON … LEFT JOIN b ON …` は ((a ⋈ x) ⟕ b) で、行を残す側は直前の x だけではなく a ⋈ x 全体になる。
 * 結合を「直前のテーブル → 結合先」の辺の集合として比べると、この違いが消えて、
 * 行を残す側が違うクエリ（RIGHT JOIN の書き換えなど）を同じと判定してしまう。
 *
 * 正規化に使う書き換えは次の 4 つで、いずれも結果を変えない。
 * 1. 内部結合（INNER / CROSS / STRAIGHT_JOIN / カンマ）は、並べ替えても結果が変わらないまとまりとして扱う。
 *    ON の条件はまとまり全体の条件として集める（内部結合では、どの ON に書いても同じ）
 * 2. RIGHT JOIN は、左右を入れ替えた LEFT JOIN として扱う
 * 3. 内部結合のまとまりに入った外部結合 (B ⟕ N) は、まとまりの条件が N を読まないときに限り外へ出す。
 *    (B ⟕ N) ⋈ C = (B ⋈ C) ⟕ N
 * 4. 同じ base に付いた外部結合は、互いの条件が相手の NULL で埋まる側を読まないときに限り並べ替える
 *
 * 条件がどのテーブルを読むかが分からないとき（修飾の無い列など）は、3 と 4 の書き換えをしない。
 * 書き換えずに比べると、同じ結果になるクエリを「異なる」とすることはあっても、逆にはならない。
 */
import type { JoinEdge, ParsedQuery } from './types';

/** 条件の 1 項（AND でつながった 1 つ）。tables は読むテーブルのキー。分からなければ 'unknown' */
export interface JoinCondition {
  signature: string;
  tables: ReadonlySet<string> | 'unknown';
}

export type JoinKind = 'inner' | 'left' | 'right' | { fixed: string };

export interface JoinTreeHelpers {
  /** テーブル参照の比較用キー */
  tableKey(tableId: string): string;
  /** 結合の種類。NATURAL JOIN や FULL JOIN のように並べ替えられないものは fixed */
  kind(join: JoinEdge): JoinKind;
  /** ON / USING の条件を、AND でつながった項に分けたもの */
  conditions(join: JoinEdge): JoinCondition[];
}

interface Leaf {
  kind: 'leaf';
  key: string;
}

interface Inner {
  kind: 'inner';
  members: JoinNode[];
  conditions: JoinCondition[];
}

/** 外部結合で NULL で埋まる側と、その結合条件 */
interface Attachment {
  nullable: JoinNode;
  conditions: JoinCondition[];
}

/** base の行をすべて残し、attachments を順に外部結合したもの */
interface Outer {
  kind: 'outer';
  base: JoinNode;
  attachments: Attachment[];
}

/** 並べ替えない結合（NATURAL JOIN、FULL JOIN） */
interface Fixed {
  kind: 'fixed';
  label: string;
  left: JoinNode;
  right: JoinNode;
  conditions: JoinCondition[];
}

type JoinNode = Leaf | Inner | Outer | Fixed;

function tablesOf(node: JoinNode): Set<string> {
  switch (node.kind) {
    case 'leaf':
      return new Set([node.key]);
    case 'inner':
      return new Set(node.members.flatMap((m) => [...tablesOf(m)]));
    case 'outer':
      return new Set([
        ...tablesOf(node.base),
        ...node.attachments.flatMap((a) => [...tablesOf(a.nullable)]),
      ]);
    case 'fixed':
      return new Set([...tablesOf(node.left), ...tablesOf(node.right)]);
  }
}

/** 条件のどれかが tables のテーブルを読むか。読むテーブルが分からない条件は「読む」とみなす */
function readsAny(conditions: JoinCondition[], tables: Set<string>): boolean {
  return conditions.some(
    (c) => c.tables === 'unknown' || [...c.tables].some((key) => tables.has(key)),
  );
}

function addInner(current: JoinNode, node: JoinNode, conditions: JoinCondition[]): Inner {
  if (current.kind === 'inner') {
    return { kind: 'inner', members: [...current.members, node], conditions: [...current.conditions, ...conditions] };
  }
  return { kind: 'inner', members: [current, node], conditions };
}

function addOuter(base: JoinNode, attachment: Attachment): Outer {
  if (base.kind === 'outer') {
    return { kind: 'outer', base: base.base, attachments: [...base.attachments, attachment] };
  }
  return { kind: 'outer', base, attachments: [attachment] };
}

/** FROM 句の順に、左から結合する木を組み立てる。形が想定と違えば null */
function buildTree(query: ParsedQuery, helpers: JoinTreeHelpers): JoinNode | null {
  const [first, ...rest] = query.tables;
  if (!first) return null;
  if (query.joins.length !== rest.length) return null;

  let current: JoinNode = { kind: 'leaf', key: helpers.tableKey(first.id) };
  for (let i = 0; i < query.joins.length; i += 1) {
    const join = query.joins[i]!;
    if (join.targetId !== rest[i]!.id) return null;
    const target: Leaf = { kind: 'leaf', key: helpers.tableKey(join.targetId) };
    const conditions = helpers.conditions(join);
    const kind = helpers.kind(join);

    if (kind === 'inner') {
      current = addInner(current, target, conditions);
    } else if (kind === 'left') {
      current = addOuter(current, { nullable: target, conditions });
    } else if (kind === 'right') {
      // 右のテーブルの行をすべて残し、左の結合全体が NULL で埋まる
      current = { kind: 'outer', base: target, attachments: [{ nullable: current, conditions }] };
    } else {
      current = { kind: 'fixed', label: kind.fixed, left: current, right: target, conditions };
    }
  }
  return current;
}

function normalize(node: JoinNode): JoinNode {
  switch (node.kind) {
    case 'leaf':
      return node;
    case 'fixed':
      return { ...node, left: normalize(node.left), right: normalize(node.right) };
    case 'outer':
      return normalizeOuter(node);
    case 'inner':
      return normalizeInner(node);
  }
}

function normalizeInner(node: Inner): JoinNode {
  // 入れ子の内部結合のまとまりは 1 つにまとめる
  const members: JoinNode[] = [];
  const conditions = [...node.conditions];
  for (const member of node.members.map(normalize)) {
    if (member.kind === 'inner') {
      members.push(...member.members);
      conditions.push(...member.conditions);
    } else {
      members.push(member);
    }
  }

  // 書き換え 3: まとまりの条件が NULL で埋まる側を読まない外部結合は、まとまりの外へ出す
  const index = members.findIndex(
    (m) =>
      m.kind === 'outer' &&
      !readsAny(conditions, new Set(m.attachments.flatMap((a) => [...tablesOf(a.nullable)]))),
  );
  if (index >= 0) {
    const outer = members[index] as Outer;
    const rest = members.filter((_, i) => i !== index);
    const inner: Inner = { kind: 'inner', members: [outer.base, ...rest], conditions };
    return normalize({ kind: 'outer', base: inner, attachments: outer.attachments });
  }

  return { kind: 'inner', members, conditions };
}

function normalizeOuter(node: Outer): JoinNode {
  let base = normalize(node.base);
  let attachments = node.attachments.map((a) => ({ ...a, nullable: normalize(a.nullable) }));
  if (base.kind === 'outer') {
    attachments = [...base.attachments, ...attachments];
    base = base.base;
  }

  // 書き換え 4: 互いの条件が相手の NULL で埋まる側を読まなければ、外部結合の順は結果に影響しない
  const independent = attachments.every((a, i) =>
    attachments.every((b, j) => i === j || !readsAny(a.conditions, tablesOf(b.nullable))),
  );
  if (independent) {
    attachments = [...attachments].sort((a, b) => renderAttachment(a).localeCompare(renderAttachment(b)));
  }
  return { kind: 'outer', base, attachments };
}

function renderConditions(conditions: JoinCondition[]): string {
  return conditions.map((c) => c.signature).sort().join('&');
}

function renderAttachment(attachment: Attachment): string {
  return `${render(attachment.nullable)}~${renderConditions(attachment.conditions)}`;
}

function render(node: JoinNode): string {
  switch (node.kind) {
    case 'leaf':
      return node.key;
    case 'inner':
      return `I(${node.members.map(render).sort().join(',')}|${renderConditions(node.conditions)})`;
    case 'outer':
      return `L(${render(node.base)}|${node.attachments.map(renderAttachment).join(';')})`;
    case 'fixed':
      return `${node.label}(${render(node.left)}|${render(node.right)}|${renderConditions(node.conditions)})`;
  }
}

/**
 * 結合の木を正規化した比較用の文字列。2 つのクエリでこれが同じなら、FROM 句の結合は同じ行を作る。
 * テーブルが 1 つも無いときは空文字、木を組み立てられないときは null（呼び出し側で別の比較を使う）
 */
export function joinTreeSignature(query: ParsedQuery, helpers: JoinTreeHelpers): string | null {
  if (query.tables.length === 0) return '';
  const tree = buildTree(query, helpers);
  return tree ? render(normalize(tree)) : null;
}
