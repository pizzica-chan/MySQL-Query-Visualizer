import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAliasResolution } from './alias-resolver';
import {
  auditDistBundle,
  auditRuntimeSources,
  auditSourceText,
  auditBundledText,
  installOfflineGuard,
  type OfflineViolation,
} from './fixtures/offline-audit';
import { SQL_TEST_CASES } from './fixtures/sql-cases';
import {
  parseMySqlQuery,
  SAMPLE_SQL,
  UPDATE_SAMPLE_SQL,
  DELETE_SAMPLE_SQL,
  UNION_SAMPLE_SQL,
} from './parser';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('オフライン実行（外部通信なし）', () => {
  describe('静的監査 — 実行時ソース', () => {
    it('index.html / src に外部 URL・通信 API がない', () => {
      const violations = auditRuntimeSources(PROJECT_ROOT);
      expect(violations, formatViolations(violations)).toEqual([]);
    });

    it('禁止パターン検出器が外部 URL を検出できる', () => {
      const sample = ["await fetch('", 'https://api.example.com/parse', "', { body: sql })"].join('');
      const violations = auditSourceText(sample);
      expect(violations.some((v) => v.rule === 'fetch-call')).toBe(true);
      expect(violations.some((v) => v.rule === 'external-url')).toBe(true);
    });

    it('dist 監査は React エラーメッセージ内 URL を通信とみなさない', () => {
      const reactErrorSnippet =
        'var t="https://react.dev/errors/"+Je+"; visit "+t+" for the full message";';
      const violations = auditBundledText(reactErrorSnippet);
      expect(violations).toEqual([]);
    });

    it('dist 監査は fetch("https://...") を検出できる', () => {
      const violations = auditBundledText('fetch("https://api.example.com/x")');
      expect(violations.some((v) => v.rule === 'fetch-external')).toBe(true);
    });
  });

  describe('静的監査 — dist 成果物', () => {
    it('dist が存在する場合、バンドルに外部 URL が含まれない', () => {
      if (!existsSync(resolve(PROJECT_ROOT, 'dist/index.html'))) {
        return;
      }
      const violations = auditDistBundle(PROJECT_ROOT);
      expect(violations, formatViolations(violations ?? [])).toEqual([]);
    });

    it('dist/index.html は file:// 直開き向けの単一 HTML になっている', () => {
      const distDir = resolve(PROJECT_ROOT, 'dist');
      const htmlPath = resolve(distDir, 'index.html');
      if (!existsSync(htmlPath)) return;

      expect(readdirSync(distDir)).toEqual(['index.html']);

      const html = readFileSync(htmlPath, 'utf8');
      expect(html).not.toMatch(/<script[^>]+type="module"[^>]+src=/i);
      expect(html).not.toMatch(/<script[^>]+src=["']\.\/assets\//i);
      expect(html).toMatch(/<script>var /);

      const rootIdx = html.indexOf('id="root"');
      const scriptIdx = html.indexOf('<script');
      expect(rootIdx).toBeGreaterThan(-1);
      expect(scriptIdx).toBeGreaterThan(rootIdx);
    });
  });

  describe('実行時ガード — 解析処理', () => {
    let restore: (() => string[]) | undefined;

    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    it('全サンプル SQL 解析中に外部通信 API が呼ばれない', () => {
      restore = installOfflineGuard();

      for (const sql of [SAMPLE_SQL, UPDATE_SAMPLE_SQL, DELETE_SAMPLE_SQL, UNION_SAMPLE_SQL]) {
        const result = parseMySqlQuery(sql);
        expect(result.success).toBe(true);
      }

      expect(restore()).toEqual([]);
    });

    it('全成功フィクスチャ SQL 解析中に外部通信 API が呼ばれない', () => {
      restore = installOfflineGuard();

      const successCases = SQL_TEST_CASES.filter((c) => c.expectSuccess);
      for (const testCase of successCases) {
        const result = parseMySqlQuery(testCase.sql);
        expect(
          result.success,
          `${testCase.name}: ${!result.success ? result.error.message : ''}`,
        ).toBe(true);
      }

      expect(restore()).toEqual([]);
    });

    it('エイリアス解決中に外部通信 API が呼ばれない', () => {
      restore = installOfflineGuard();

      const result = parseMySqlQuery(SAMPLE_SQL);
      expect(result.success).toBe(true);
      if (!result.success) return;

      applyAliasResolution(result.query, true);
      applyAliasResolution(result.query, false);

      expect(restore()).toEqual([]);
    });
  });
});

function formatViolations(violations: OfflineViolation[]): string {
  if (violations.length === 0) return '';
  return violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.snippet}`).join('\n');
}
