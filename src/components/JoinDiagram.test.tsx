// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { JoinDiagram } from './JoinDiagram';
import { parseMySqlQuery, SAMPLE_SQL } from '../lib/parser';

describe('JoinDiagram', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  function mount(props: React.ComponentProps<typeof JoinDiagram>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<JoinDiagram {...props} />);
    });
  }

  it('SAMPLE_SQL の JOIN 図をクラッシュなく描画する', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(() =>
      mount({
        tables: result.query.tables,
        joins: result.query.joins,
        resolveAliases: false,
      }),
    ).not.toThrow();

    expect(container.querySelector('.join-diagram')).toBeTruthy();
    expect(container.querySelector('.react-flow')).toBeTruthy();
    expect(container.querySelector('.react-flow__minimap')).toBeTruthy();
  });

  it('同一 props の再描画で無限ループしない', () => {
    const result = parseMySqlQuery(SAMPLE_SQL);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const props = {
      tables: result.query.tables,
      joins: result.query.joins,
      resolveAliases: false,
    };

    mount(props);

    expect(() => {
      for (let i = 0; i < 20; i++) {
        act(() => {
          root.render(<JoinDiagram {...props} />);
        });
      }
    }).not.toThrow();
  });

  it('テーブル 0 件では empty-state を表示し React Flow をマウントしない', () => {
    mount({ tables: [], joins: [], resolveAliases: false });
    expect(container.querySelector('.empty-state')).toBeTruthy();
    expect(container.querySelector('.react-flow')).toBeFalsy();
  });
});
