import { describe, expect, it } from 'vitest';
import { readBalancedParenEnd } from './sql-lex';

describe('sql-lex', () => {
  describe('readBalancedParenEnd', () => {
    it('対応する閉じ括弧の直後を返す', () => {
      expect(readBalancedParenEnd('(a, b)', 0)).toBe(6);
      expect(readBalancedParenEnd('USE INDEX (idx_a, (idx_b))', 10)).toBe(26);
    });

    it('文字列・コメント内の括弧は数えない', () => {
      expect(readBalancedParenEnd("('a)b')", 0)).toBe(7);
      expect(readBalancedParenEnd('(`x)y`)', 0)).toBe(7);
      expect(readBalancedParenEnd('(idx /* ) */ )', 0)).toBe(14);
      expect(readBalancedParenEnd('(idx # )\n)', 0)).toBe(10);
      expect(readBalancedParenEnd('(idx -- )\n)', 0)).toBe(11);
    });

    it('閉じ括弧が無ければ null', () => {
      expect(readBalancedParenEnd('(idx', 0)).toBeNull();
      expect(readBalancedParenEnd('idx', 0)).toBeNull();
    });
  });
});
