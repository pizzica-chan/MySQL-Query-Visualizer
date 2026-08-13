/** SQL 字句走査の共通ユーティリティ（ハイライト・前処理で共有） */

export interface CodeRegion {
  start: number;
  end: number;
}

/**
 * MySQL の `--` 行コメントは、2つ目の `-` の直後に空白類が必要。
 * `a--b` のような演算子列はコメントにしない。
 */
export function isDashLineCommentStart(text: string, pos: number): boolean {
  if (text[pos] !== '-' || text[pos + 1] !== '-') return false;
  const after = text[pos + 2];
  return after !== undefined && /\s/.test(after);
}

export function readLineCommentEnd(text: string, pos: number): number {
  let i = pos + 2;
  while (i < text.length && text[i] !== '\n') i += 1;
  return i;
}

export function readHashLineCommentEnd(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length && text[i] !== '\n') i += 1;
  return i;
}

export function readBlockCommentEnd(text: string, pos: number): number {
  let i = pos + 2;
  while (i < text.length - 1) {
    if (text[i] === '*' && text[i + 1] === '/') {
      return i + 2;
    }
    i += 1;
  }
  return text.length;
}

export function readQuotedStringEnd(text: string, pos: number, quote: "'" | '"'): number {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return text.length;
}

export function readBacktickIdentifierEnd(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length) {
    if (text[i] === '`') {
      if (text[i + 1] === '`') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** openPos は '(' の位置。対応する ')' の直後インデックス。閉じ括弧が無ければ null。文字列・コメント内の括弧は数えない */
export function readBalancedParenEnd(text: string, openPos: number): number | null {
  if (text[openPos] !== '(') return null;
  let depth = 0;
  for (let i = openPos; i < text.length; ) {
    if (isDashLineCommentStart(text, i)) {
      i = readLineCommentEnd(text, i);
      continue;
    }
    if (text[i] === '#') {
      i = readHashLineCommentEnd(text, i);
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i = readBlockCommentEnd(text, i);
      continue;
    }
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      i = readQuotedStringEnd(text, i, quote);
      continue;
    }
    if (text[i] === '`') {
      i = readBacktickIdentifierEnd(text, i);
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

/** 文字列・コメント・バッククォート識別子以外の領域 */
export function findCodeRegions(sql: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let codeStart = 0;
  let i = 0;

  const closeCode = (end: number) => {
    if (end > codeStart) regions.push({ start: codeStart, end });
    codeStart = end;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (isDashLineCommentStart(sql, i)) {
      closeCode(i);
      i = readLineCommentEnd(sql, i);
      codeStart = i;
      continue;
    }

    if (ch === '#') {
      closeCode(i);
      i = readHashLineCommentEnd(sql, i);
      codeStart = i;
      continue;
    }

    if (ch === '/' && next === '*') {
      closeCode(i);
      i = readBlockCommentEnd(sql, i);
      codeStart = i;
      continue;
    }

    if (ch === "'" || ch === '"') {
      closeCode(i);
      i = readQuotedStringEnd(sql, i, ch);
      codeStart = i;
      continue;
    }

    if (ch === '`') {
      closeCode(i);
      i = readBacktickIdentifierEnd(sql, i);
      codeStart = i;
      continue;
    }

    i += 1;
  }

  closeCode(sql.length);
  return regions;
}

/** 文字列・コメント・バッククォートを同じ長さの空白に置き換える。オフセットは元 SQL と一致する */
export function maskNonCode(sql: string): string {
  const regions = findCodeRegions(sql);
  let masked = '';
  let pos = 0;
  for (const region of regions) {
    masked += ' '.repeat(region.start - pos);
    masked += sql.slice(region.start, region.end);
    pos = region.end;
  }
  masked += ' '.repeat(sql.length - pos);
  return masked;
}
