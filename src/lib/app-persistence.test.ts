import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEY,
  decodeSharePayload,
  encodeSharePayload,
  readStoredState,
  writeStoredState,
} from './app-persistence';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe('入力の保存', () => {
  it('書いた状態をそのまま読み戻せる', () => {
    const storage = memoryStorage();
    const state = { mode: 'compare' as const, sql: 'SELECT 1', sqlA: 'SELECT a', sqlB: 'SELECT b', resolveAliases: true };
    writeStoredState(storage, state);
    expect(readStoredState(storage)).toEqual(state);
  });

  it('壊れた JSON や型の違う項目は無視する', () => {
    expect(readStoredState(memoryStorage({ [STORAGE_KEY]: '{not json' }))).toEqual({});
    expect(
      readStoredState(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ mode: 'other', sql: 1, sqlA: 'x' }) })),
    ).toEqual({ sqlA: 'x' });
  });

  it('ストレージが無い・例外を投げるときも、空の状態で続けられる', () => {
    expect(readStoredState(null)).toEqual({});
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readStoredState(throwing)).toEqual({});
    expect(() =>
      writeStoredState(throwing, { mode: 'analyze', sql: '', sqlA: '', sqlB: '', resolveAliases: false }),
    ).not.toThrow();
  });
});

describe('共有リンク', () => {
  it('単一解析と比較の SQL を往復できる（日本語や記号を含む）', async () => {
    const single = { mode: 'analyze' as const, sql: "SELECT * FROM t WHERE name = '山田' -- #&?=" };
    expect(await decodeSharePayload(`#${await encodeSharePayload(single)}`)).toEqual(single);

    const compare = { mode: 'compare' as const, sqlA: 'SELECT a FROM t', sqlB: 'SELECT b FROM t' };
    expect(await decodeSharePayload(await encodeSharePayload(compare))).toEqual(compare);
  });

  it('URL に入れられる文字だけで作る', async () => {
    const fragment = await encodeSharePayload({ mode: 'analyze', sql: 'SELECT /* + / = */ 1' });
    expect(fragment).toMatch(/^q=[dr][A-Za-z0-9_-]+$/);
  });

  it('圧縮なしの形式も読める', async () => {
    const json = JSON.stringify({ mode: 'analyze', sql: 'SELECT 1' });
    const raw = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeSharePayload(`#q=r${raw}`)).toEqual({ mode: 'analyze', sql: 'SELECT 1' });
  });

  it('共有リンクでないフラグメントや壊れた値は null', async () => {
    expect(await decodeSharePayload('#section-1')).toBeNull();
    expect(await decodeSharePayload('#q=d!!!')).toBeNull();
    expect(await decodeSharePayload('#q=x' + btoa('{}'))).toBeNull();
    const wrongShape = btoa(JSON.stringify({ mode: 'compare', sqlA: 'a' }));
    expect(await decodeSharePayload(`#q=r${wrongShape}`)).toBeNull();
  });
});
