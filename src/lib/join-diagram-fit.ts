export interface JoinDiagramFitState {
  lastFitLayoutKey: string | null;
  needsFitOnShow: boolean;
}

export interface JoinDiagramFitPlan extends JoinDiagramFitState {
  shouldFit: boolean;
}

/** タブ表示状態と layoutKey から fitView の要否を決める（副作用なし） */
export function planJoinDiagramFit(
  isActive: boolean,
  layoutKey: string,
  state: JoinDiagramFitState,
): JoinDiagramFitPlan {
  if (!isActive) {
    return {
      lastFitLayoutKey: state.lastFitLayoutKey,
      needsFitOnShow: true,
      shouldFit: false,
    };
  }

  const layoutChanged = state.lastFitLayoutKey !== layoutKey;
  if (!layoutChanged && !state.needsFitOnShow) {
    return {
      lastFitLayoutKey: state.lastFitLayoutKey,
      needsFitOnShow: false,
      shouldFit: false,
    };
  }

  return {
    lastFitLayoutKey: layoutKey,
    needsFitOnShow: false,
    shouldFit: true,
  };
}
