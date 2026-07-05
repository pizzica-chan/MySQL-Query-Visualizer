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

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function matchKeyword(text: string, pos: number): string | null {
  const slice = text.slice(pos);
  for (const keyword of KEYWORDS) {
    const re = new RegExp(`^${keyword.replace(/\s+/g, '\\s+')}(?![\\w$])`, 'i');
    const match = slice.match(re);
    if (match) {
      const before = pos > 0 ? text[pos - 1] : '';
      if (isWordChar(before)) continue;
      return match[0];
    }
  }
  return null;
}

function readLineComment(text: string, pos: number): string {
  let i = pos + 2;
  while (i < text.length && text[i] !== '\n') i += 1;
  return text.slice(pos, i);
}

function readBlockComment(text: string, pos: number): string {
  let i = pos + 2;
  while (i < text.length - 1) {
    if (text[i] === '*' && text[i + 1] === '/') {
      return text.slice(pos, i + 2);
    }
    i += 1;
  }
  return text.slice(pos);
}

function readQuotedString(text: string, pos: number, quote: "'" | '"'): string {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return text.slice(pos, i + 1);
    }
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return text.slice(pos);
}

function readBacktickIdentifier(text: string, pos: number): string {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === '`') {
      if (text[i + 1] === '`') {
        i += 2;
        continue;
      }
      return text.slice(pos, i + 1);
    }
    i += 1;
  }
  return text.slice(pos);
}

function readNumber(text: string, pos: number): string | null {
  const match = text.slice(pos).match(/^(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
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

    if (ch === '-' && next === '-') {
      pushToken(tokens, 'comment', readLineComment(sql, i));
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

    const number = readNumber(sql, i);
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

export function highlightSqlToHtml(sql: string): string {
  return tokenizeSql(sql)
    .map(({ kind, text }) => {
      const escaped = escapeHtml(text);
      if (kind === 'plain') return escaped;
      return `<span class="sql-hl--${kind}">${escaped}</span>`;
    })
    .join('');
}
