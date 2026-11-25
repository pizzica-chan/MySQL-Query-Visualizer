// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { STORAGE_KEY } from './lib/app-persistence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 入力から解析までの待ち時間（App の setTimeout）より長く進める */
const AFTER_DEBOUNCE_MS = 1000;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function renderAndSettle() {
  act(() => root.render(<App />));
  act(() => {
    vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
  });
}

describe('App — 単一解析モードの初期表示', () => {
  it('未入力のまま時間が経っても、解析エラーではなくサンプル読み込みの案内を出す', () => {
    renderAndSettle();

    expect(host.querySelector('.welcome-state')).not.toBeNull();
    expect(host.querySelector('.error-state')).toBeNull();
  });
});

describe('App — 入力の保存', () => {
  it('復元した SQL は最初の描画から解析結果を出し、解析前の案内を一瞬も出さない', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT u.id FROM users u', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    act(() => root.render(<App />));
    expect(host.querySelector('.welcome-state')).toBeNull();
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });

  it('起動時が比較モードでも、単一解析に切り替えた直後に解析前の案内を出さない', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'compare', sql: 'SELECT u.id FROM users u', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    act(() => root.render(<App />));
    const analyzeButton = [...host.querySelectorAll<HTMLButtonElement>('.app-mode-btn')].find((b) =>
      b.textContent?.includes('単一'),
    )!;
    act(() => analyzeButton.click());
    expect(host.querySelector('.welcome-state')).toBeNull();
    expect(host.querySelector('.pending-state')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });

  it('前回保存した SQL を復元して解析する', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT u.id FROM users u', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();

    expect(host.querySelector('textarea')?.value).toBe('SELECT u.id FROM users u');
    expect(host.querySelector('.tab-bar')).not.toBeNull();
  });

  it('入力した SQL を保存する', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT 1 FROM t', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(saved.sql).toBe('SELECT 1 FROM t');
    expect(saved.mode).toBe('analyze');
  });
});

describe('App — 構文エラーの位置', () => {
  it('エラーの行番号を赤くし、該当箇所へ移動するボタンを出す', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT a\nFROM t\nWHERE = 1', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();

    expect(host.querySelector('.parse-error')?.textContent).toContain('3 行');
    expect(host.querySelector('.sql-line--error')?.getAttribute('data-line')).toBe('3');
    expect(host.querySelector('.sql-hl--error')).not.toBeNull();
    expect(host.querySelector('.parse-error-jump')).not.toBeNull();
  });
});

describe('App — エディタのカーソル位置と右側の表示の連動', () => {
  it('カーソルのある語に対応する要素に印を付ける', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.active = 1';
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql, sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();

    const textarea = host.querySelector('textarea')!;
    const offset = sql.indexOf('u.active') + 2;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      textarea.dispatchEvent(new Event('select', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });

    const marked = host.querySelector<HTMLElement>('.source-selectable--caret');
    expect(marked).not.toBeNull();
    const start = Number(marked!.dataset.spanStart);
    const end = Number(marked!.dataset.spanEnd);
    expect(start).toBeLessThanOrEqual(offset);
    expect(end).toBeGreaterThanOrEqual(offset);
  });
});

/** React の onChange が拾えるよう、textarea の値をネイティブの setter で入れて input を発火する */
function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App — 共有リンク', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('共有リンクの SQL を表示するが、編集するまでは保存していた自分の SQL を上書きしない', async () => {
    const own = { mode: 'analyze', sql: 'SELECT mine FROM t', sqlA: '', sqlB: '', resolveAliases: false };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(own));
    const shared = btoa(JSON.stringify({ mode: 'analyze', sql: 'SELECT shared FROM t' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    window.location.hash = `#q=r${shared}`;

    act(() => root.render(<App />));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    const textarea = host.querySelector('textarea')!;
    expect(textarea.value).toBe('SELECT shared FROM t');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT mine FROM t');

    act(() => typeInto(textarea, 'SELECT shared, edited FROM t'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT shared, edited FROM t');
  });
});

describe('App — 構文エラーの表示', () => {
  it('エディタの下には要約だけを出し、期待していた字句の一覧は右側の詳細に分ける', () => {
    renderAndSettle();
    act(() => typeInto(host.querySelector('textarea')!, 'SELECT a,, b FROM t'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    const alert = host.querySelector('.parse-error-text')!.textContent!;
    expect(alert).toContain('1 行 10 列の「,」で構文を解釈できません');
    expect(alert).not.toContain('Expected');
    expect(host.querySelector('.error-state .error-message')!.textContent).not.toContain('Expected');
    expect(host.querySelector('.error-state details.error-detail code')!.textContent).toContain('Expected');
  });
});

describe('App — 読めない共有リンク', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('中身の欠けた共有リンクを開いたら、読み込めなかったことを表示し、保存していた SQL はそのまま', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT mine FROM t', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    window.location.hash = '#q=r!!!';
    act(() => root.render(<App />));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(host.querySelector('.app-share-status')?.textContent).toContain('読み込めませんでした');
    expect(host.querySelector('textarea')!.value).toBe('SELECT mine FROM t');
  });

  it('共有リンクではないフラグメント（#foo）では何も表示しない', async () => {
    window.location.hash = '#foo';
    act(() => root.render(<App />));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(host.querySelector('.app-share-status')).toBeNull();
  });
});

describe('App — 共有リンクを開いたあとの編集', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('共有されたのと別のモードで編集した内容も保存する', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT mine FROM t', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    const shared = btoa(JSON.stringify({ mode: 'analyze', sql: 'SELECT shared FROM t' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    window.location.hash = `#q=r${shared}`;
    act(() => root.render(<App />));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    // 共有された単一解析の SQL には触らず、比較モードで SQL A を書く
    const compareButton = [...host.querySelectorAll<HTMLButtonElement>('.app-mode-btn')].find((b) =>
      b.textContent?.includes('比較'),
    )!;
    act(() => compareButton.click());
    act(() => typeInto(host.querySelectorAll('textarea')[0]!, 'SELECT a FROM t'));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.sqlA).toBe('SELECT a FROM t');
    expect(saved.mode).toBe('compare');
  });
});

describe('App — アプリを開いたタブで共有リンクを開く', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('# 以降だけが変わったとき（hashchange）も共有リンクの SQL を読み込み、直前の編集は保存しておく', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT mine FROM t', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    // 保存の待ち時間（300ms）が過ぎる前にリンクを開く
    act(() => typeInto(textarea, 'SELECT mine, edited FROM t'));

    const shared = btoa(JSON.stringify({ mode: 'compare', sqlA: 'SELECT a FROM t', sqlB: 'SELECT b FROM t' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    window.location.hash = `#q=r${shared}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    const editors = host.querySelectorAll('textarea');
    expect(editors).toHaveLength(2);
    expect(editors[0]!.value).toBe('SELECT a FROM t');
    expect(editors[1]!.value).toBe('SELECT b FROM t');
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.sql).toBe('SELECT mine, edited FROM t');
    expect(saved.mode).toBe('analyze');
  });
});

describe('App — タブのキーボード操作と選択の状態', () => {
  function key(target: Element, name: string) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  }

  it('解析結果のタブは選んでいるタブを aria-selected で示し、← → Home End で移る', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql: 'SELECT u.id FROM users u', sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();
    const selected = () => host.querySelector('.tab-list [role="tab"][aria-selected="true"]')?.textContent;
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('.tab-list [role="tab"]')];
    expect(selected()).toBe('SQL構造');
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    key(tabs()[0]!, 'ArrowRight');
    expect(selected()).toBe('作用説明');
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1]!, 'End');
    expect(selected()).toBe('JOIN 図');
    key(tabs()[2]!, 'ArrowRight');
    expect(selected()).toBe('SQL構造');
    key(tabs()[0]!, 'ArrowLeft');
    expect(selected()).toBe('JOIN 図');

    const panel = host.querySelector('[role="tabpanel"].tab-content')!;
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe('JOIN 図');
  });

  it('モード切り替えも ← → で移り、選んでいるほうだけが Tab キーで止まる', () => {
    renderAndSettle();
    const modeTabs = () => [...host.querySelectorAll<HTMLButtonElement>('.app-mode-switch [role="tab"]')];
    expect(modeTabs().map((t) => t.tabIndex)).toEqual([0, -1]);
    key(modeTabs()[0]!, 'ArrowRight');
    expect(host.querySelectorAll('textarea')).toHaveLength(2);
    expect(modeTabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(modeTabs()[1]);
    expect(modeTabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
  });
});

describe('App — サンプルの読み込みと元に戻す', () => {
  function clickSample(label: string, editorIndex = 0) {
    const editor = host.querySelectorAll('.sql-editor')[editorIndex]!;
    const button = [...editor.querySelectorAll<HTMLButtonElement>('.sample-load-btn')].find(
      (b) => b.textContent?.trim() === label,
    )!;
    act(() => {
      button.focus();
      button.click();
    });
  }

  function undoButton() {
    return [...host.querySelectorAll<HTMLButtonElement>('.sql-editor-notice button')].find(
      (b) => b.textContent === '元に戻す',
    );
  }

  it('入力していた SQL をサンプルで置き換えたら、「元に戻す」で前の SQL に戻せる', () => {
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT mine FROM t'));
    clickSample('UPDATE');
    expect(textarea.value).toMatch(/^UPDATE/);
    // happy-dom には execCommand が無く、値を直接差し替える。この場合は Ctrl+Z では戻せないので案内しない
    expect(host.querySelector('.sql-editor-notice')!.textContent).not.toContain('Ctrl+Z');

    act(() => undoButton()!.click());
    expect(textarea.value).toBe('SELECT mine FROM t');
    expect(undoButton()).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).sql).toBe('SELECT mine FROM t');
  });

  it('空の入力にサンプルを入れたときは「元に戻す」を出さない', () => {
    renderAndSettle();
    clickSample('SELECT');
    expect(host.querySelector('textarea')!.value).toMatch(/^SELECT/);
    expect(undoButton()).toBeUndefined();
  });

  it('置き換えたあとに編集したら「元に戻す」を消す（編集した内容を戻さないため）', () => {
    renderAndSettle();
    const textarea = host.querySelector('textarea')!;
    act(() => typeInto(textarea, 'SELECT mine FROM t'));
    clickSample('SELECT');
    expect(undoButton()).toBeDefined();
    act(() => typeInto(textarea, `${textarea.value}\nLIMIT 1`));
    expect(undoButton()).toBeUndefined();
  });

  it('比較モードの SQL A でも、置き換え前の SQL に戻せる', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'compare', sql: '', sqlA: 'SELECT a FROM t', sqlB: 'SELECT b FROM t', resolveAliases: false }),
    );
    renderAndSettle();
    clickSample('DELETE');
    const [a, b] = host.querySelectorAll('textarea');
    expect(a!.value).toMatch(/^DELETE/);
    act(() => undoButton()!.click());
    expect(a!.value).toBe('SELECT a FROM t');
    expect(b!.value).toBe('SELECT b FROM t');
  });
});

describe('App — エディタのキー操作', () => {
  function renderWithSql(sql: string) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'analyze', sql, sqlA: '', sqlB: '', resolveAliases: false }),
    );
    renderAndSettle();
    return host.querySelector('textarea')!;
  }

  it('日本語の変換中の Tab では字下げしない', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    expect(textarea.value).toBe('SELECT a FROM t');
  });

  it('変換中でない Tab ではカーソル位置に字下げを入れる', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('SELECT   a FROM t');
  });

  it('Esc のあとの Shift+Tab は、Shift の押下で印が消えず、字下げを戻さない（前の項目へ移る）', () => {
    const textarea = renderWithSql('  SELECT a FROM t');
    const send = (init: KeyboardEventInit) =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    let tabPrevented = true;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(4, 4);
      send({ key: 'Escape' });
      send({ key: 'Shift', shiftKey: true });
      tabPrevented = !send({ key: 'Tab', shiftKey: true });
    });
    expect(textarea.value).toBe('  SELECT a FROM t');
    expect(tabPrevented).toBe(false);
  });

  it('Esc のあとでもフォーカスが一度外れたら、次の Tab は字下げする', () => {
    const textarea = renderWithSql('SELECT a FROM t');
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      textarea.blur();
      textarea.focus();
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('SELECT   a FROM t');
  });

  it('サンプルの読み込みなど入力以外で SQL を差し替えたら、カーソル連動の枠を外す', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.active = 1';
    const textarea = renderWithSql(sql);
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(sql.indexOf('u.active') + 2, sql.indexOf('u.active') + 2);
      textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(host.querySelector('.source-selectable--caret')).not.toBeNull();

    const sampleButton = host.querySelector<HTMLButtonElement>('.sql-editor .sample-load-btn')!;
    act(() => {
      sampleButton.focus();
      sampleButton.click();
    });
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });
    expect(host.querySelector('.source-selectable--caret')).toBeNull();
  });

  it('説明の参照先（aria-describedby）は、エラーの有無にかかわらず実在する要素を指す', () => {
    const ok = renderWithSql('SELECT a FROM t');
    expect(document.getElementById(ok.getAttribute('aria-describedby')!)).not.toBeNull();
  });

  it('エラーの表示中は、説明の参照先がエラーの表示を指す', () => {
    const bad = renderWithSql('SELECT a,\nFROM t');
    const target = document.getElementById(bad.getAttribute('aria-describedby')!);
    expect(target?.classList.contains('parse-error')).toBe(true);
  });
});
