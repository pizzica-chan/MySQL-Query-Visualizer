import { describe, expect, it } from 'vitest';
import { planJoinDiagramFit } from './join-diagram-fit';

describe('planJoinDiagramFit', () => {
  it('非表示中は fit せず、再表示用フラグを立てる', () => {
    expect(
      planJoinDiagramFit(false, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: true,
      shouldFit: false,
    });
  });

  it('非表示 → 表示では必ず fit する', () => {
    expect(
      planJoinDiagramFit(true, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: true,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('非表示中に layoutKey が変わっても、再表示時に fit する', () => {
    const whileHidden = planJoinDiagramFit(false, 'layout-b', {
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
    });
    expect(whileHidden).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: true,
      shouldFit: false,
    });

    expect(planJoinDiagramFit(true, 'layout-b', whileHidden)).toEqual({
      lastFitLayoutKey: 'layout-b',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('表示中に layoutKey が変わると fit する', () => {
    expect(
      planJoinDiagramFit(true, 'layout-b', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-b',
      needsFitOnShow: false,
      shouldFit: true,
    });
  });

  it('表示中で layoutKey もフラグも変わらなければ fit しない', () => {
    expect(
      planJoinDiagramFit(true, 'layout-a', {
        lastFitLayoutKey: 'layout-a',
        needsFitOnShow: false,
      }),
    ).toEqual({
      lastFitLayoutKey: 'layout-a',
      needsFitOnShow: false,
      shouldFit: false,
    });
  });
});
