import { describe, expect, it } from 'vitest';
import { toSourceSpan, spansEqual } from './source-span';

describe('source-span', () => {
  it('toSourceSpan は loc から offset 範囲を作る', () => {
    expect(
      toSourceSpan({
        start: { offset: 10 },
        end: { offset: 20 },
      }),
    ).toEqual({ start: 10, end: 20 });
  });

  it('toSourceSpan は不正 loc を undefined にする', () => {
    expect(toSourceSpan(undefined)).toBeUndefined();
    expect(toSourceSpan({ start: { offset: 5 }, end: { offset: 5 } })).toBeUndefined();
  });

  it('spansEqual は同一範囲のみ true', () => {
    expect(spansEqual({ start: 1, end: 3 }, { start: 1, end: 3 })).toBe(true);
    expect(spansEqual({ start: 1, end: 3 }, { start: 1, end: 4 })).toBe(false);
  });
});
