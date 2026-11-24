import type { SourceSpan } from './types';
import {
  isDashLineCommentStart,
  readBacktickIdentifierEnd,
  readBlockCommentEnd,
  readHashLineCommentEnd,
  readLineCommentEnd,
  readQuotedStringEnd,
} from './sql-lex';

export type SqlHighlightKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'identifier'
  | 'operator'
  | 'plain';

export interface SqlHighlightToken {
  kind: SqlHighlightKind;
  text: string;
}

const KEYWORDS = [
  'UNION ALL',
  'GROUP BY',
  'ORDER BY',
  'STRAIGHT JOIN',
  'STRAIGHT_JOIN',
  'SQL_CALC_FOUND_ROWS',
  'SQL_BUFFER_RESULT',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_NO_CACHE',
  'HIGH_PRIORITY',
  'LOW_PRIORITY',
  'DISTINCTROW',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'FOR UPDATE',
  'IS NOT',
  'NOT NULL',
  'NOT IN',
  'SELECT',
  'UPDATE',
  'DELETE',
  'INSERT',
  'REPLACE',
  'FROM',
  'WHERE',
  'HAVING',
  'JOIN',
  'INNER',
  'OUTER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'UNION',
  'DISTINCT',
  'BETWEEN',
  'EXISTS',
  'ESCAPE',
  'REGEXP',
  'RLIKE',
  'USING',
  'LIMIT',
  'OFFSET',
  'ASC',
  'DESC',
  'INTO',
  'VALUES',
  'SET',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'RECURSIVE',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'TRUE',
  'FALSE',
  'ALL',
  'BY',
].sort((a, b) => b.length - a.length);

const OPERATORS = ['<=>', '<<', '>>', '>=', '<=', '<>', '!=', ':=', '||', '&&', '->', '->>'].sort(
  (a, b) => b.length - a.length,
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 引用符なしの識別子に使える文字。MySQL は ASCII の英数字・$・_ に加えて U+0080〜U+FFFF を認める
 * （MySQL 8.4 リファレンス 11.2 Schema Object Names）。ASCII だけで判定すると、`テーブル1` の 1 を数値の色にする
 */
const WORD_CHAR = /[\w$\u0080-￿]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * キーワードの正規表現は最初に 1 回だけ作り、sticky（y）で pos の位置から照合する。
 * 文字ごとに作り直したり、残りの文字列を切り出したりすると、18 万文字の SQL で 1 文字の入力に 1 秒以上かかる
 */
const KEYWORD_PATTERNS = KEYWORDS.map(
  (keyword) => new RegExp(`${keyword.replace(/\s+/g, '\\s+')}(?![\\w$\\u0080-\\uFFFF])`, 'iy'),
);

const NUMBER_PATTERN = /(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function matchKeyword(text: string, pos: number): string | null {
  // 語の途中（直前が英数字）からはキーワードにしない
  if (pos > 0 && isWordChar(text[pos - 1])) return null;
  for (const pattern of KEYWORD_PATTERNS) {
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function readLineComment(text: string, pos: number): string {
  return text.slice(pos, readLineCommentEnd(text, pos));
}

function readHashLineComment(text: string, pos: number): string {
  return text.slice(pos, readHashLineCommentEnd(text, pos));
}

function readBlockComment(text: string, pos: number): string {
  return text.slice(pos, readBlockCommentEnd(text, pos));
}

function readQuotedString(text: string, pos: number, quote: "'" | '"'): string {
  return text.slice(pos, readQuotedStringEnd(text, pos, quote));
}

function readBacktickIdentifier(text: string, pos: number): string {
  return text.slice(pos, readBacktickIdentifierEnd(text, pos));
}

function readNumber(text: string, pos: number): string | null {
  NUMBER_PATTERN.lastIndex = pos;
  const match = NUMBER_PATTERN.exec(text);
  return match ? match[0] : null;
}

function pushToken(tokens: SqlHighlightToken[], kind: SqlHighlightKind, text: string): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  tokens.push({ kind, text });
}

export function tokenizeSql(sql: string): SqlHighlightToken[] {
  const tokens: SqlHighlightToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 語の途中の文字は、キーワードにも数値にも、コメントや文字列の始まりにもならない。語の終わりまでまとめて進める。
    // 数字も同じで、u1 や order2 の数字を数値の色にしない
    if (i > 0 && isWordChar(sql[i - 1]) && isWordChar(ch)) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      pushToken(tokens, 'plain', sql.slice(i, end));
      i = end;
      continue;
    }

    if (isDashLineCommentStart(sql, i)) {
      pushToken(tokens, 'comment', readLineComment(sql, i));
      i += tokens[tokens.length - 1].text.length;
      continue;
    }

    if (ch === '#') {
      pushToken(tokens, 'comment', readHashLineComment(sql, i));
      i += tokens[tokens.length - 1].text.length;
      continue;
    }

    if (ch === '/' && next === '*') {
      pushToken(tokens, 'comment', readBlockComment(sql, i));
      i += tokens[tokens.length - 1].text.length;
      continue;
    }

    if (ch === "'" || ch === '"') {
      pushToken(tokens, 'string', readQuotedString(sql, i, ch));
      i += tokens[tokens.length - 1].text.length;
      continue;
    }

    if (ch === '`') {
      pushToken(tokens, 'identifier', readBacktickIdentifier(sql, i));
      i += tokens[tokens.length - 1].text.length;
      continue;
    }

    // t.1st の .1 や 1 のように、修飾の点とその直後は数値にしない（0.5 の点は、数値の途中として先に読んでいる）
    const qualifierDot = (ch === '.' && isWordChar(sql[i - 1])) || sql[i - 1] === '.';
    const number = qualifierDot ? null : readNumber(sql, i);
    // 1abc のように数字のあとに語の文字が続くものは、数字で始まる識別子（MySQL は識別子を数字で始めてよい）
    if (number && isWordChar(sql[i + number.length])) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      pushToken(tokens, 'plain', sql.slice(i, end));
      i = end;
      continue;
    }
    if (number) {
      pushToken(tokens, 'number', number);
      i += number.length;
      continue;
    }

    const keyword = matchKeyword(sql, i);
    if (keyword) {
      pushToken(tokens, 'keyword', keyword);
      i += keyword.length;
      continue;
    }

    let matchedOperator = false;
    for (const op of OPERATORS) {
      if (sql.startsWith(op, i)) {
        pushToken(tokens, 'operator', op);
        i += op.length;
        matchedOperator = true;
        break;
      }
    }
    if (matchedOperator) continue;

    pushToken(tokens, 'plain', ch);
    i += 1;
  }

  return tokens;
}

/** エディタ上の印。focus は右側の表示と連動した範囲、error は構文エラーの範囲 */
export interface SqlHighlightMarks {
  focus?: SourceSpan;
  error?: SourceSpan;
}

interface HighlightSegment {
  text: string;
  classes: string[];
}

function inSpan(span: SourceSpan | undefined, offset: number): boolean {
  return Boolean(span && offset >= span.start && offset < span.end);
}

/** トークンを印の境界で切り分け、各片に付けるクラスを決める */
function highlightSegments(sql: string, marks: SqlHighlightMarks): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const markEdges = [marks.focus, marks.error]
    .filter((span): span is SourceSpan => Boolean(span))
    .flatMap((span) => [span.start, span.end]);
  let pos = 0;

  for (const { kind, text } of tokenizeSql(sql)) {
    const tokenStart = pos;
    const tokenEnd = pos + text.length;
    pos = tokenEnd;
    const cuts = [
      tokenStart,
      ...markEdges.filter((edge) => edge > tokenStart && edge < tokenEnd).sort((a, b) => a - b),
      tokenEnd,
    ];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!;
      const to = cuts[i + 1]!;
      if (from === to) continue;
      const classes: string[] = [];
      if (kind !== 'plain') classes.push(`sql-hl--${kind}`);
      if (inSpan(marks.focus, from)) classes.push('sql-hl--focus');
      if (inSpan(marks.error, from)) classes.push('sql-hl--error');
      segments.push({ text: text.slice(from - tokenStart, to - tokenStart), classes });
    }
  }
  return segments;
}

function wrapSegment({ text, classes }: HighlightSegment): string {
  const escaped = escapeHtml(text);
  if (classes.length === 0) return escaped;
  return `<span class="${classes.join(' ')}">${escaped}</span>`;
}

export function highlightSqlToHtml(sql: string, focusSpan?: SourceSpan, errorSpan?: SourceSpan): string {
  return highlightSegments(sql, { focus: focusSpan, error: errorSpan }).map(wrapSegment).join('');
}

/**
 * 行ごとの HTML を返す（行番号付きのエディタ用）。
 * 複数行にまたがるトークン（ブロックコメントや改行を含む文字列）は、行の境目で span を閉じて開き直す。
 * 戻り値の長さは sql の行数（改行の数 + 1）に一致する
 */
export function highlightSqlToLineHtml(sql: string, marks: SqlHighlightMarks = {}): string[] {
  const lines: string[] = [''];
  for (const segment of highlightSegments(sql, marks)) {
    const parts = segment.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push('');
      if (part) lines[lines.length - 1] += wrapSegment({ text: part, classes: segment.classes });
    });
  }
  return lines;
}
