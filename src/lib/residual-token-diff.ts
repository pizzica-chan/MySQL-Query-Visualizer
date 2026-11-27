/**
 * カテゴリ比較（query-result-diff）の取りこぼしを見つけるための、元 SQL の字句どうしの比較。
 *
 * カテゴリ比較は ParsedQuery の表示用文字列を突き合わせる。パーサが文字列にしない構文
 * （PARTITION 句、UNION 全体の LIMIT など）は、違っていてもカテゴリ比較では「同じ」になる。
 * そこで、結果を変えない書き換え（別名の付け替え、JOIN や AND の並べ替え、
 * JOIN 種別の書き方、インデックスヒント）で増減しない字句だけを数え、
 * 両方の SQL で個数が合わなければ「カテゴリ比較が扱わない差分がある」と報告する。
 *
 * 個数が合っても同じ結果とは限らない。「同じ」の根拠には使わず、「同じ」を取り消す側にだけ使う。
 */
import {
  isDashLineCommentStart,
  maskNonCode,
  readBacktickIdentifierEnd,
  readBalancedParenEnd,
  readBlockCommentEnd,
  readHashLineCommentEnd,
  readLineCommentEnd,
  readQuotedStringEnd,
} from './sql-lex';
import type { ConditionNode, ParsedQuery, SourceSpan } from './types';

/** 結果を変えない書き換えで増減する語。数えない */
const IGNORED_WORDS = new Set([
  // JOIN 種別の書き方（INNER の省略、LEFT と RIGHT の入れ替え、実質 INNER の書き直し）
  'inner', 'left', 'right', 'outer', 'cross', 'join', 'straight_join',
  // 条件の置き場所（カンマ結合の WHERE と JOIN の ON）と、条件をつなぐ AND
  'on', 'where', 'and',
  // 別名の AS は省略できる
  'as',
  // 実行計画や優先度だけを変える修飾子
  'high_priority', 'low_priority', 'quick',
  'sql_small_result', 'sql_big_result', 'sql_buffer_result', 'sql_no_cache', 'sql_calc_found_rows',
]);

/** 同じ意味の語を 1 つに寄せる */
const WORD_SYNONYMS = new Map([['distinctrow', 'distinct']]);

/**
 * ロック句。読んだ行をロックするだけで、返す行は変わらない。
 * `FOR UPDATE OF t1, t2 NOWAIT`、`FOR SHARE SKIP LOCKED`、`LOCK IN SHARE MODE`
 */
const LOCKING_CLAUSE_RE =
  /\bFOR\s+(?:UPDATE|SHARE)\b(?:\s+OF\s+[\w$.]+(?:\s*,\s*[\w$.]+)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?|\bLOCK\s+IN\s+SHARE\s+MODE\b/gi;

const INDEX_HINT_RE =
  /\b(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)(?:\s+FOR\s+(?:JOIN|ORDER\s+BY|GROUP\s+BY))?\s*\(/gi;

const WORD_START_RE = /[A-Za-z_$\u0080-\uFFFF]/;
const WORD_CHAR_RE = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const OPERATOR_CHAR_RE = /[=<>!+\-*/%&|^~:@?]/;

/** 2 文字以上の演算子。長いものから順に照らす */
const MULTI_CHAR_OPERATORS = ['<=>', '->>', '<=', '>=', '<>', '!=', ':=', '->', '<<', '>>', '||', '&&', '@@'];

interface Range {
  start: number;
  end: number;
}

function overlapsAny(pos: number, ranges: Range[]): Range | undefined {
  return ranges.find((r) => pos >= r.start && pos < r.end);
}

/** インデックスヒント `USE INDEX (...)` の範囲。結果を変えないので数えない */
function lockingClauseRanges(masked: string): Range[] {
  return [...masked.matchAll(new RegExp(LOCKING_CLAUSE_RE.source, 'gi'))].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

function indexHintRanges(masked: string): Range[] {
  const ranges: Range[] = [];
  const re = new RegExp(INDEX_HINT_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const open = match.index + match[0].length - 1;
    const end = readBalancedParenEnd(masked, open);
    if (end == null) continue;
    ranges.push({ start: match.index, end });
  }
  return ranges;
}

/** ORDER BY 句のあとに続く句の先頭語 */
const AFTER_ORDER_BY_RE = /^(?:limit|for|lock|into|procedure)\b/i;

/**
 * from から始まる ORDER BY 句がどこで終わるか。
 * 括弧の外で LIMIT などの次の句か `;` が出てくるところまでを句とする。
 */
function orderByClauseEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return i;
    if (depth > 0) continue;
    if (ch === ';') return i;
    const startsWord = /[A-Za-z]/.test(ch) && !/[\w$]/.test(masked[i - 1] ?? ' ');
    if (startsWord && AFTER_ORDER_BY_RE.test(masked.slice(i, i + 12))) return i;
  }
  return masked.length;
}

/**
 * 最上位の ORDER BY 句の範囲。並び順の違いは ORDER BY カテゴリが扱うので、ここでは数えない。
 * 式の位置が取れないときは範囲を返さない（その分は差分として報告される）。
 */
function topLevelOrderByRange(query: ParsedQuery, masked: string): Range[] {
  // UNION のときは、結果全体に掛かる ORDER BY（unionTail）だけを除く
  const owner = query.unionBranches?.length ? query.unionTail : query;
  if (!owner) return [];
  const spans = owner.orderBy
    .map((o) => o.sourceSpan)
    .filter((s): s is SourceSpan => Boolean(s));
  if (spans.length === 0 || spans.length !== owner.orderBy.length) return [];

  const first = Math.min(...spans.map((s) => s.start));
  // 最初の式が `(a.x + 1)` のように括弧で始まると、式の位置は括弧の内側になる
  const keyword = masked.slice(0, first).match(/\border\s+by([\s(]*)$/i);
  if (!keyword) return [];

  // 句の終わりは、式の手前の括弧も含めて数えないと最初の `)` で止まってしまう
  const scanFrom = first - keyword[1]!.length;
  return [{ start: first - keyword[0].length, end: orderByClauseEnd(masked, scanFrom) }];
}

/**
 * 最上位の LIMIT 句の範囲（`LIMIT 5, 10` と `LIMIT 10 OFFSET 5`）。件数と飛ばす行の数は LIMIT カテゴリが比べるので、
 * 書き方の違い（`,` と OFFSET）をここでは数えない。SQL パーサーは数値に位置を返さないので、括弧の外にある最後の LIMIT から、
 * 次の句（FOR・LOCK・INTO）か `;` までを句とする
 */
function topLevelLimitRange(query: ParsedQuery, masked: string): Range[] {
  const owner = query.unionBranches?.length ? query.unionTail : query;
  if (!owner?.limit && !owner?.offset) return [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && /[Ll]/.test(ch) && !/[\w$]/.test(masked[i - 1] ?? ' ') && /^limit\b/i.test(masked.slice(i, i + 6))) start = i;
  }
  if (start < 0) return [];
  let end = start + 'limit'.length;
  while (end < masked.length && masked[end] !== ';' && !/^(?:for|lock|into)\b/i.test(masked.slice(end, end + 5))) end += 1;
  return [{ start, end }];
}

function visitCondition(node: ConditionNode | undefined, visit: (query: ParsedQuery) => void): void {
  if (!node) return;
  if (node.nestedQuery) visitQueryTree(node.nestedQuery, visit);
  for (const child of node.children ?? []) visitCondition(child, visit);
}

/** このクエリと、入れ子になっているすべてのクエリを訪ねる */
function visitQueryTree(query: ParsedQuery, visit: (query: ParsedQuery) => void): void {
  visit(query);
  for (const table of query.tables) {
    if (table.derivedQuery) visitQueryTree(table.derivedQuery, visit);
  }
  for (const join of query.joins) visitCondition(join.conditionRoot, visit);
  visitCondition(query.where, visit);
  visitCondition(query.having, visit);
  for (const cte of query.ctes ?? []) visitQueryTree(cte.query, visit);
  // 先頭ブランチは query 自身と同じ内容なので、名前や USING を重ねて数えないよう飛ばす
  for (const branch of (query.unionBranches ?? []).slice(1)) visitQueryTree(branch.query, visit);
  for (const sub of query.embeddedSubqueries ?? []) visitQueryTree(sub, visit);
}

/** テーブル名・別名・スキーマ名・CTE 名。別名の付け替えで増減するので数えない */
function collectTableNames(root: ParsedQuery, names: Set<string>): void {
  visitQueryTree(root, (query) => {
    for (const table of query.tables) {
      for (const name of [table.schema, table.table, table.alias]) {
        if (name) names.add(name.toLowerCase());
      }
    }
    for (const cte of query.ctes ?? []) names.add(cte.name.toLowerCase());
  });
}

/** `USING (a, b)` の列名。USING でない結合条件は null */
function usingColumns(condition: string): string[] | null {
  const match = condition.trim().match(/^USING\s*\((.*)\)$/i);
  if (!match) return null;
  return match[1]!
    .split(',')
    .map((column) => column.trim().replace(/`/g, '').toLowerCase())
    .filter(Boolean);
}

/**
 * `USING (id)` を `ON a.id = b.id` と同じ字句の個数に揃える。
 * 列を明示した SELECT では両者は同じ結果になり、カテゴリ比較も同じ結合として扱う。
 * `USING` を 1 つ取り除き、列ごとに列名と `=` を 1 つずつ足すと ON の書き方と一致する。
 */
function equalizeUsingJoins(root: ParsedQuery, tokens: string[]): string[] {
  const out = [...tokens];
  visitQueryTree(root, (query) => {
    for (const join of query.joins) {
      const columns = usingColumns(join.condition);
      if (!columns) continue;
      const index = out.indexOf('w:using');
      if (index >= 0) out.splice(index, 1);
      for (const column of columns) out.push(`w:${column}`, 'o:=');
    }
  });
  return out;
}

/**
 * 複数テーブルの DELETE の、対象の並びの書き方の違い。`DELETE FROM t1 USING t1 JOIN …` と
 * `DELETE t1 FROM t1 JOIN …` は同じ文で、対象の `t1.*` の `.*` もあってもなくても同じ。
 * 対象の並び（最初のテーブル参照より前）の中の USING と `.*` だけを数えない。対象のテーブルはカテゴリ比較で比べる
 */
function multiTableDeleteRanges(query: ParsedQuery, masked: string): Range[] {
  if (query.statementType !== 'DELETE' || !query.deleteTargets?.length) return [];
  const headerEnd = query.tables[0]?.sourceSpan?.start;
  if (headerEnd === undefined) return [];
  const header = masked.slice(0, headerEnd);
  return [...header.matchAll(/\bUSING\b|\.\s*\*/gi)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * `UNION DISTINCT` の DISTINCT。`UNION` と同じ意味（MySQL 8.4 リファレンス 15.2.18）で、演算子は parser.ts で `UNION` にそろえてある。
 * INTERSECT と EXCEPT も同じ
 */
function setOperatorDistinctRanges(masked: string): Range[] {
  return [...masked.matchAll(/\b(?:UNION|INTERSECT|EXCEPT)\s+(DISTINCT)\b/gi)].map((match) => {
    const start = match.index + match[0].length - match[1]!.length;
    return { start, end: start + match[1]!.length };
  });
}
function tokenize(query: ParsedQuery, ignoredNames: Set<string>): string[] {
  const sql = query.rawSql;
  const masked = maskNonCode(sql);
  const skipped = [
    ...indexHintRanges(masked),
    ...lockingClauseRanges(masked),
    ...topLevelOrderByRange(query, masked),
    ...topLevelLimitRange(query, masked),
    ...multiTableDeleteRanges(query, masked),
    ...setOperatorDistinctRanges(masked),
  ];
  const tokens: string[] = [];
  /** 直前の字句が語かどうか。直後に `.` が来たら修飾子（テーブル名・別名）なので取り消す */
  let lastWasWord = false;

  const pushWord = (raw: string): void => {
    const lowered = raw.toLowerCase();
    tokens.push(`w:${WORD_SYNONYMS.get(lowered) ?? lowered}`);
    lastWasWord = true;
  };

  let i = 0;
  while (i < sql.length) {
    const range = overlapsAny(i, skipped);
    if (range) {
      i = range.end;
      lastWasWord = false;
      continue;
    }

    const ch = sql[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (isDashLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
      continue;
    }
    if (ch === '#') {
      i = readHashLineCommentEnd(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = readBlockCommentEnd(sql, i);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = readQuotedStringEnd(sql, i, ch);
      tokens.push(`s:${sql.slice(i, end)}`);
      lastWasWord = false;
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = readBacktickIdentifierEnd(sql, i);
      const closed = end - i >= 2 && sql[end - 1] === '`';
      pushWord(sql.slice(i + 1, closed ? end - 1 : end).replace(/``/g, '`'));
      i = end;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/.test(sql[end]!)) end += 1;
      tokens.push(`n:${sql.slice(i, end).toLowerCase()}`);
      lastWasWord = false;
      i = end;
      continue;
    }

    if (WORD_START_RE.test(ch)) {
      let end = i + 1;
      while (end < sql.length && WORD_CHAR_RE.test(sql[end]!)) end += 1;
      pushWord(sql.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '.') {
      if (lastWasWord) tokens.pop();
      lastWasWord = false;
      i += 1;
      continue;
    }

    if (OPERATOR_CHAR_RE.test(ch)) {
      // 演算子は既知の組み合わせだけを 1 つの字句にする。記号の並びをまとめて切り出すと、
      // `a.x=-1` が `=-`、`a.x = -1` が `=` と `-` になり、空白の違いだけで差分になる
      const operator = MULTI_CHAR_OPERATORS.find((op) => sql.startsWith(op, i)) ?? ch;
      // `!=` と `<>` は同じ演算子。`&&` は AND、`||` は OR と同じ（MySQL 8.4 リファレンス 14.4.3）
      if (operator === '&&') tokens.push('w:and');
      else if (operator === '||') tokens.push('w:or');
      else tokens.push(`o:${operator === '!=' ? '<>' : operator}`);
      lastWasWord = false;
      i += operator.length;
      continue;
    }

    // 括弧・カンマ・セミコロンは、並べ替えや書き方の違いで増減するので数えない
    lastWasWord = false;
    i += 1;
  }

  return equalizeUsingJoins(query, tokens).filter((token) => {
    if (!token.startsWith('w:')) return true;
    const word = token.slice(2);
    return !IGNORED_WORDS.has(word) && !ignoredNames.has(word);
  });
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function surplus(from: Map<string, number>, other: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [token, count] of from) {
    const extra = count - (other.get(token) ?? 0);
    for (let n = 0; n < extra; n += 1) out.push(token.slice(2));
  }
  return out;
}

export interface ResidualTokenDiff {
  /** A にだけ余分にある字句 */
  onlyA: string[];
  /** B にだけ余分にある字句 */
  onlyB: string[];
}

/**
 * 別名の付け替えや並べ替えでは増減しない字句について、A と B の過不足を返す。
 * 元 SQL を持たない ParsedQuery（テストで手組みしたもの）は比較しない。
 */
export function residualTokenDiff(queryA: ParsedQuery, queryB: ParsedQuery): ResidualTokenDiff {
  if (!queryA.rawSql || !queryB.rawSql) return { onlyA: [], onlyB: [] };

  const names = new Set<string>();
  collectTableNames(queryA, names);
  collectTableNames(queryB, names);

  const countsA = countTokens(tokenize(queryA, names));
  const countsB = countTokens(tokenize(queryB, names));
  return { onlyA: surplus(countsA, countsB), onlyB: surplus(countsB, countsA) };
}
