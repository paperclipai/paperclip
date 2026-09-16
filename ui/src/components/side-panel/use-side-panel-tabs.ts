import { useCallback, useEffect, useReducer } from "react";
import type { SidePanelTabRecord, SidePanelTabsState } from "./types";

export type SidePanelTabsAction<TPayload> =
  | { type: "open"; tab: SidePanelTabRecord<TPayload>; activate?: boolean }
  | { type: "select"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "close-others"; tabId: string }
  | { type: "reorder"; orderedTabIds: string[] }
  | { type: "update"; tabId: string; patch: Partial<SidePanelTabRecord<TPayload>> }
  | { type: "reset"; state: SidePanelTabsState<TPayload> };

export function normalizeSidePanelTabsState<TPayload>(
  state: SidePanelTabsState<TPayload>,
): SidePanelTabsState<TPayload> {
  const seen = new Set<string>();
  const tabs = state.tabs.filter((tab) => {
    if (!tab.id || !tab.type || seen.has(tab.id)) return false;
    seen.add(tab.id);
    return true;
  });
  const activeTabId = state.activeTabId && seen.has(state.activeTabId)
    ? state.activeTabId
    : tabs[0]?.id ?? null;
  return { tabs, activeTabId };
}

export function sidePanelTabsReducer<TPayload>(
  state: SidePanelTabsState<TPayload>,
  action: SidePanelTabsAction<TPayload>,
): SidePanelTabsState<TPayload> {
  switch (action.type) {
    case "open": {
      const existing = state.tabs.find((tab) => tab.id === action.tab.id);
      if (existing) {
        return action.activate === false || state.activeTabId === existing.id
          ? state
          : { ...state, activeTabId: existing.id };
      }
      return {
        tabs: [...state.tabs, action.tab],
        activeTabId: action.activate === false ? state.activeTabId : action.tab.id,
      };
    }
    case "select":
      return state.activeTabId === action.tabId
        ? state
        : state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      if (state.activeTabId !== action.tabId) return { ...state, tabs };
      return {
        tabs,
        activeTabId: tabs[index]?.id ?? tabs[index - 1]?.id ?? null,
      };
    }
    case "close-others": {
      const tab = state.tabs.find((candidate) => candidate.id === action.tabId);
      return tab ? { tabs: [tab], activeTabId: tab.id } : state;
    }
    case "reorder": {
      if (action.orderedTabIds.length !== state.tabs.length) return state;
      const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
      const tabs = action.orderedTabIds.map((id) => byId.get(id));
      if (tabs.some((tab) => !tab) || new Set(action.orderedTabIds).size !== state.tabs.length) {
        return state;
      }
      return { ...state, tabs: tabs as SidePanelTabRecord<TPayload>[] };
    }
    case "update": {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== action.tabId) return tab;
        changed = true;
        return { ...tab, ...action.patch, id: tab.id };
      });
      return changed ? { ...state, tabs } : state;
    }
    case "reset":
      return normalizeSidePanelTabsState(action.state);
  }
}

interface UseSidePanelTabsOptions<TPayload> {
  initialState: SidePanelTabsState<TPayload>;
  onStateChange?: (state: SidePanelTabsState<TPayload>) => void;
}

export function useSidePanelTabs<TPayload>({
  initialState,
  onStateChange,
}: UseSidePanelTabsOptions<TPayload>) {
  const [state, dispatch] = useReducer(
    sidePanelTabsReducer<TPayload>,
    initialState,
    normalizeSidePanelTabsState,
  );

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  const openTab = useCallback((tab: SidePanelTabRecord<TPayload>, activate = true) => {
    dispatch({ type: "open", tab, activate });
  }, []);
  const selectTab = useCallback((tabId: string) => dispatch({ type: "select", tabId }), []);
  const closeTab = useCallback((tabId: string) => dispatch({ type: "close", tabId }), []);
  const closeOtherTabs = useCallback(
    (tabId: string) => dispatch({ type: "close-others", tabId }),
    [],
  );
  const reorderTabs = useCallback(
    (orderedTabIds: string[]) => dispatch({ type: "reorder", orderedTabIds }),
    [],
  );
  const updateTab = useCallback(
    (tabId: string, patch: Partial<SidePanelTabRecord<TPayload>>) =>
      dispatch({ type: "update", tabId, patch }),
    [],
  );
  const resetTabs = useCallback(
    (next: SidePanelTabsState<TPayload>) => dispatch({ type: "reset", state: next }),
    [],
  );

  return {
    ...state,
    openTab,
    selectTab,
    closeTab,
    closeOtherTabs,
    reorderTabs,
    updateTab,
    resetTabs,
  };
}
