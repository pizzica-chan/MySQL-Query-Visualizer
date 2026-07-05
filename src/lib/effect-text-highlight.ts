import type { ParsedQuery, TableRef } from './types';

export type EffectHighlightKind = 'keyword' | 'table' | 'column' | 'string' | 'emphasis';

export interface EffectTextSegment {
  text: string;
  kind?: EffectHighlightKind;
}

const SQL_KEYWORDS = [
  '実質 INNER JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'GROUP BY',
  'ORDER BY',
  'IS NULL',
  'SQL上は',
  'WHERE',
  'HAVING',
  'BETWEEN',
  'EXISTS',
  'DISTINCT',
  'UNION ALL',
  'OFFSET',
  'COUNT DISTINCT',
  'JOIN',
  'LIKE',
  'AND',
  'NOT',
  'OR',
  'IN',
] as const;

const EMPHASIS_PHRASES = ['≈INNER'] as const;

const COLUMN_PATTERN = /^([a-zA-Z_][\w$]*)\.([a-zA-Z_*][\w$]*)/;

interface MatchCandidate {
  length: number;
  kind: EffectHighlightKind;
  text: string;
}

function tableLabel(table: TableRef): string {
  if (table.alias && table.alias !== table.table) {
    return `${table.table}（${table.alias}）`;
  }
  return table.table;
}

function collectTableTerms(query: ParsedQuery): string[] {
  const terms = new Set<string>();
  for (const table of query.tables) {
    terms.add(tableLabel(table));
    if (table.table) terms.add(table.table);
    if (table.alias) terms.add(table.alias);
    if (table.displayName) terms.add(table.displayName);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function matchesTerm(text: string, pos: number, term: string): boolean {
  if (!text.startsWith(term, pos)) return false;

  if (term.includes('（') || term.includes('.')) {
    return true;
  }

  const before = pos > 0 ? text[pos - 1] : '';
  const after = text[pos + term.length];
  if (isIdentifierChar(before)) return false;
  if (isIdentifierChar(after)) return false;
  return true;
}

function findBestMatch(text: string, pos: number, tableTerms: string[]): MatchCandidate | null {
  if (text[pos] === '「') {
    const end = text.indexOf('」', pos + 1);
    if (end !== -1) {
      return {
        length: end - pos + 1,
        kind: 'string',
        text: text.slice(pos, end + 1),
      };
    }
  }

  for (const phrase of EMPHASIS_PHRASES) {
    if (matchesTerm(text, pos, phrase)) {
      return { length: phrase.length, kind: 'emphasis', text: phrase };
    }
  }

  for (const keyword of SQL_KEYWORDS) {
    if (matchesTerm(text, pos, keyword)) {
      return { length: keyword.length, kind: 'keyword', text: keyword };
    }
  }

  const columnMatch = text.slice(pos).match(COLUMN_PATTERN);
  if (columnMatch) {
    return {
      length: columnMatch[0].length,
      kind: 'column',
      text: columnMatch[0],
    };
  }

  for (const term of tableTerms) {
    if (matchesTerm(text, pos, term)) {
      return { length: term.length, kind: 'table', text: term };
    }
  }

  return null;
}

function segmentInnerCondition(text: string, tableTerms: string[]): EffectTextSegment[] {
  const segments: EffectTextSegment[] = [];
  let pos = 0;

  while (pos < text.length) {
    const columnMatch = text.slice(pos).match(COLUMN_PATTERN);
    if (columnMatch) {
      segments.push({ text: columnMatch[0], kind: 'column' });
      pos += columnMatch[0].length;
      continue;
    }

    let matched = false;
    for (const term of tableTerms) {
      if (matchesTerm(text, pos, term)) {
        segments.push({ text: term, kind: 'table' });
        pos += term.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    let nextPos = pos + 1;
    while (nextPos < text.length) {
      const hasColumn = COLUMN_PATTERN.test(text.slice(nextPos));
      const hasTable = tableTerms.some((term) => matchesTerm(text, nextPos, term));
      if (hasColumn || hasTable) break;
      nextPos += 1;
    }
    segments.push({ text: text.slice(pos, nextPos) });
    pos = nextPos;
  }

  return mergeAdjacentPlainSegments(segments);
}

function segmentQuotedString(text: string, tableTerms: string[]): EffectTextSegment[] {
  const inner = text.slice(1, -1);
  return [
    { text: '「', kind: 'string' },
    ...segmentInnerCondition(inner, tableTerms),
    { text: '」', kind: 'string' },
  ];
}

function mergeAdjacentPlainSegments(segments: EffectTextSegment[]): EffectTextSegment[] {
  const merged: EffectTextSegment[] = [];
  for (const segment of segments) {
    const prev = merged.at(-1);
    if (prev && !prev.kind && !segment.kind) {
      prev.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function segmentEffectText(text: string, query?: ParsedQuery): EffectTextSegment[] {
  const tableTerms = query ? collectTableTerms(query) : [];
  const segments: EffectTextSegment[] = [];
  let pos = 0;

  while (pos < text.length) {
    const match = findBestMatch(text, pos, tableTerms);

    if (!match) {
      let nextPos = pos + 1;
      while (nextPos < text.length && !findBestMatch(text, nextPos, tableTerms)) {
        nextPos += 1;
      }
      segments.push({ text: text.slice(pos, nextPos) });
      pos = nextPos;
      continue;
    }

    if (match.kind === 'string') {
      segments.push(...segmentQuotedString(match.text, tableTerms));
    } else {
      segments.push({ text: match.text, kind: match.kind });
    }
    pos += match.length;
  }

  return mergeAdjacentPlainSegments(segments);
}
