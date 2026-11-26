/** SQL 字句走査の共通ユーティリティ（ハイライト・前処理で共有） */

/**
 * 引用符なしの識別子に使える文字。MySQL は ASCII の英数字・$・_ に加えて U+0080〜U+FFFF を認める
 * （MySQL 8.4 リファレンス 11.2 Schema Object Names）。ASCII だけで判定すると、`テーブル1` の 1 を数値の色にする
 */
const WORD_CHAR = /[\w$\u0080-\uFFFF]/;

/**
 * 引用符なしで書ける名前（英数字・`_`・`$`・U+0080 以降の文字）。MySQL は数字で始まる名前も引用符なしで書けるが、
 * `1e` のように数値と紛らわしいので、数字で始まる名前は引用符で囲んで出す
 */
const PLAIN_IDENTIFIER_RE = /^[A-Za-z_$\u0080-\uFFFF][\w$\u0080-\uFFFF]*$/;

/**
 * 画面に出す名前。引用符なしで書けない名前（空白や記号を含む `User Name` など）は、バッククォートで囲む。
 * 引用符を外して出すと、`AS User Name` が別名 User に見えるなど、SQL として読めなくなる
 */
export function displayIdentifier(name: string): string {
  if (name === '*' || name === '' || PLAIN_IDENTIFIER_RE.test(name)) return name;
  return `\`${name.replace(/`/g, '``')}\``;
}

/** ch が引用符なしの識別子（またはキーワード）に使える文字か */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

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

/**
 * 文字列・コメント・バッククォート識別子以外の領域。
 * keepQuotedIdentifiers を付けると、バッククォート識別子（`` `my alias` ``）もコードの領域に含める
 */
export function findCodeRegions(sql: string, keepQuotedIdentifiers = false): CodeRegion[] {
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
      if (keepQuotedIdentifiers) {
        i = readBacktickIdentifierEnd(sql, i);
        continue;
      }
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
  return maskOutside(sql, findCodeRegions(sql));
}

/**
 * 文字列とコメントだけを同じ長さの空白に置き換え、バッククォート識別子は残す。
 * 式の中の表の参照（`` `my alias`.id ``）を探すときに使う
 */
export function maskLiteralsAndComments(sql: string): string {
  return maskOutside(sql, findCodeRegions(sql, true));
}

function maskOutside(sql: string, regions: CodeRegion[]): string {
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

/**
 * MySQL が中身を SQL として実行するコメント（`/*!` で始まるブロックコメント。`/*!80000` のようにバージョンを
 * 付けた形も）の範囲。無ければ null。文字列と、ほかのコメントの中は見ない（MySQL 8.4 リファレンス 11.7 Comments）
 */
export function findExecutableComment(sql: string): { start: number; end: number } | null {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (isDashLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
    } else if (ch === '#') {
      i = readHashLineCommentEnd(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = readBlockCommentEnd(sql, i);
      if (sql[i + 2] === '!') return { start: i, end };
      i = end;
    } else if (ch === "'" || ch === '"') {
      i = readQuotedStringEnd(sql, i, ch);
    } else if (ch === '`') {
      i = readBacktickIdentifierEnd(sql, i);
    } else {
      i += 1;
    }
  }
  return null;
}
/**
 * 閉じていない文字列（' と "）・バッククォート・ブロックコメントの開始位置。どれも閉じていれば null。
 * 読み取りの関数は閉じていないときも末尾の位置を返すので、閉じたかどうかはここで確かめ直す
 */
export function findUnclosedLiteral(sql: string): { start: number; opener: "'" | '"' | '`' | '/*' } | null {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (isDashLineCommentStart(sql, i)) {
      i = readLineCommentEnd(sql, i);
    } else if (ch === '#') {
      i = readHashLineCommentEnd(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = readBlockCommentEnd(sql, i);
      if (end < i + 4 || sql.slice(end - 2, end) !== '*/') return { start: i, opener: '/*' };
      i = end;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        // バッククォートの中ではバックスラッシュは普通の文字
        j += ch !== '`' && sql[j] === '\\' ? 2 : 1;
      }
      if (!closed) return { start: i, opener: ch };
      i = j;
    } else {
      i += 1;
    }
  }
  return null;
}

/**
 * 範囲の終端から、後ろに付いた空白とコメントを除いた終端を返す関数を作る。
 * SQL パーサーの位置情報は要素の後ろの空白や `# …` のコメントまで範囲に含めることがある。
 * そのままだと、要素を選んだときにエディタで後ろのコメントまで強調し、
 * カーソルがコメントや次の語の先頭にあるときも、手前の要素を対応する要素として選んでしまう。
 * 文字列とバッククォートの中の空白は除かない。表は SQL 全体で 1 回だけ作る
 */
export function createTrailingTriviaTrimmer(sql: string): (start: number, end: number) => number {
  // codeEndAt[i]: sql[0..i) のうち、空白とコメント以外の最後の文字の直後の位置
  const codeEndAt = new Int32Array(sql.length + 1);
  let lastCodeEnd = 0;
  let i = 0;
  const markTrivia = (to: number) => {
    for (let k = i + 1; k <= to; k += 1) codeEndAt[k] = lastCodeEnd;
    i = to;
  };
  const markCode = (to: number) => {
    for (let k = i + 1; k <= to; k += 1) codeEndAt[k] = k;
    lastCodeEnd = to;
    i = to;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (isDashLineCommentStart(sql, i)) markTrivia(readLineCommentEnd(sql, i));
    else if (ch === '#') markTrivia(readHashLineCommentEnd(sql, i));
    else if (ch === '/' && sql[i + 1] === '*') markTrivia(readBlockCommentEnd(sql, i));
    else if (ch === "'" || ch === '"') markCode(readQuotedStringEnd(sql, i, ch));
    else if (ch === '`') markCode(readBacktickIdentifierEnd(sql, i));
    else if (/\s/.test(ch)) markTrivia(i + 1);
    else markCode(i + 1);
  }
  return (start, end) => {
    if (end <= start || end > sql.length) return end;
    const trimmed = codeEndAt[end]!;
    return trimmed > start ? trimmed : end;
  };
}
