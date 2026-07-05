import { describe, expect, it } from 'vitest';
import { parseMySqlQuery, SAMPLE_SQL } from './parser';

describe('column sourceSpan', () => {
  it('SELECT 列ごとに異なる sourceSpan を持つ', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const spans = result.query.columns.map((c) => c.sourceSpan);
    expect(spans.every(Boolean)).toBe(true);

    const unique = new Set(spans.map((s) => `${s!.start}:${s!.end}`));
    expect(unique.size).toBe(result.query.columns.length);

    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        expect(spans[i]!.start).not.toBe(spans[j]!.start);
      }
    }
  });
});
