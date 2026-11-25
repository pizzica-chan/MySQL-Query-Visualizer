// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMySqlQuery } from '../lib/parser';
import { compareQueryResults } from '../lib/query-result-diff';
import { QueryResultDiffPanel } from './QueryResultDiffPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function diffOf(a: string, b: string) {
  const ra = parseMySqlQuery(a);
  const rb = parseMySqlQuery(b);
  if (!ra.success || !rb.success) throw new Error('parse');
  return compareQueryResults(ra.query, rb.query);
}

function render(a: string, b: string) {
  act(() => root.render(<QueryResultDiffPanel diff={diffOf(a, b)} hasSqlA hasSqlB />));
}

describe('QueryResultDiffPanel', () => {
  it('構文が一致しただけのときは「構文の違いなし」と出し、確認用の SQL を開いて出す', () => {
    // > は等価性の証明の範囲（INNER JOIN・AND・=）の外
    render('SELECT u.id FROM users u WHERE u.a > 1', 'select u.id from users u where u.a > 1');
    expect(host.querySelector('.result-diff-summary--no-diff')).not.toBeNull();
    expect(host.querySelector('.result-diff-summary-row-value')?.textContent).toBe('構文の違いなし');
    expect(host.querySelector('details.result-diff-verify')?.hasAttribute('open')).toBe(true);
    expect(host.querySelector('.result-diff-verify code')?.textContent).toContain('EXCEPT ALL');
  });

  it('等価性を証明できたときだけ緑の「同じ（証明済み）」を出す', () => {
    const sql = 'SELECT DISTINCT u.id FROM users u JOIN orders o ON o.user_id = u.id';
    render(sql, sql);
    expect(host.querySelector('.result-diff-summary--same')).not.toBeNull();
    expect(host.querySelector('.result-diff-summary-row-value')?.textContent).toBe('同じ（証明済み）');
  });

  // SQL を書き換えたあとも「コピーしました」が残ると、今の SQL をコピーしたように読める
  it('コピーの知らせは、コピーした SQL を表示しているあいだだけ出す', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render('SELECT u.id FROM users u', 'SELECT u.id FROM users u');
    const button = [...host.querySelectorAll('.result-diff-verify button')].find((b) => b.textContent?.includes('コピー'));
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('EXCEPT ALL'));
    expect(host.querySelector('.result-diff-verify-status')?.textContent).toBe('コピーしました');

    render('SELECT u.id FROM users u', 'SELECT u.name FROM users u');
    expect(host.querySelector('.result-diff-verify-status')?.textContent).toBe('');
  });

  it('UPDATE どうしでは確認用の SQL を出さない', () => {
    render('UPDATE users u SET u.a = 1', 'UPDATE users u SET u.a = 2');
    expect(host.querySelector('.result-diff-verify')).toBeNull();
  });
});
