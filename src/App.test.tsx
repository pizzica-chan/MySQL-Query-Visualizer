// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 入力から解析までの待ち時間（App の setTimeout）より長く進める */
const AFTER_DEBOUNCE_MS = 1000;

describe('App — 単一解析モードの初期表示', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('未入力のまま時間が経っても、解析エラーではなくサンプル読み込みの案内を出す', () => {
    act(() => root.render(<App />));
    act(() => {
      vi.advanceTimersByTime(AFTER_DEBOUNCE_MS);
    });

    expect(host.querySelector('.welcome-state')).not.toBeNull();
    expect(host.querySelector('.error-state')).toBeNull();
  });
});
