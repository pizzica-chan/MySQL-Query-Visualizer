export interface SourceSpan {
  start: number;
  end: number;
}

export interface SqlFragment {
  text: string;
  sourceSpan?: SourceSpan;
}

export type JoinType =
  | 'INNER JOIN'
  | 'LEFT JOIN'
  | 'RIGHT JOIN'
  | 'FULL JOIN'
  | 'CROSS JOIN'
  | 'STRAIGHT JOIN'
  | 'JOIN';

export interface CteRef {
  name: string;
  /** `WITH c (p, q) AS (…)` の列名リスト。本体の出力列にこの順で名前を付ける */
  columns?: string[];
  query: ParsedQuery;
  sourceSpan?: SourceSpan;
}

export interface TableRef {
  id: string;
  schema?: string;
  table: string;
  alias?: string;
  displayName: string;
  /** FROM句の派生テーブル `(SELECT ...) AS t` */
  isDerived?: boolean;
  /** `LATERAL (SELECT …) t`。前の表の列を参照でき、前の表の行を処理するたびに作り直される */
  isLateral?: boolean;
  derivedQuery?: ParsedQuery;
  /** 元 SQL 内のテーブル参照位置 */
  sourceSpan?: SourceSpan;
  /** 表の後ろの、読む行を変える指定（`PARTITION (p0)`）。書いた順 */
  modifiers?: TableModifier[];
}

export interface TableModifier {
  kind: 'partition';
  /** SQL に書いたとおりの指定（空白は 1 つにまとめる） */
  text: string;
  sourceSpan: SourceSpan;
}

export interface UnionBranch {
  id: string;
  /** 先頭ブランチは undefined */
  operator?: string;
  query: ParsedQuery;
  /** 元 SQL 内のこの SELECT ブランチ全体 */
  sourceSpan?: SourceSpan;
}

export interface JoinEdge {
  id: string;
  type: JoinType;
  sourceId: string;
  targetId: string;
  condition: string;
  conditionParts?: { left: string; operator: string; right: string };
  /** ON 条件の構造化表現（サブクエリ・相関参照を含む） */
  conditionRoot?: ConditionNode;
  /** レイアウト解析用 — エイリアス解決前の ON 条件（表示用 condition とは別） */
  layoutCondition?: string;
  layoutConditionParts?: { left: string; operator: string; right: string };
  layoutConditionRoot?: ConditionNode;
  /** ON 条件の位置 */
  sourceSpan?: SourceSpan;
  /** NATURAL JOIN（同名前列で結合） */
  isNatural?: boolean;
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
  /** 元 SQL 内の条件式位置 */
  sourceSpan?: SourceSpan;
  /** IN / EXISTS / 比較式内のサブクエリ */
  nestedQuery?: ParsedQuery;
}

export interface SelectColumn {
  expression: string;
  alias?: string;
  sourceSpan?: SourceSpan;
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

/** UNION 全体に掛かる ORDER BY / LIMIT / OFFSET */
export type UnionTail = Pick<
  ParsedQuery,
  'orderBy' | 'limit' | 'limitSpan' | 'offset' | 'offsetSpan' | 'limitCommaOffset'
>;

export interface ParsedQuery {
  rawSql: string;
  statementType: 'SELECT' | 'UPDATE' | 'DELETE';
  /** 元 SQL 内のこの SELECT（サブクエリ・UNION ブランチ等）の範囲 */
  sourceSpan?: SourceSpan;
  tables: TableRef[];
  joins: JoinEdge[];
  where?: ConditionNode;
  having?: ConditionNode;
  columns: SelectColumn[];
  setClauses?: SetClause[];
  deleteTargets?: DeleteTarget[];
  groupBy: SqlFragment[];
  /** GROUP BY に付く修飾子（`WITH ROLLUP`）。付くと小計行が増え、列の並び順も結果を決める */
  groupByModifier?: string;
  /** 行ロックの指定（`FOR UPDATE SKIP LOCKED` など）。文の最上位の SELECT だけが持つ */
  lockingClause?: string;
  lockingClauseSpan?: SourceSpan;
  /** `UPDATE IGNORE` / `DELETE IGNORE` の IGNORE の位置。エラーになった行で文を止めずに飛ばす */
  dmlIgnoreSpan?: SourceSpan;
  orderBy: SqlFragment[];
  limit?: string;
  limitSpan?: SourceSpan;
  offset?: string;
  offsetSpan?: SourceSpan;
  /** LIMIT offset, count のカンマ形式か（LIMIT n OFFSET m との区別） */
  limitCommaOffset?: boolean;
  distinct: boolean;
  /** SELECT STRAIGHT_JOIN ヒント（FROM 句の JOIN 種別は書き換えない） */
  straightJoinHint?: boolean;
  /** 元 SQL 上の SELECT … STRAIGHT_JOIN 範囲 */
  straightJoinHintSpan?: SourceSpan;
  /** UNION / UNION ALL 等の各ブランチ（2本以上のとき） */
  unionBranches?: UnionBranch[];
  /**
   * UNION 全体に掛かる ORDER BY / LIMIT。UNION のときの orderBy / limit は先頭ブランチだけのもので、
   * 結果全体の並び順と行数はこちらが決める。指定が無ければ undefined
   */
  unionTail?: UnionTail;
  /** WITH 句で定義された CTE */
  ctes?: CteRef[];
  /**
   * 式の中に書かれたサブクエリ（SELECT 列・関数の引数・ORDER BY・SET の右辺など）。出現順。
   * 式の表示は `(SELECT 1列 FROM t)` のように要約するので、中身の比較にはこちらを使う。
   * 条件木の nestedQuery として持つサブクエリは含めない。
   */
  embeddedSubqueries?: ParsedQuery[];
}

export interface ParseError {
  message: string;
  /** パーサーが出した元の文（期待していた字句の一覧）。message には要約だけを入れ、これは詳細として見せる */
  detail?: string;
  /** 構文エラーの開始位置（入力 SQL 上のオフセット） */
  position?: number;
  /** 構文エラーの範囲（入力 SQL 上）。エディタで該当箇所に印を付けるのに使う */
  span?: SourceSpan;
}

export type ParseResult =
  | { success: true; query: ParsedQuery }
  | { success: false; error: ParseError };
