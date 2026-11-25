/**
 * 合接クエリ（Conjunctive Query）断片に限定した等価性の証明。
 *
 * SQL 全体の意味等価は決定不能だが、
 *   - INNER 相当の JOIN のみ
 *   - AND と `=` のみの条件
 *   - 相関 EXISTS（半結合）
 *   - 修飾済みの単純な列参照だけの SELECT
 * に限れば合接クエリとなり、準同型写像の相互存在で等価性を判定できる（Chandra-Merlin）。
 *
 * `=` は推移的な等号として扱わず、書かれた等式そのものを対称な述語として比べる。
 * MySQL の `=` は型が違うと推移律が成り立たず（`'1.0' = 1` と `1 = '1'` は真、`'1.0' = '1'` は偽）、
 * NULL では反射律も成り立たない（`a.id = a.id` は id が NULL の行で真にならない）。
 * 等式から列を同じ変数にまとめると、`a.s = b.n AND b.n = c.s` に `a.s = c.s` を足したクエリや、
 * `users a, users b WHERE a.id = b.id` と `users a` を「同じ」と証明してしまう。
 * 等式を述語のまま扱えば、`=` がどう評価されても準同型による証明は成り立つ。
 *
 * 安全側の原則:
 *   1. 許可リスト方式。少しでも対象外の構文があれば即 not-proven
 *   2. 探索予算を超えたら not-proven（タイムアウトで「同じ」と言わない）
 *   3. 証明できたときだけ結果を上げる。既存の構文差分判定は書き換えない
 */
import { NO_JOIN_CONDITION } from './join-condition';
import { findCodeRegions, maskNonCode } from './sql-lex';
import type { ConditionNode, JoinEdge, ParsedQuery, TableRef } from './types';

/** 1クエリあたりのアトム（テーブル参照）上限 */
export const MAX_CQ_ATOMS = 8;
/** 準同型探索のステップ上限 */
export const MAX_CQ_SEARCH_STEPS = 20000;
/**
 * 1 クエリあたりの条件（等式）と出力列の上限。探索は候補ごとに変数の対応表を写すので、
 * 条件や出力列が数百あると、ステップ上限の前に 1 秒以上かかり、比較のたびに画面が止まる
 */
export const MAX_CQ_CONDITIONS = 32;
export const MAX_CQ_OUTPUT_COLUMNS = 32;

export type CqEquivalenceStatus =
  | 'proven-equivalent'
  | 'proven-equivalent-set-only'
  | 'not-proven';

export interface CqEquivalenceResult {
  status: CqEquivalenceStatus;
  /** not-proven の理由、または証明の但し書き */
  reason?: string;
}

const NOT_PROVEN = (reason: string): CqEquivalenceResult => ({ status: 'not-proven', reason });

const ALLOWED_JOIN_TYPES = new Set(['INNER JOIN', 'JOIN', 'STRAIGHT JOIN', 'CROSS JOIN']);
/** 等式の述語に使う関係名。テーブル名は識別子なので `=` とは重ならない */
const EQUALITY_RELATION = '=';

const EMPTY_JOIN_CONDITIONS = new Set(['', NO_JOIN_CONDITION]);

const IDENT = String.raw`(?:\`[^\`]+\`|[A-Za-z_][A-Za-z0-9_$]*)`;
const COLUMN_REF_RE = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)\\.(${IDENT})$`);

function normIdent(text: string): string {
  return text.trim().replace(/`/g, '').toLowerCase();
}

interface ColumnRef {
  qualifier: string;
  column: string;
}

/** `u.id` / `db.users.id` のような修飾済み列参照だけを受け付ける */
function parseColumnRef(text: string | undefined): ColumnRef | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(COLUMN_REF_RE);
  if (!match) return null;
  return { qualifier: normIdent(match[1]!), column: normIdent(match[2]!) };
}

/**
 * 比較可能なリテラルのみ受け付ける。
 * NULL / TRUE / FALSE / プレースホルダ / 二重引用符は対象外（NULL 三値論理・ANSI_QUOTES 回避）。
 */
function parseLiteral(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) return `n:${trimmed}`;
  if (/^-?\d+\.\d+$/.test(trimmed)) return `n:${trimmed}`;
  if (/^'(?:[^'\\]|\\.|'')*'$/.test(trimmed)) return `s:${trimmed}`;
  return null;
}

/**
 * 構文木のガードとは独立した、元 SQL の字句レベルの二重チェック。
 * パーサが構文の一部を落としても「同じ」と言わないための保険なので、
 * 対象クラスで使わない予約語・演算子が 1 つでもあれば拒否する。
 */
const DISALLOWED_KEYWORDS = new Set([
  'all', 'any', 'avg', 'between', 'binary', 'case', 'cast', 'coalesce', 'collate', 'convert',
  'count', 'dense_rank', 'group_concat', 'max', 'min', 'rank', 'row_number', 'stddev', 'sum',
  'variance',
  // 集約関数の残り（MySQL 8.4 リファレンス 14.19.1）。GROUP BY が無ければ行が無くても 1 行を返す
  'bit_and', 'bit_or', 'bit_xor', 'json_arrayagg', 'json_objectagg', 'std', 'stddev_pop',
  'stddev_samp', 'var_pop', 'var_samp',
  'div', 'else', 'end', 'escape', 'except', 'false', 'for', 'full', 'group', 'having',
  'if', 'ifnull', 'ignore', 'in', 'intersect', 'interval', 'into', 'is', 'lateral',
  'left', 'like', 'limit', 'lock', 'mod', 'natural', 'not', 'null', 'nullif', 'offset',
  'or', 'outer', 'over', 'partition', 'procedure', 'recursive', 'regexp', 'right',
  'rlike', 'share', 'some', 'sounds', 'then', 'true', 'union', 'unknown', 'using',
  'values', 'when', 'window', 'with', 'xor',
]);

/** 対象クラスで現れうる文字だけを許可する（比較・算術・論理演算子は一切許さない） */
const ALLOWED_CHARS_RE = /^[A-Za-z0-9_$.,()=*\-;\s]*$/;

function isLexicallyInScope(rawSql: string | undefined): boolean {
  if (!rawSql || rawSql.trim().length === 0) return false;
  // 文字列リテラル・コメント・バッククォート識別子は空白化されるので走査対象外になる
  const masked = maskNonCode(rawSql);
  if (!ALLOWED_CHARS_RE.test(masked)) return false;
  for (const token of masked.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []) {
    if (DISALLOWED_KEYWORDS.has(token.toLowerCase())) return false;
  }
  // 0x41 / 0b101 は数値に見えるが、16 進と 2 進の値（0x41 は 65）
  if (/(?<![\w$])0[xb][0-9a-f]/i.test(masked)) return false;
  // 接頭辞の付くリテラル（b'101'、X'41'、N'abc'、_binary'x'、DATE '2024-01-01'）は、
  // 引用符の中が同じでも普通の文字列とは値や照合順序が違う
  for (const region of findCodeRegions(rawSql)) {
    const next = rawSql[region.end];
    if (next !== "'" && next !== '"') continue;
    if (/(?:[\w$]|\b(?:date|time|timestamp|datetime)\s+)$/i.test(rawSql.slice(region.start, region.end))) {
      return false;
    }
  }
  return true;
}

interface BuilderAtom {
  atomId: string;
  relation: string;
  /** 列名 → 変数キー */
  columns: Map<string, string>;
}

interface Scope {
  qualifiers: Map<string, string>;
  parent?: Scope;
}

function lookupQualifier(scope: Scope | undefined, qualifier: string): string | null {
  let current = scope;
  while (current) {
    const atomId = current.qualifiers.get(qualifier);
    if (atomId) return atomId;
    current = current.parent;
  }
  return null;
}

interface RawCq {
  atoms: BuilderAtom[];
  /** 列どうしの等式（変数キーの組） */
  equalities: Array<[string, string]>;
  /** 列とリテラルの等式（変数キー, リテラル） */
  constBindings: Array<[string, string]>;
  /** 出力列ごとの変数キー */
  head: string[];
  headNames: string[];
  distinct: boolean;
  /** EXISTS を含む（多重集合意味論では body アトム化が使えない） */
  hasExists: boolean;
}

class CqBuilder {
  atoms: BuilderAtom[] = [];
  equalities: Array<[string, string]> = [];
  constBindings: Array<[string, string]> = [];
  headKeys: string[] = [];
  headNames: string[] = [];
  hasExists = false;
  private nextAtom = 0;

  addTable(table: TableRef, scope: Scope): string | null {
    if (table.isDerived) return null;
    const atomId = `a${this.nextAtom++}`;
    // テーブル名は大文字小文字を区別する。Linux の MySQL（lower_case_table_names=0）では
    // `Users` と `users` は別のテーブル
    const relation = (table.schema ? `${table.schema}.${table.table}` : table.table).replace(/`/g, '').trim();
    this.atoms.push({ atomId, relation, columns: new Map() });

    const keys: string[] = [];
    if (table.alias) {
      // MySQL ではエイリアスを付けると元テーブル名では参照できない
      keys.push(normIdent(table.alias));
    } else {
      keys.push(normIdent(table.table));
      if (table.schema) keys.push(normIdent(`${table.schema}.${table.table}`));
    }
    for (const key of keys) {
      if (scope.qualifiers.has(key)) return null;
      scope.qualifiers.set(key, atomId);
    }
    return atomId;
  }

  /** 列参照を変数キーへ。解決できなければ null */
  columnKey(ref: ColumnRef, scope: Scope): string | null {
    const atomId = lookupQualifier(scope, ref.qualifier);
    if (!atomId) return null;
    const atom = this.atoms.find((a) => a.atomId === atomId);
    if (!atom) return null;
    const key = `${atomId}.${ref.column}`;
    atom.columns.set(ref.column, key);
    return key;
  }
}

type BuildFailure = { ok: false; reason: string };
type BuildSuccess = { ok: true; cq: RawCq };

/** 対象クラス外の構文を検出したら理由を返す */
function checkQueryGuards(query: ParsedQuery, isSubquery: boolean): string | null {
  if (query.statementType !== 'SELECT') return 'SELECT 以外の文は対象外です';
  if (query.unionBranches?.length) return 'UNION は対象外です';
  if (query.ctes?.length) return 'CTE (WITH) は対象外です';
  if (query.groupBy.length > 0) return 'GROUP BY は対象外です';
  if (query.having) return 'HAVING は対象外です';
  if (query.limit || query.offset) return 'LIMIT / OFFSET は対象外です';
  if (query.tables.length === 0) return 'FROM 句のないクエリは対象外です';
  if (query.tables.some((t) => t.isDerived)) return '派生テーブルは対象外です';
  if (!isSubquery && query.columns.length === 0) return '出力列を特定できません';
  for (const join of query.joins) {
    if (join.isNatural) return 'NATURAL JOIN は対象外です';
    if (!ALLOWED_JOIN_TYPES.has(join.type)) return `${join.type} は対象外です（INNER 相当のみ）`;
  }
  return null;
}

function joinConditionRoot(join: JoinEdge): ConditionNode | null | 'reject' {
  if (join.conditionRoot) return join.conditionRoot;
  const condition = (join.condition ?? '').trim();
  if (EMPTY_JOIN_CONDITIONS.has(condition)) return null;
  return 'reject';
}

/** AND と `=` 比較、正の EXISTS のみを受け付けて等式・定数束縛を収集する */
function collectCondition(
  builder: CqBuilder,
  node: ConditionNode | undefined,
  scope: Scope,
): string | null {
  if (!node) return null;

  if (node.type === 'and') {
    for (const child of node.children ?? []) {
      const failure = collectCondition(builder, child, scope);
      if (failure) return failure;
    }
    return null;
  }

  if (node.type === 'comparison') {
    if ((node.operator ?? '').trim() !== '=') {
      return `${node.operator ?? '比較'} 演算子は対象外です（= のみ）`;
    }
    const leftRef = parseColumnRef(node.left);
    const rightRef = parseColumnRef(node.right);
    const leftLit = leftRef ? null : parseLiteral(node.left);
    const rightLit = rightRef ? null : parseLiteral(node.right);

    if (leftRef && rightRef) {
      const a = builder.columnKey(leftRef, scope);
      const b = builder.columnKey(rightRef, scope);
      if (!a || !b) return '解決できない列参照があります（修飾が必要です）';
      builder.equalities.push([a, b]);
      return null;
    }
    if (leftRef && rightLit) {
      const key = builder.columnKey(leftRef, scope);
      if (!key) return '解決できない列参照があります（修飾が必要です）';
      builder.constBindings.push([key, rightLit]);
      return null;
    }
    if (rightRef && leftLit) {
      const key = builder.columnKey(rightRef, scope);
      if (!key) return '解決できない列参照があります（修飾が必要です）';
      builder.constBindings.push([key, leftLit]);
      return null;
    }
    return '列参照とリテラルの等値比較以外は対象外です';
  }

  if (node.type === 'exists') {
    if (normIdent(node.label).startsWith('not exists')) return 'NOT EXISTS は対象外です';
    const nested = node.nestedQuery;
    if (!nested) return 'EXISTS の内容を解析できません';
    builder.hasExists = true;
    return addQueryBody(builder, nested, scope, true);
  }

  return `${node.type} 条件は対象外です（AND と = のみ）`;
}

/** テーブル・JOIN・WHERE を読み取り、アトムと等式を builder に足す */
function addQueryBody(
  builder: CqBuilder,
  query: ParsedQuery,
  parentScope: Scope | undefined,
  isSubquery: boolean,
): string | null {
  const guard = checkQueryGuards(query, isSubquery);
  if (guard) return guard;

  const scope: Scope = { qualifiers: new Map(), parent: parentScope };
  for (const table of query.tables) {
    if (builder.atoms.length >= MAX_CQ_ATOMS) {
      return `テーブル参照が多すぎます（上限 ${MAX_CQ_ATOMS}）`;
    }
    const atomId = builder.addTable(table, scope);
    if (!atomId) return 'テーブル参照を一意に解決できません';
  }

  for (const join of query.joins) {
    const root = joinConditionRoot(join);
    if (root === 'reject') return 'ON 条件を構造として解析できません';
    const failure = collectCondition(builder, root ?? undefined, scope);
    if (failure) return failure;
  }

  const whereFailure = collectCondition(builder, query.where, scope);
  if (whereFailure) return whereFailure;

  if (isSubquery) {
    // EXISTS は列の値を見ない。ただし GROUP BY の無いサブクエリの列に集約関数があると、
    // 条件に合う行が無くても 1 行を返し、EXISTS が常に真になる。行の数を変えない列（列の参照・リテラル・*）だけを通す
    for (const column of query.columns) {
      const expression = column.expression.trim();
      if (expression === '*' || /\.\*$/.test(expression)) continue;
      if (parseColumnRef(expression) || parseLiteral(expression)) continue;
      return 'EXISTS の中の SELECT の列は、列の参照・リテラル・* のみ対象です';
    }
  } else {
    for (const column of query.columns) {
      const ref = parseColumnRef(column.expression);
      if (!ref) return '出力列は修飾済みの単純な列参照のみ対象です';
      const key = builder.columnKey(ref, scope);
      if (!key) return '出力列のテーブル修飾を解決できません';
      builder.headKeys.push(key);
      builder.headNames.push(normIdent(column.alias ?? ref.column));
    }
  }

  return null;
}

function buildCq(query: ParsedQuery): BuildSuccess | BuildFailure {
  if (!isLexicallyInScope(query.rawSql)) {
    return { ok: false, reason: '対象クラス外のキーワードまたは演算子を含みます' };
  }

  const builder = new CqBuilder();
  const failure = addQueryBody(builder, query, undefined, false);
  if (failure) return { ok: false, reason: failure };
  if (builder.equalities.length + builder.constBindings.length > MAX_CQ_CONDITIONS) {
    return { ok: false, reason: `条件が多すぎます（上限 ${MAX_CQ_CONDITIONS}）` };
  }
  if (builder.headKeys.length > MAX_CQ_OUTPUT_COLUMNS) {
    return { ok: false, reason: `出力列が多すぎます（上限 ${MAX_CQ_OUTPUT_COLUMNS}）` };
  }

  const constOf = new Map<string, string>();
  for (const [key, literal] of builder.constBindings) {
    const existing = constOf.get(key);
    if (existing !== undefined && existing !== literal) {
      return { ok: false, reason: '同じ列に異なる定数が束縛されています' };
    }
    constOf.set(key, literal);
  }

  return {
    ok: true,
    cq: {
      atoms: builder.atoms,
      equalities: builder.equalities,
      constBindings: builder.constBindings,
      head: builder.headKeys,
      headNames: builder.headNames,
      distinct: query.distinct,
      hasExists: builder.hasExists,
    },
  };
}

type Term = { kind: 'var'; id: number } | { kind: 'const'; value: string };

interface MaterialAtom {
  relation: string;
  terms: Term[];
}

interface MaterialCq {
  atoms: MaterialAtom[];
  head: Term[];
}

function termEq(a: Term, b: Term): boolean {
  if (a.kind === 'const') return b.kind === 'const' && a.value === b.value;
  return b.kind === 'var' && a.id === b.id;
}

/**
 * 参照された列だけをアトムの引数にする。
 * 未参照の列は「どこにも現れない新規変数」となり制約を持たないため、
 * 両クエリで参照列の和集合を引数順に固定すれば準同型判定は完全なままになる。
 */
function collectRelationColumns(cqs: RawCq[]): Map<string, string[]> {
  const collected = new Map<string, Set<string>>();
  for (const cq of cqs) {
    for (const atom of cq.atoms) {
      let columns = collected.get(atom.relation);
      if (!columns) {
        columns = new Set();
        collected.set(atom.relation, columns);
      }
      for (const column of atom.columns.keys()) columns.add(column);
    }
  }
  return new Map([...collected].map(([relation, cols]) => [relation, [...cols].sort()]));
}

function materialize(cq: RawCq, relationColumns: Map<string, string[]>): MaterialCq {
  let nextVar = 0;
  const varOfRep = new Map<string, number>();

  const termForRep = (rep: string): Term => {
    let id = varOfRep.get(rep);
    if (id === undefined) {
      id = nextVar++;
      varOfRep.set(rep, id);
    }
    return { kind: 'var', id };
  };

  const atoms = cq.atoms.map((atom) => {
    const columns = relationColumns.get(atom.relation) ?? [];
    const terms = columns.map((column): Term => {
      const rep = atom.columns.get(column);
      if (rep === undefined) return { kind: 'var', id: nextVar++ };
      return termForRep(rep);
    });
    return { relation: atom.relation, terms };
  });

  // `=` は対称なので両方の向きを入れる。`a = b` と `b = a` は同じ述語に写せる
  const equality = (left: Term, right: Term): MaterialAtom[] => [
    { relation: EQUALITY_RELATION, terms: [left, right] },
    { relation: EQUALITY_RELATION, terms: [right, left] },
  ];
  for (const [left, right] of cq.equalities) {
    atoms.push(...equality(termForRep(left), termForRep(right)));
  }
  for (const [key, literal] of cq.constBindings) {
    atoms.push(...equality(termForRep(key), { kind: 'const', value: literal }));
  }

  return { atoms, head: cq.head.map(termForRep) };
}

interface HomState {
  map: Map<number, Term>;
  usedVars: Set<number>;
  steps: number;
}

function bindTerm(state: HomState, from: Term, to: Term, isomorphism: boolean): boolean {
  if (from.kind === 'const') {
    return to.kind === 'const' && to.value === from.value;
  }
  if (isomorphism && to.kind !== 'var') return false;
  const existing = state.map.get(from.id);
  if (existing) return termEq(existing, to);
  if (isomorphism && to.kind === 'var') {
    if (state.usedVars.has(to.id)) return false;
    state.usedVars.add(to.id);
  }
  state.map.set(from.id, to);
  return true;
}

/**
 * from の本体から to の本体への準同型写像を探す（head は対応位置で一致を要求）。
 * isomorphism = true のときはアトム・変数ともに単射に限定する（多重集合意味論用）。
 * 探索予算を超えたら false を返す（＝証明できなかった扱い）。
 */
function hasHomomorphism(from: MaterialCq, to: MaterialCq, isomorphism: boolean): boolean {
  if (from.head.length !== to.head.length) return false;
  if (isomorphism && from.atoms.length !== to.atoms.length) return false;

  const state: HomState = { map: new Map(), usedVars: new Set(), steps: 0 };
  for (let i = 0; i < from.head.length; i += 1) {
    if (!bindTerm(state, from.head[i]!, to.head[i]!, isomorphism)) return false;
  }

  const usedAtoms = new Set<number>();

  const search = (index: number): boolean => {
    if (index === from.atoms.length) return true;
    const atom = from.atoms[index]!;
    for (let j = 0; j < to.atoms.length; j += 1) {
      state.steps += 1;
      if (state.steps > MAX_CQ_SEARCH_STEPS) return false;
      const candidate = to.atoms[j]!;
      if (candidate.relation !== atom.relation) continue;
      if (isomorphism && usedAtoms.has(j)) continue;

      const savedMap = new Map(state.map);
      const savedVars = new Set(state.usedVars);
      let matched = true;
      for (let k = 0; k < atom.terms.length; k += 1) {
        if (!bindTerm(state, atom.terms[k]!, candidate.terms[k]!, isomorphism)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        usedAtoms.add(j);
        if (search(index + 1)) return true;
        usedAtoms.delete(j);
      }
      state.map = savedMap;
      state.usedVars = savedVars;
    }
    return false;
  };

  return search(0);
}

/**
 * 2 本のクエリが合接クエリ断片に収まるとき、結果セットの等価性を証明する。
 * 収まらない場合・証明できない場合は必ず not-proven を返す。
 */
export function proveCqEquivalence(
  queryA: ParsedQuery,
  queryB: ParsedQuery,
): CqEquivalenceResult {
  const builtA = buildCq(queryA);
  if (!builtA.ok) return NOT_PROVEN(`SQL A: ${builtA.reason}`);
  const builtB = buildCq(queryB);
  if (!builtB.ok) return NOT_PROVEN(`SQL B: ${builtB.reason}`);

  const cqA = builtA.cq;
  const cqB = builtB.cq;

  if (cqA.headNames.length !== cqB.headNames.length) {
    return NOT_PROVEN('出力列の数が異なります');
  }
  for (let i = 0; i < cqA.headNames.length; i += 1) {
    if (cqA.headNames[i] !== cqB.headNames[i]) return NOT_PROVEN('出力列名が異なります');
  }

  const relationColumns = collectRelationColumns([cqA, cqB]);
  const materialA = materialize(cqA, relationColumns);
  const materialB = materialize(cqB, relationColumns);

  const setEquivalent =
    hasHomomorphism(materialA, materialB, false) && hasHomomorphism(materialB, materialA, false);
  if (!setEquivalent) {
    return NOT_PROVEN('構文構造からは等価性を導けませんでした');
  }

  if (cqA.distinct && cqB.distinct) {
    return {
      status: 'proven-equivalent',
      reason: '両方が DISTINCT のため、返る行の集合が一致することを証明しました',
    };
  }

  const bagFaithful = !cqA.hasExists && !cqB.hasExists;
  if (!cqA.distinct && !cqB.distinct && bagFaithful) {
    const isomorphic =
      hasHomomorphism(materialA, materialB, true) && hasHomomorphism(materialB, materialA, true);
    if (isomorphic) {
      return {
        status: 'proven-equivalent',
        reason: '重複行の個数まで含めて一致することを証明しました',
      };
    }
  }

  return {
    status: 'proven-equivalent-set-only',
    reason:
      cqA.distinct === cqB.distinct
        ? '重複を除いた集合としての一致を証明しました（重複行の個数は一致するとは限りません）'
        : 'DISTINCT の有無が揃わないため、重複を除いた集合としての一致のみ証明しました',
  };
}
