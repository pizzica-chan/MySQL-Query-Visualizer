import { describe, expect, it } from 'vitest';
import { parseMySqlQuery } from './parser';
import { buildQueryEffect } from './query-effect';
import {
  DELETE_OPTION_MODIFIERS,
  REMOVED_MODIFIER_HANDLING,
  SELECT_MODIFIERS,
  UPDATE_OPTION_MODIFIERS,
} from './sql-preprocess';

/**
 * 前処理で取り除く修飾子は、すべて扱いを決めておく（REMOVED_MODIFIER_HANDLING）。
 * 黙って取り除くと、その作用が作用説明から消え、SQL の作用を違うものとして説明してしまう
 * （UPDATE IGNORE の IGNORE を取り除き、エラーになった行を飛ばすことを説明していなかった）
 */
describe('前処理で取り除く修飾子', () => {
  it.each([...SELECT_MODIFIERS, ...UPDATE_OPTION_MODIFIERS, ...DELETE_OPTION_MODIFIERS])(
    '%s の扱い（作用説明に出すか、出さない理由）を決めている',
    (modifier) => {
      expect(REMOVED_MODIFIER_HANDLING[modifier]?.reason).toBeTruthy();
    },
  );

  /** 作用説明に出すと決めたものは、実際に出ていることを、元の SQL の位置まで確かめる */
  const SHOWN_EXAMPLES: Record<string, { sql: string; text: string; spanText: string }> = {
    DISTINCT: { sql: 'SELECT DISTINCT u.id FROM users u', text: 'DISTINCT', spanText: '' },
    DISTINCTROW: { sql: 'SELECT DISTINCTROW u.id FROM users u', text: 'DISTINCT', spanText: '' },
    STRAIGHT_JOIN: { sql: 'SELECT STRAIGHT_JOIN u.id FROM users u JOIN orders o ON o.user_id = u.id', text: 'STRAIGHT_JOIN', spanText: '' },
    IGNORE: { sql: 'UPDATE IGNORE users SET code = 1 WHERE id > 10', text: 'IGNORE — 更新の途中でエラーになっても', spanText: 'IGNORE' },
    PARTITION: { sql: 'SELECT * FROM users PARTITION (p0) u', text: 'PARTITION (p0) — 表のうち', spanText: 'PARTITION (p0)' },
  };

  it.each(Object.entries(REMOVED_MODIFIER_HANDLING).filter(([, h]) => h.shown).map(([name]) => name))(
    '作用説明に出すと決めた %s は、作用説明に出ている',
    (modifier) => {
      const example = SHOWN_EXAMPLES[modifier];
      expect(example, `${modifier} の例を SHOWN_EXAMPLES に足す`).toBeDefined();
      const parsed = parseMySqlQuery(example!.sql);
      if (!parsed.success) throw new Error(parsed.error.message);
      const lines = buildQueryEffect(parsed.query, 'japanese').sections.flatMap((s) => s.lines ?? []);
      const line = lines.find((l) => l.text.includes(example!.text));
      expect(line, lines.map((l) => l.text).join('\n')).toBeDefined();
      if (example!.spanText) {
        expect(example!.sql.slice(line!.sourceSpan!.start, line!.sourceSpan!.end)).toBe(example!.spanText);
      }
    },
  );

  it('DELETE IGNORE も、エラーで文を止めないと書く', () => {
    const sql = 'DELETE LOW_PRIORITY QUICK IGNORE FROM users WHERE id > 10';
    const parsed = parseMySqlQuery(sql);
    if (!parsed.success) throw new Error(parsed.error.message);
    const line = buildQueryEffect(parsed.query, 'japanese')
      .sections.flatMap((s) => s.lines ?? [])
      .find((l) => l.text.startsWith('IGNORE — 削除の途中で'));
    expect(line).toBeDefined();
    expect(sql.slice(line!.sourceSpan!.start, line!.sourceSpan!.end)).toBe('IGNORE');
  });
});
