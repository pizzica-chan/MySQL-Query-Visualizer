/**
 * SQL前後比較の、実データで結果を突き合わせる確認用の SQL。
 *
 * 構文の比較だけでは、結果が同じとは言い切れない。利用者が自分の DB で 2 本の SQL の結果を比べられるよう、
 * `A EXCEPT ALL B` と `B EXCEPT ALL A` を作る。どちらも 0 行なら、その時点のデータでは、
 * 同じ行が同じ数だけ返っている（並び順は比べない）。
 * EXCEPT は MySQL 8.0.31 で入った（MySQL 8.0.31 リリースノート）。ALL を付けると、重複した行の数も比べる。
 *
 * ここでは SQL を作るだけで、どこにも送らない。
 */
import { maskNonCode } from './sql-lex';
import type { ParsedQuery } from './types';

/** 末尾の `;`（と、その後ろの空白とコメント）を除いた SQL。`;` が残ると、括弧の中に文の区切りが入る */
function statementBody(query: ParsedQuery): string {
  const sql = query.rawSql.trim();
  const masked = maskNonCode(sql);
  let end = masked.length;
  for (;;) {
    while (end > 0 && /\s/.test(masked[end - 1]!)) end -= 1;
    if (end > 0 && masked[end - 1] === ';') {
      end -= 1;
      continue;
    }
    break;
  }
  // 末尾のコメントは残す（end より後ろにあるのは空白とコメントだけ）。`;` を除いたときだけ切る
  return end < masked.trimEnd().length ? sql.slice(0, end) : sql;
}

/**
 * EXCEPT ALL の片側。括弧で囲んだクエリには WITH を書けない（MySQL 8.4 リファレンス 15.2.11）ので、
 * WITH を使う SQL は派生テーブルで囲む（派生テーブルの中には WITH を書ける。15.2.20）。
 * 派生テーブルは列の名前が重なるとエラーになるので、WITH の無い SQL は括弧で囲む
 */
function operand(query: ParsedQuery, alias: string): string {
  const body = statementBody(query);
  // 末尾に `-- …` のコメントがあっても閉じ括弧を消さないよう、閉じ括弧の前で改行する
  if (query.ctes?.length) return `SELECT * FROM (\n${body}\n) AS ${alias}`;
  return `(\n${body}\n)`;
}

/** 確認用の SQL。両方が SELECT のときだけ作る（UPDATE と DELETE は、実行するとデータが変わる） */
export function buildVerificationSql(queryA: ParsedQuery, queryB: ParsedQuery): string | null {
  if (queryA.statementType !== 'SELECT' || queryB.statementType !== 'SELECT') return null;
  const a = operand(queryA, 'verify_a');
  const b = operand(queryB, 'verify_b');
  return [
    '-- 1. A にあって B に無い行（同じ行が返る数も比べる）',
    a,
    'EXCEPT ALL',
    `${b};`,
    '',
    '-- 2. B にあって A に無い行',
    b,
    'EXCEPT ALL',
    `${a};`,
  ].join('\n');
}
