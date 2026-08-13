import {
  isDashLineCommentStart,
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

export interface PreprocessResult {
  sql: string;
  naturalJoinStarts: number[];
  straightJoinHintSelectStarts: number[];
  /** straightJoinHintSelectStarts と同じ順。元 SQL 上の SELECT … STRAIGHT_JOIN 範囲 */
  straightJoinHintOriginalSpans: SourceSpan[];
  /** preprocessed[i] の文字が元 SQL のどの位置か */
  processedToOriginal: number[];
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

/** SELECT 直後にだけ現れる修飾子。列名・エイリアスとしては消さない */
const SELECT_MODIFIERS = new Set([
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
const UPDATE_OPTION_MODIFIERS = new Set(['LOW_PRIORITY', 'IGNORE']);

/** DELETE 直後のオプション修飾子 */
const DELETE_OPTION_MODIFIERS = new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE']);

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
    while (true) {
      const token = readWord(masked, i);
      if (!token || !modifiers.has(token.word.toUpperCase())) break;
      found = true;
      optionEnd = token.end;
      i = skipMaskedWhitespace(masked, token.end);
    }
    if (!found) continue;
    strips.push({ start, end: optionEnd, inserted: keyword });
  }
  return strips;
}

/** SELECT/UPDATE/DELETE 直後の修飾子だけを剥がす（WHERE や SET の同名識別子は残す） */
function stripStatementOptionModifiers(
  state: ProcessState,
  straightJoinHintSelectStarts: number[],
  straightJoinHintOriginalSpans: SourceSpan[],
  recorded?: RecordedStarts,
): void {
  const masked = maskNonCode(state.sql);
  const strips = [
    ...collectSelectModifierStrips(masked),
    ...collectDmlOptionStrips(masked, 'UPDATE', UPDATE_OPTION_MODIFIERS),
    ...collectDmlOptionStrips(masked, 'DELETE', DELETE_OPTION_MODIFIERS),
  ].sort((a, b) => b.start - a.start);

  for (const strip of strips) {
    if (strip.recordStraightJoin) {
      const spanEnd = strip.straightJoinEnd ?? strip.end;
      straightJoinHintSelectStarts.push(strip.start);
      straightJoinHintOriginalSpans.push(originalSpanForProcessedRange(state, strip.start, spanEnd));
    }
    spliceProcessed(state, strip.start, strip.end, strip.inserted, recorded);
  }
}

export function preprocessSqlForParser(sql: string): PreprocessResult {
  const state = initState(sql);
  const naturalJoinStarts: number[] = [];
  const straightJoinHintSelectStarts: number[] = [];
  const straightJoinHintOriginalSpans: SourceSpan[] = [];
  const recorded: RecordedStarts = { lists: [naturalJoinStarts, straightJoinHintSelectStarts] };

  applyRegexReplacementsInCode(state, [
    { pattern: TABLE_INDEX_HINT_RE, replace: () => '' },
    { pattern: TABLE_PARTITION_HINT_RE, replace: () => '' },
  ], recorded);

  stripStatementOptionModifiers(state, straightJoinHintSelectStarts, straightJoinHintOriginalSpans, recorded);

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

  return {
    sql: state.sql,
    naturalJoinStarts,
    straightJoinHintSelectStarts,
    straightJoinHintOriginalSpans,
    processedToOriginal: state.processedToOriginal,
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

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
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
  if (isIdentChar(sql[pos + 2])) return null;
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
  if (isIdentChar(sql[end])) return null;
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
  };
}
