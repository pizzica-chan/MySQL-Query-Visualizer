import { describe, expect, it } from 'vitest';
import { SAMPLE_SQL, parseMySqlQuery } from './parser';
import { segmentEffectText } from './effect-text-highlight';
import type { ParsedQuery } from './types';

function kinds(text: string, query?: ParsedQuery) {
  return segmentEffectText(text, query).filter((s) => s.kind).map((s) => ({ kind: s.kind, text: s.text }));
}

describe('effect-text-highlight', () => {
  it('JOIN 種別とテーブル名をハイライトする', () => {
    const query = parseMySqlQuery(SAMPLE_SQL);
    expect(query.success).toBe(true);
    if (!query.success) return;

    const line =
      'o と order_items（oi）は実質 INNER JOIN — 結合条件「oi.order_id = o.id」を満たす組み合わせのみ残る。SQL上は LEFT JOIN（order_items（oi）が無い行も o は残る）だが、後続の INNER JOIN により order_items（oi）が無い行も除外される';
    const highlighted = kinds(line, query.query);

    expect(highlighted.some((s) => s.kind === 'keyword' && s.text === '実質 INNER JOIN')).toBe(true);
    expect(highlighted.some((s) => s.kind === 'keyword' && s.text === 'LEFT JOIN')).toBe(true);
    expect(highlighted.some((s) => s.kind === 'keyword' && s.text === 'INNER JOIN')).toBe(true);
    expect(highlighted.some((s) => s.kind === 'keyword' && s.text === 'SQL上は')).toBe(true);
    expect(highlighted.some((s) => s.kind === 'table' && s.text === 'order_items（oi）')).toBe(true);
    expect(highlighted.some((s) => s.kind === 'table' && s.text === 'o')).toBe(true);
  });

  it('結合条件の括弧内で列参照をハイライトする', () => {
    const query = parseMySqlQuery(SAMPLE_SQL);
    expect(query.success).toBe(true);
    if (!query.success) return;

    const segments = segmentEffectText('結合条件「oi.order_id = o.id」を満たす', query.query);
    expect(segments.some((s) => s.kind === 'column' && s.text === 'oi.order_id')).toBe(true);
    expect(segments.some((s) => s.kind === 'column' && s.text === 'o.id')).toBe(true);
    expect(segments.some((s) => s.kind === 'string' && s.text === '「')).toBe(true);
  });

  it('query 未指定でも SQL キーワードをハイライトする', () => {
    const highlighted = kinds('users と orders を INNER JOIN');
    expect(highlighted.some((s) => s.kind === 'keyword' && s.text === 'INNER JOIN')).toBe(true);
  });

  it('短い別名が単語途中にマッチしない', () => {
    const query = parseMySqlQuery(`
      SELECT o.order_no FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
    `);
    expect(query.success).toBe(true);
    if (!query.success) return;

    const segments = segmentEffectText('order_items（oi）が無い', query.query);
    expect(segments.some((s) => s.kind === 'table' && s.text === 'order_items（oi）')).toBe(true);
    expect(segments.some((s) => s.text === 'oi）が')).toBe(false);
  });

  it('原文テキストを欠落なく復元できる', () => {
    const query = parseMySqlQuery(SAMPLE_SQL);
    expect(query.success).toBe(true);
    if (!query.success) return;

    const line =
      'o と order_items（oi）は実質 INNER JOIN — 結合条件「oi.order_id = o.id」を満たす組み合わせのみ残る';
    const restored = segmentEffectText(line, query.query).map((s) => s.text).join('');
    expect(restored).toBe(line);
  });
});
