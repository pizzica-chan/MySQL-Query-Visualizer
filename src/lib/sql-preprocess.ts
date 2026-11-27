import {
  createTrailingTriviaTrimmer,
  isDashLineCommentStart,
  isWordChar,
  maskNonCode,
  readBacktickIdentifierEnd,
  readBalancedParenEnd,
  readBlockCommentEnd,
  readHashLineCommentEnd,
  readLineCommentEnd,
  readQuotedStringEnd,
  type CodeRegion,
} from './sql-lex';
import type { ConditionNode, ParsedQuery, SourceSpan, SqlFragment } from './types';

export type { CodeRegion };
export { findCodeRegions, maskNonCode } from './sql-lex';

/** 文の最後の行ロックの指定（`FOR SHARE SKIP LOCKED` など）。sourceSpan は前処理に渡した SQL の座標 */
export interface LockingClauseInfo {
  text: string;
  sourceSpan: SourceSpan;
}

/** 表の後ろの `PARTITION (p0, p1)`。sourceSpan は前処理に渡した SQL の座標 */
export interface TableModifierInfo {
  kind: 'partition';
  text: string;
  sourceSpan: SourceSpan;
}

export interface PreprocessResult {
  sql: string;
  /** 取り除いた、文の最後の FOR UPDATE / FOR SHARE。parser.ts が最上位の SELECT に持たせる */
  lockingClause?: LockingClauseInfo;
  /** 取り除いた、表の後ろの PARTITION (…)。読む行を変えるので、parser.ts が直前の表に持たせて作用説明に出す */
  tableModifiers: TableModifierInfo[];
  /** 取り除いた UPDATE IGNORE / DELETE IGNORE の IGNORE（前処理に渡した SQL の座標） */
  dmlIgnoreSpan?: SourceSpan;
  naturalJoinStarts: number[];
  straightJoinHintSelectStarts: number[];
  /** straightJoinHintSelectStarts と同じ順。元 SQL 上の SELECT … STRAIGHT_JOIN 範囲 */
  straightJoinHintOriginalSpans: SourceSpan[];
  /** preprocessed[i] の文字が元 SQL のどの位置か */
  processedToOriginal: number[];
  /** 前処理で置き換えた関数名（大文字の仮の名前 → 元の名前）。表示では元の名前に戻す */
  renamedFunctions: Map<string, string>;
}

interface ProcessState {
  sql: string;
  processedToOriginal: number[];
}

interface RecordedStarts {
  lists: number[][];
}

function initState(sql: string): ProcessState {
  return {
    sql,
    processedToOriginal: Array.from({ length: sql.length }, (_, index) => index),
  };
}

function originalSpanForProcessedRange(state: ProcessState, start: number, end: number): SourceSpan {
  const origStart = state.processedToOriginal[start] ?? start;
  const last = Math.max(start, end - 1);
  const origLast = state.processedToOriginal[last] ?? last;
  return { start: origStart, end: origLast + 1 };
}

/** 左側の splice で processed 長が変わったとき、既に記録した開始位置を補正する */
function adjustRecordedStarts(lists: number[][], spliceStart: number, delta: number): void {
  if (delta === 0) return;
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]! > spliceStart) list[i]! += delta;
    }
  }
}

/** 挿入文字を元範囲へ配る。先頭は origStart、末尾は origLast に載せ、置換全体の span が潰れるのを防ぐ */
function originalOffsetsForInsertion(
  state: ProcessState,
  start: number,
  end: number,
  insertedLength: number,
): number[] {
  if (insertedLength === 0) return [];

  const origStart =
    state.processedToOriginal[start] ??
    state.processedToOriginal[Math.max(0, end - 1)] ??
    start;
  const origLast =
    end > start ? (state.processedToOriginal[end - 1] ?? origStart) : origStart;

  return Array.from({ length: insertedLength }, (_, i) => {
    if (i === insertedLength - 1) return origLast;
    const mapped = origStart + i;
    return mapped < origLast ? mapped : origLast;
  });
}

/**
 * 引用符なしの識別子のうち、ASCII 以外の文字を含むもの（テーブル、ユーザー2 など）。
 * MySQL は U+0080〜U+FFFF を識別子に認めるが（MySQL 8.4 リファレンス 11.2）、node-sql-parser は
 * 漢字と一部のラテン文字しか認めず、カタカナやひらがなのテーブル名で構文エラーになる。
 * 文字・数字・結合文字だけの並びに限る。全角の空白や記号を含む並びは書き換えず、パーサーのエラーで位置を示す
 */
const NON_ASCII_IDENTIFIER_RE = /[\w$\p{L}\p{N}\p{M}]+/gu;

/**
 * ASCII 以外の文字を含む識別子をバッククォートで囲む。囲んでも識別子の名前は変わらない。
 * 文字列・コメント・すでに囲んである識別子の中と、ユーザー変数（@名前）は書き換えない
 */
function quoteNonAsciiIdentifiers(state: ProcessState, recorded: RecordedStarts): void {
  const masked = maskNonCode(state.sql);
  const runs: Array<{ start: number; end: number }> = [];
  for (const match of masked.matchAll(NON_ASCII_IDENTIFIER_RE)) {
    const text = match[0];
    const start = match.index;
    if (!/[^\x00-\x7f]/.test(text)) continue;
    // U+10000 以降（サロゲートペア）は MySQL の識別子に使えないので、パーサーのエラーに任せる
    if (/[\ud800-\udfff]/.test(text)) continue;
    if (masked[start - 1] === '@') continue;
    runs.push({ start, end: start + text.length });
  }
  for (const { start, end } of runs.reverse()) {
    const map = state.processedToOriginal;
    // 開きのバッククォートは識別子の先頭の文字に、閉じは末尾の文字に対応させる。範囲が元の識別子とちょうど重なる
    state.processedToOriginal = [
      ...map.slice(0, start),
      map[start]!,
      ...map.slice(start, end),
      map[end - 1]!,
      ...map.slice(end),
    ];
    state.sql = state.sql.slice(0, start) + '`' + state.sql.slice(start, end) + '`' + state.sql.slice(end);
    adjustRecordedStarts(recorded.lists, end, 1);
    adjustRecordedStarts(recorded.lists, start, 1);
  }
}

function spliceProcessed(
  state: ProcessState,
  start: number,
  end: number,
  inserted: string,
  recorded?: RecordedStarts,
): void {
  const delta = inserted.length - (end - start);
  const insertedMap = originalOffsetsForInsertion(state, start, end, inserted.length);
  state.sql = state.sql.slice(0, start) + inserted + state.sql.slice(end);
  state.processedToOriginal = [
    ...state.processedToOriginal.slice(0, start),
    ...insertedMap,
    ...state.processedToOriginal.slice(end),
  ];
  if (recorded) adjustRecordedStarts(recorded.lists, start, delta);
}

interface RegexReplacement {
  pattern: RegExp;
  replace: (match: RegExpExecArray) => string;
  recordStartAt?: (processedStart: number) => void;
}

function applyRegexReplacementsInCode(
  state: ProcessState,
  replacements: RegexReplacement[],
  recorded?: RecordedStarts,
): void {
  for (const { pattern, replace, recordStartAt } of replacements) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    const matches: Array<{ start: number; end: number; match: RegExpExecArray }> = [];
    const masked = maskNonCode(state.sql);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      let end = m.index + m[0].length;
      if (masked[end - 1] === '(') {
        const closed = readBalancedParenEnd(masked, end - 1);
        if (closed == null) continue;
        end = closed;
      }
      matches.push({
        start: m.index,
        end,
        match: m,
      });
    }

    matches.sort((a, b) => b.start - a.start);
    for (const { start, end, match } of matches) {
      const inserted = replace(match);
      if (recordStartAt) recordStartAt(start);
      spliceProcessed(state, start, end, inserted, recorded);
    }
  }
}

const TABLE_INDEX_HINT_RE =
  /\b(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)(?:\s+FOR\s+(?:JOIN|ORDER\s+BY|GROUP\s+BY))?\s*\(/i;

const TABLE_PARTITION_HINT_RE = /\bPARTITION\s*\(/i;

const NATURAL_JOIN_RE =
  /\bNATURAL\s+((?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?(?:OUTER\s+)?JOIN\b/i;

/**
 * 前処理で取り除く修飾子と、作用説明での扱い。shown は記録して作用説明に出すもの、そうでないものは、
 * 結果の行も SQL の作用も変えない理由を reason に書く（MySQL 8.4 Reference Manual の SELECT・UPDATE・DELETE・Index Hints）。
 * 修飾子を取り除く処理を足すときは、ここに足す。黙って取り除くと、その作用が作用説明から消える
 * （UPDATE IGNORE の IGNORE を取り除き、エラーの行を飛ばすことを説明していなかった）。preprocess-removed.test.ts が確かめる
 */
export const REMOVED_MODIFIER_HANDLING: Record<string, { shown: boolean; reason: string }> = {
  ALL: { shown: false, reason: '既定の動き（重複した行も残す）と同じ' },
  DISTINCT: { shown: true, reason: 'SELECT DISTINCT に置き換えて残す' },
  DISTINCTROW: { shown: true, reason: 'DISTINCT と同じ意味なので、SELECT DISTINCT に置き換えて残す' },
  HIGH_PRIORITY: { shown: false, reason: '表のロックを待つ順番だけを変える' },
  STRAIGHT_JOIN: { shown: true, reason: '位置を記録し、結合の順を指定したと作用説明に書く' },
  SQL_SMALL_RESULT: { shown: false, reason: '一時表の使い方を選ぶオプティマイザへの指定' },
  SQL_BIG_RESULT: { shown: false, reason: '一時表の使い方を選ぶオプティマイザへの指定' },
  SQL_BUFFER_RESULT: { shown: false, reason: '結果を一時表に入れてから返す指定で、返す行は変えない' },
  SQL_NO_CACHE: { shown: false, reason: '非推奨で、何もしない' },
  SQL_CALC_FOUND_ROWS: { shown: false, reason: 'FOUND_ROWS() で読む件数を数えるだけで、返す行は変えない' },
  LOW_PRIORITY: { shown: false, reason: 'ほかのセッションが読み終わるまで実行を遅らせるだけ' },
  QUICK: { shown: false, reason: 'MyISAM で削除のときに索引の葉をまとめないだけ' },
  IGNORE: { shown: true, reason: '位置を記録し、エラーになった行を飛ばすと作用説明に書く' },
  'USE/FORCE/IGNORE INDEX': { shown: false, reason: '行を探すのに使う索引を指定するだけ' },
  PARTITION: { shown: true, reason: '書き方と位置を記録し、指定したパーティションの行だけを読むと作用説明に書く' },
};

/** SELECT 直後にだけ現れる修飾子。列名・エイリアスとしては消さない */
export const SELECT_MODIFIERS = new Set([
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'HIGH_PRIORITY',
  'STRAIGHT_JOIN',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT',
  'SQL_NO_CACHE',
  'SQL_CALC_FOUND_ROWS',
]);

/** UPDATE 直後のオプション修飾子 */
export const UPDATE_OPTION_MODIFIERS = new Set(['LOW_PRIORITY', 'IGNORE']);

/** DELETE 直後のオプション修飾子 */
export const DELETE_OPTION_MODIFIERS = new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE']);

function skipMaskedWhitespace(masked: string, pos: number): number {
  let i = pos;
  while (i < masked.length && /\s/.test(masked[i]!)) i += 1;
  return i;
}

function readWord(masked: string, pos: number): { word: string; end: number } | null {
  if (pos >= masked.length || !/[A-Za-z_]/.test(masked[pos]!)) return null;
  let i = pos + 1;
  while (i < masked.length && /[A-Za-z0-9_]/.test(masked[i]!)) i += 1;
  return { word: masked.slice(pos, i), end: i };
}

function findWholeWordStarts(masked: string, keyword: string): number[] {
  const re = new RegExp(`\\b${keyword}\\b`, 'gi');
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) starts.push(match.index);
  return starts;
}

interface ModifierStrip {
  start: number;
  end: number;
  inserted: string;
  /** UPDATE / DELETE の IGNORE の範囲 */
  ignore?: { start: number; end: number };
  recordStraightJoin?: boolean;
  /** STRAIGHT_JOIN トークン末尾（後続の SQL_SMALL_RESULT 等は含めない） */
  straightJoinEnd?: number;
}

function collectSelectModifierStrips(masked: string): ModifierStrip[] {
  const strips: ModifierStrip[] = [];
  for (const start of findWholeWordStarts(masked, 'SELECT')) {
    let optionEnd = start + 'SELECT'.length;
    let i = skipMaskedWhitespace(masked, optionEnd);
    let hasDistinct = false;
    let hasStraightJoin = false;
    let straightJoinEnd: number | undefined;
    while (true) {
      const token = readWord(masked, i);
      if (!token || !SELECT_MODIFIERS.has(token.word.toUpperCase())) break;
      const option = token.word.toUpperCase();
      if (option === 'DISTINCT' || option === 'DISTINCTROW') hasDistinct = true;
      if (option === 'STRAIGHT_JOIN') {
        hasStraightJoin = true;
        straightJoinEnd = token.end;
      }
      optionEnd = token.end;
      i = skipMaskedWhitespace(masked, token.end);
    }
    if (optionEnd === start + 'SELECT'.length) continue;

    strips.push({
      start,
      end: optionEnd,
      inserted: hasDistinct ? 'SELECT DISTINCT' : 'SELECT',
      recordStraightJoin: hasStraightJoin,
      straightJoinEnd,
    });
  }
  return strips;
}

function collectDmlOptionStrips(
  masked: string,
  keyword: 'UPDATE' | 'DELETE',
  modifiers: Set<string>,
): ModifierStrip[] {
  const strips: ModifierStrip[] = [];
  for (const start of findWholeWordStarts(masked, keyword)) {
    let optionEnd = start + keyword.length;
    let i = skipMaskedWhitespace(masked, optionEnd);
    let found = false;
    let ignore: { start: number; end: number } | undefined;
    while (true) {
      const token = readWord(masked, i);
      if (!token || !modifiers.has(token.word.toUpperCase())) break;
      found = true;
      if (token.word.toUpperCase() === 'IGNORE') ignore = { start: i, end: token.end };
      optionEnd = token.end;
      i = skipMaskedWhitespace(masked, token.end);
    }
    if (!found) continue;
    strips.push({ start, end: optionEnd, inserted: keyword, ...(ignore ? { ignore } : {}) });
  }
  return strips;
}

/** SELECT/UPDATE/DELETE 直後の修飾子だけを剥がす（WHERE や SET の同名識別子は残す） */
function stripStatementOptionModifiers(
  state: ProcessState,
  straightJoinHintSelectStarts: number[],
  straightJoinHintOriginalSpans: SourceSpan[],
  recorded?: RecordedStarts,
): SourceSpan | undefined {
  const masked = maskNonCode(state.sql);
  const strips = [
    ...collectSelectModifierStrips(masked),
    ...collectDmlOptionStrips(masked, 'UPDATE', UPDATE_OPTION_MODIFIERS),
    ...collectDmlOptionStrips(masked, 'DELETE', DELETE_OPTION_MODIFIERS),
  ].sort((a, b) => b.start - a.start);

  let dmlIgnoreSpan: SourceSpan | undefined;
  for (const strip of strips) {
    if (strip.recordStraightJoin) {
      const spanEnd = strip.straightJoinEnd ?? strip.end;
      straightJoinHintSelectStarts.push(strip.start);
      straightJoinHintOriginalSpans.push(originalSpanForProcessedRange(state, strip.start, spanEnd));
    }
    // 文は 1 つだけなので、UPDATE / DELETE の IGNORE も 1 つ。後ろから処理するので、最後に見たものが先頭の文のもの
    if (strip.ignore) dmlIgnoreSpan = originalSpanForProcessedRange(state, strip.ignore.start, strip.ignore.end);
    spliceProcessed(state, strip.start, strip.end, strip.inserted, recorded);
  }
  return dmlIgnoreSpan;
}

/** 複数テーブルの DELETE の対象に書くテーブル名（スキーマ付き・バッククォート付き・末尾の .* を含む） */
// \x60 はバッククォート。テンプレート文字列の中に書けないので、正規表現のエスケープで書く
const DELETE_TARGET_ID = String.raw`(?:\x60(?:[^\x60]|\x60\x60)+\x60|[\w$\u0080-\uFFFF]+)`;
const DELETE_TARGET = `${DELETE_TARGET_ID}(?:\\.${DELETE_TARGET_ID})?(?:\\.\\*)?`;
const DELETE_TARGET_LIST = `${DELETE_TARGET}(?:\\s*,\\s*${DELETE_TARGET})*`;
const DELETE_TARGET_RE = new RegExp(DELETE_TARGET, 'g');
/** DELETE FROM t1, t2 USING ... の形 */
const DELETE_USING_RE = new RegExp(`DELETE(\\s+)FROM\\s+(${DELETE_TARGET_LIST})\\s+USING\\b`, 'iy');
/** DELETE t1, t2 FROM ... の形 */
const DELETE_TARGETS_FROM_RE = new RegExp(`DELETE\\s+(${DELETE_TARGET_LIST})\\s+FROM\\b`, 'iy');

/**
 * 複数テーブルの DELETE を、node-sql-parser が読める形に書き換える。どちらも MySQL では同じ意味になる
 * （MySQL 8.4 リファレンス 15.2.2 DELETE Statement）。
 * - DELETE FROM t1, t2 USING t1 JOIN t2 ... → DELETE t1, t2 FROM t1 JOIN t2 ...
 * - 対象のテーブル名の後ろの .*（DELETE t1.* FROM ...）を外す
 * 対象の並びの間にコメントがあるなど、形が合わないときは書き換えず、パーサーのエラーに任せる
 */
function rewriteMultiTableDelete(state: ProcessState, recorded: RecordedStarts): void {
  const masked = maskNonCode(state.sql);
  const edits: Array<{ start: number; end: number; inserted: string }> = [];
  for (const start of findWholeWordStarts(masked, 'DELETE')) {
    DELETE_USING_RE.lastIndex = start;
    const using = DELETE_USING_RE.exec(state.sql);
    DELETE_TARGETS_FROM_RE.lastIndex = start;
    const plain = using ? null : DELETE_TARGETS_FROM_RE.exec(state.sql);
    const match = using ?? plain;
    if (!match) continue;
    const targets = match[using ? 2 : 1]!;
    const targetsStart = start + match[0].indexOf(targets, using ? 'DELETE'.length + match[1]!.length + 'FROM'.length : 'DELETE'.length);
    for (const target of targets.matchAll(DELETE_TARGET_RE)) {
      if (!target[0].endsWith('.*')) continue;
      const end = targetsStart + target.index + target[0].length;
      edits.push({ start: end - 2, end, inserted: '' });
    }
    if (using) {
      const fromStart = start + 'DELETE'.length + match[1]!.length;
      edits.push({ start: fromStart, end: fromStart + 'FROM'.length, inserted: '' });
      const usingEnd = start + match[0].length;
      edits.push({ start: usingEnd - 'USING'.length, end: usingEnd, inserted: 'FROM' });
    }
  }
  for (const { start, end, inserted } of edits.sort((a, b) => b.start - a.start)) {
    spliceProcessed(state, start, end, inserted, recorded);
  }
}

/**
 * `SUM(DISTINCT a)` の DISTINCT。MySQL は SUM・AVG・MIN・MAX の引数の前に DISTINCT を書ける
 * （MySQL 8.4 リファレンス 14.19.1）が、node-sql-parser は COUNT と GROUP_CONCAT でしか読めず、構文エラーになる。
 * `DISTINCT(a)` の形なら読めるので、DISTINCT の後ろの引数を括弧で囲む（表示は parser.ts で元の形に戻す）
 */
const AGGREGATE_DISTINCT_RE = /(?<![\w$.`\u0080-\uFFFF])(?:SUM|AVG|MIN|MAX)\s*\(\s*DISTINCT\b/giu;

function parenthesizeAggregateDistinct(state: ProcessState, recorded: RecordedStarts): void {
  const masked = maskNonCode(state.sql);
  const inserts: Array<{ at: number; text: string }> = [];
  for (const match of masked.matchAll(AGGREGATE_DISTINCT_RE)) {
    const openParen = masked.indexOf('(', match.index);
    const closeParenEnd = readBalancedParenEnd(masked, openParen);
    if (closeParenEnd == null) continue;
    const argStart = skipMaskedWhitespace(masked, match.index + match[0].length);
    let argEnd = closeParenEnd - 1;
    while (argEnd > argStart && /\s/.test(masked[argEnd - 1]!)) argEnd -= 1;
    if (argEnd <= argStart) continue;
    inserts.push({ at: argStart, text: '(' }, { at: argEnd, text: ')' });
  }
  // 後ろから挿入して、前にある挿入位置をずらさない
  inserts.sort((a, b) => b.at - a.at);
  for (const { at, text } of inserts) spliceProcessed(state, at, at, text, recorded);
}

/**
 * 集約関数の STD と VARIANCE。MySQL では STDDEV_POP と VAR_POP の別名として書ける（MySQL 8.4 リファレンス 14.19.1）が、
 * node-sql-parser は集約関数の名前として予約しているのに読む規則を持たず、構文エラーになる。
 * SQL に現れない仮の名前に置き換えて普通の関数として読ませ、表示では parser.ts が元の名前に戻す
 */
const RESERVED_AGGREGATE_NAME_RE = /(?<![\w$.`\u0080-\uFFFF])(?:STD|VARIANCE)(?=\s*\()/giu;

function renameReservedAggregates(state: ProcessState, recorded: RecordedStarts): Map<string, string> {
  const renamed = new Map<string, string>();
  const masked = maskNonCode(state.sql);
  const matches = [...masked.matchAll(RESERVED_AGGREGATE_NAME_RE)];
  if (matches.length === 0) return renamed;
  const upperSql = state.sql.toUpperCase();
  const placeholderFor = (name: string): string => {
    const upper = name.toUpperCase();
    for (const [placeholder, original] of renamed) if (original === upper) return placeholder;
    let placeholder = `QV_${upper}_`;
    while (upperSql.includes(placeholder)) placeholder += '_';
    renamed.set(placeholder, upper);
    return placeholder;
  };
  const replacements = matches.map((match) => ({ start: match.index, end: match.index + match[0].length, text: placeholderFor(match[0]) }));
  for (const { start, end, text } of replacements.reverse()) spliceProcessed(state, start, end, text, recorded);
  return renamed;
}

const SET_CLAUSE_END_WORDS = new Set(['WHERE', 'ORDER', 'LIMIT']);

/**
 * UPDATE の `SET a = DEFAULT`。MySQL は列を既定値に戻す書き方として DEFAULT を書ける
 * （MySQL 8.4 リファレンス 15.2.17 UPDATE Statement）が、node-sql-parser は `DEFAULT(a)` の関数の形しか読めない。
 * SET の値がちょうど DEFAULT の 1 語のときだけ、バッククォートで囲んで列の名前として読ませる（表示は DEFAULT のまま）
 */
function quoteUpdateSetDefault(state: ProcessState, recorded: RecordedStarts): void {
  const masked = maskNonCode(state.sql);
  const firstUpdate = findWholeWordStarts(masked, 'UPDATE')[0];
  if (firstUpdate === undefined) return;
  const starts: number[] = [];
  for (const setStart of findWholeWordStarts(masked, 'SET')) {
    if (setStart < firstUpdate) continue;
    let depth = 0;
    let i = setStart + 'SET'.length;
    /** いま読んでいる `列 = 値` の始まり（SET の直後か、深さ 0 の `,` の直後） */
    let itemStart = i;
    while (i < masked.length) {
      const ch = masked[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) itemStart = i + 1;
      if (depth < 0) break;
      const atWordStart = /[A-Za-z_]/.test(ch) && !/[\w$.`]/.test(masked[i - 1] ?? ' ');
      const token = atWordStart ? readWord(masked, i) : null;
      if (!token) {
        i += 1;
        continue;
      }
      const word = token.word.toUpperCase();
      if (depth === 0 && SET_CLAUSE_END_WORDS.has(word)) break;
      if (depth === 0 && word === 'DEFAULT') {
        const after = masked[skipMaskedWhitespace(masked, token.end)];
        const nextWord = readWord(masked, skipMaskedWhitespace(masked, token.end))?.word.toUpperCase();
        const endsValue = after === undefined || after === ',' || after === ';' || (nextWord !== undefined && SET_CLAUSE_END_WORDS.has(nextWord));
        // 値の位置（`列 =` の直後）の DEFAULT だけを見る。`b != DEFAULT` や `b = DEFAULT` の比較の右に書いた
        // DEFAULT は、MySQL でも構文エラーになる
        const isAssignedValue = /^[^=<>!:]*=$/.test(masked.slice(itemStart, i).trim());
        if (isAssignedValue && endsValue) starts.push(i);
      }
      i = token.end;
    }
  }
  for (const start of starts.sort((a, b) => b - a)) {
    spliceProcessed(state, start, start + 'DEFAULT'.length, '`DEFAULT`', recorded);
  }
}

/**
 * 文の最後の `FOR UPDATE` / `FOR SHARE`（`OF 表`・`NOWAIT`・`SKIP LOCKED` を含む）を空白に置き換え、書き方を記録する。
 * MySQL は `FOR {UPDATE | SHARE} [OF tbl_name [, tbl_name] ...] [NOWAIT | SKIP LOCKED]` を書ける
 * （MySQL 8.4 Reference Manual「SELECT Statement」「Locking Reads」）が、SQL パーサーは `FOR SHARE` と `OF` を読めない。
 * 集合演算の文と、括弧の中の指定は、どの SELECT の指定かを決めずに済むよう、これまでどおりパーサーに任せる
 */
const LOCKING_CLAUSE_START_RE = /\bFOR\s+(?:UPDATE|SHARE)\b/gi;
const LOCKING_CLAUSE_RE = /^FOR\s+(?:UPDATE|SHARE)\b(?:\s+OF\s+[^;()]+?)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/i;

function stripTrailingLockingClause(state: ProcessState): LockingClauseInfo | undefined {
  const masked = maskNonCode(state.sql);
  if (/\b(?:UNION|INTERSECT|EXCEPT)\b/i.test(masked)) return undefined;
  const last = [...masked.matchAll(LOCKING_CLAUSE_START_RE)].pop();
  if (!last) return undefined;
  const start = last.index;
  const before = masked.slice(0, start);
  if ((before.match(/\(/g)?.length ?? 0) !== (before.match(/\)/g)?.length ?? 0)) return undefined;
  if (!LOCKING_CLAUSE_RE.test(masked.slice(start))) return undefined;
  const semicolon = masked.indexOf(';', start);
  // 後ろのコメントは含めない（マスク後の文字列では空白になっている）
  const end = start + masked.slice(start, semicolon < 0 ? undefined : semicolon).trimEnd().length;
  const span = originalSpanForProcessedRange(state, start, end);
  const text = state.sql.slice(start, end).replace(/\s+/g, ' ');
  spliceProcessed(state, start, end, ' '.repeat(end - start));
  return { text, sourceSpan: span };
}

/**
 * 表の後ろの `PARTITION (p0, p1)` の書き方と位置を記録する。取り除くのは TABLE_PARTITION_HINT_RE の置き換え。
 * 指定したパーティションの行だけを読むので、読む行が変わる（MySQL 8.4 Reference Manual「Partition Selection」）
 */
function collectTablePartitions(state: ProcessState): TableModifierInfo[] {
  const masked = maskNonCode(state.sql);
  const modifiers: TableModifierInfo[] = [];
  for (const match of masked.matchAll(/\bPARTITION\s*\(/gi)) {
    const end = readBalancedParenEnd(masked, match.index + match[0].length - 1);
    if (end == null) continue;
    modifiers.push({
      kind: 'partition',
      text: state.sql.slice(match.index, end).replace(/\s+/g, ' '),
      sourceSpan: originalSpanForProcessedRange(state, match.index, end),
    });
  }
  return modifiers;
}

export function preprocessSqlForParser(sql: string): PreprocessResult {
  const state = initState(sql);
  // 位置を記録するより前、ほかの書き換えより前に取り除く（前処理に渡した SQL の座標のまま記録できる）
  const lockingClause = stripTrailingLockingClause(state);
  const tableModifiers = collectTablePartitions(state);
  const naturalJoinStarts: number[] = [];
  const straightJoinHintSelectStarts: number[] = [];
  const straightJoinHintOriginalSpans: SourceSpan[] = [];
  const recorded: RecordedStarts = { lists: [naturalJoinStarts, straightJoinHintSelectStarts] };

  applyRegexReplacementsInCode(state, [
    { pattern: TABLE_INDEX_HINT_RE, replace: () => '' },
    { pattern: TABLE_PARTITION_HINT_RE, replace: () => '' },
  ], recorded);

  const dmlIgnoreSpan = stripStatementOptionModifiers(state, straightJoinHintSelectStarts, straightJoinHintOriginalSpans, recorded);
  rewriteMultiTableDelete(state, recorded);
  quoteUpdateSetDefault(state, recorded);

  applyRegexReplacementsInCode(state, [
    {
      pattern: NATURAL_JOIN_RE,
      replace: (match) => {
        const type = match[1]?.trim().toUpperCase() || 'INNER';
        return `${type} JOIN`;
      },
      recordStartAt: (processedStart) => naturalJoinStarts.push(processedStart),
    },
  ], recorded);

  parenthesizeAggregateDistinct(state, recorded);
  const renamedFunctions = renameReservedAggregates(state, recorded);
  quoteNonAsciiIdentifiers(state, recorded);

  return {
    sql: state.sql,
    lockingClause,
    tableModifiers,
    dmlIgnoreSpan,
    naturalJoinStarts,
    straightJoinHintSelectStarts,
    straightJoinHintOriginalSpans,
    processedToOriginal: state.processedToOriginal,
    renamedFunctions,
  };
}

export function remapSourceSpan(
  map: number[],
  span: SourceSpan | undefined,
): SourceSpan | undefined {
  if (!span || span.end <= span.start) return span;
  const start = map[span.start];
  if (start === undefined) return span;
  const endAnchor = Math.min(Math.max(span.end - 1, span.start), map.length - 1);
  const endOrig = map[endAnchor];
  if (endOrig === undefined) return span;
  return { start, end: endOrig + 1 };
}

function remapSqlFragment(map: number[], fragment: SqlFragment): SqlFragment {
  const sourceSpan = remapSourceSpan(map, fragment.sourceSpan);
  return sourceSpan ? { ...fragment, sourceSpan } : fragment;
}

function remapConditionNode(
  map: number[],
  node: ConditionNode | undefined,
  originalSql?: string,
): ConditionNode | undefined {
  if (!node) return undefined;
  const sourceSpan = remapSourceSpan(map, node.sourceSpan);
  const children = node.children
    ?.map((child) => remapConditionNode(map, child, originalSql))
    .filter((child): child is ConditionNode => Boolean(child));
  const nestedQuery = node.nestedQuery
    ? remapParsedQuerySpans(map, node.nestedQuery, originalSql)
    : undefined;
  return {
    ...node,
    ...(sourceSpan ? { sourceSpan } : {}),
    ...(children?.length ? { children } : {}),
    ...(nestedQuery ? { nestedQuery } : {}),
  };
}

function skipSqlTrivia(sql: string, pos: number): number {
  let i = pos;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch !== undefined && /\s/.test(ch)) {
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
    if (ch === '/' && next === '*') {
      i = readBlockCommentEnd(sql, i);
      continue;
    }
    break;
  }
  return i;
}

function aliasEquals(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function isAsKeywordAt(sql: string, pos: number): number | null {
  if (sql.slice(pos, pos + 2).toUpperCase() !== 'AS') return null;
  if (isWordChar(sql[pos + 2])) return null;
  return pos + 2;
}

function matchAliasTokenAt(sql: string, pos: number, alias: string): number | null {
  const ch = sql[pos];
  if (ch === '`') {
    const end = readBacktickIdentifierEnd(sql, pos);
    if (end <= pos + 1 || sql[end - 1] !== '`') return null;
    const inner = sql.slice(pos + 1, end - 1).replace(/``/g, '`');
    return aliasEquals(inner, alias) ? end : null;
  }
  if (ch === "'" || ch === '"') {
    const end = readQuotedStringEnd(sql, pos, ch);
    if (end <= pos + 1 || sql[end - 1] !== ch) return null;
    const doubled = ch === "'" ? /''/g : /""/g;
    const inner = sql.slice(pos + 1, end - 1).replace(doubled, ch);
    return aliasEquals(inner, alias) ? end : null;
  }
  const end = pos + alias.length;
  if (end > sql.length) return null;
  if (!aliasEquals(sql.slice(pos, end), alias)) return null;
  if (isWordChar(sql[end])) return null;
  return end;
}

function extendColumnSpanWithAlias(
  sql: string,
  alias: string | undefined,
  span: SourceSpan | undefined,
): SourceSpan | undefined {
  if (!span || !alias) return span;
  let pos = skipSqlTrivia(sql, span.end);
  const afterAs = isAsKeywordAt(sql, pos);
  if (afterAs != null) pos = skipSqlTrivia(sql, afterAs);
  const aliasEnd = matchAliasTokenAt(sql, pos, alias);
  if (aliasEnd == null) return span;
  return { start: span.start, end: aliasEnd };
}

export function remapParsedQuerySpans(
  map: number[],
  query: ParsedQuery,
  originalSql?: string,
): ParsedQuery {
  return {
    ...query,
    sourceSpan: remapSourceSpan(map, query.sourceSpan),
    // straightJoinHintSpan は前処理時点で元 SQL 座標
    straightJoinHintSpan: query.straightJoinHintSpan,
    tables: query.tables.map((table) => ({
      ...table,
      sourceSpan: remapSourceSpan(map, table.sourceSpan),
      derivedQuery: table.derivedQuery
        ? remapParsedQuerySpans(map, table.derivedQuery, originalSql)
        : undefined,
    })),
    joins: query.joins.map((join) => ({
      ...join,
      sourceSpan: remapSourceSpan(map, join.sourceSpan),
      conditionRoot: remapConditionNode(map, join.conditionRoot, originalSql),
      layoutConditionRoot: remapConditionNode(map, join.layoutConditionRoot, originalSql),
    })),
    columns: query.columns.map((col) => {
      let sourceSpan = remapSourceSpan(map, col.sourceSpan);
      if (originalSql) {
        sourceSpan = extendColumnSpanWithAlias(originalSql, col.alias, sourceSpan);
      }
      return { ...col, sourceSpan };
    }),
    where: remapConditionNode(map, query.where, originalSql),
    having: remapConditionNode(map, query.having, originalSql),
    groupBy: query.groupBy.map((g) => remapSqlFragment(map, g)),
    orderBy: query.orderBy.map((o) => remapSqlFragment(map, o)),
    limitSpan: remapSourceSpan(map, query.limitSpan),
    offsetSpan: remapSourceSpan(map, query.offsetSpan),
    ctes: query.ctes?.map((cte) => ({
      ...cte,
      sourceSpan: remapSourceSpan(map, cte.sourceSpan),
      query: remapParsedQuerySpans(map, cte.query, originalSql),
    })),
    unionBranches: query.unionBranches?.map((branch) => ({
      ...branch,
      sourceSpan: remapSourceSpan(map, branch.sourceSpan),
      query: remapParsedQuerySpans(map, branch.query, originalSql),
    })),
    embeddedSubqueries: query.embeddedSubqueries?.map((sub) =>
      remapParsedQuerySpans(map, sub, originalSql),
    ),
    unionTail: query.unionTail
      ? {
          ...query.unionTail,
          orderBy: query.unionTail.orderBy.map((o) => remapSqlFragment(map, o)),
          limitSpan: remapSourceSpan(map, query.unionTail.limitSpan),
          offsetSpan: remapSourceSpan(map, query.unionTail.offsetSpan),
        }
      : undefined,
  };
}

/**
 * 解析結果の中のすべての範囲（sourceSpan / limitSpan など）から、終端の後ろに付いた空白とコメントを除く。
 * sql は範囲の座標の基準になっている SQL（remapParsedQuerySpans のあとなら入力の SQL）。
 * 解析結果はこの解析で作ったばかりのオブジェクトなので、範囲のオブジェクトをその場で差し替える
 */
export function trimParsedQuerySpanEnds(query: ParsedQuery, sql: string): ParsedQuery {
  const trimEnd = createTrailingTriviaTrimmer(sql);
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key.endsWith('Span') && isSpan(child)) {
        const end = trimEnd(child.start, child.end);
        if (end !== child.end) record[key] = { start: child.start, end };
      } else {
        visit(child);
      }
    }
  };
  visit(query);
  return query;
}

function isSpan(value: unknown): value is SourceSpan {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SourceSpan).start === 'number' &&
    typeof (value as SourceSpan).end === 'number'
  );
}
