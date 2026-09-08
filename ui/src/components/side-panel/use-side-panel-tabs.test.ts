import { describe, expect, it } from "vitest";
import {
  normalizeSidePanelTabsState,
  sidePanelTabsReducer,
} from "./use-side-panel-tabs";
import type { SidePanelTabRecord, SidePanelTabsState } from "./types";

type Payload = { value: string };

function tab(id: string): SidePanelTabRecord<Payload> {
  return { id, type: "example", label: id.toUpperCase(), payload: { value: id } };
}

function state(ids: string[], activeTabId: string | null = ids[0] ?? null): SidePanelTabsState<Payload> {
  return { tabs: ids.map(tab), activeTabId };
}

describe("sidePanelTabsReducer", () => {
  it("opens a new tab and focuses an already-open tab without duplicating it", () => {
    const opened = sidePanelTabsReducer(state(["a"]), { type: "open", tab: tab("b") });
    expect(opened.tabs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(opened.activeTabId).toBe("b");

    const focused = sidePanelTabsReducer(opened, { type: "open", tab: tab("a") });
    expect(focused.tabs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(focused.activeTabId).toBe("a");
  });

  it("preserves state identity when the requested tab is already active", () => {
    const initial = state(["a", "b"], "b");

    expect(sidePanelTabsReducer(initial, { type: "open", tab: tab("b") })).toBe(initial);
    expect(sidePanelTabsReducer(initial, { type: "select", tabId: "b" })).toBe(initial);
  });

  it("selects the right neighbor, then the left, when closing the active tab", () => {
    const right = sidePanelTabsReducer(state(["a", "b", "c"], "b"), { type: "close", tabId: "b" });
    expect(right.activeTabId).toBe("c");

    const left = sidePanelTabsReducer(state(["a", "b"], "b"), { type: "close", tabId: "b" });
    expect(left.activeTabId).toBe("a");
  });

  it("preserves an intentionally empty state", () => {
    expect(sidePanelTabsReducer(state(["a"]), { type: "close", tabId: "a" })).toEqual({
      tabs: [],
      activeTabId: null,
    });
  });

  it("reorders only complete, unique tab orders", () => {
    const initial = state(["a", "b", "c"], "b");
    expect(sidePanelTabsReducer(initial, {
      type: "reorder",
      orderedTabIds: ["c", "a", "b"],
    })).toEqual({ tabs: [tab("c"), tab("a"), tab("b")], activeTabId: "b" });
    expect(sidePanelTabsReducer(initial, {
      type: "reorder",
      orderedTabIds: ["a", "a", "b"],
    })).toBe(initial);
  });

  it("normalizes duplicates and invalid active ids", () => {
    expect(normalizeSidePanelTabsState({
      tabs: [tab("a"), tab("a"), tab("b")],
      activeTabId: "missing",
    })).toEqual({ tabs: [tab("a"), tab("b")], activeTabId: "a" });
  });

  it("closes other tabs and preserves the selected tab", () => {
    expect(sidePanelTabsReducer(state(["a", "b", "c"], "a"), {
      type: "close-others",
      tabId: "b",
    })).toEqual({ tabs: [tab("b")], activeTabId: "b" });
  });

  it("updates serializable metadata without allowing the stable id to change", () => {
    expect(sidePanelTabsReducer(state(["a"]), {
      type: "update",
      tabId: "a",
      patch: { id: "changed", label: "Renamed", payload: { value: "updated" } },
    })).toEqual({
      tabs: [{ ...tab("a"), label: "Renamed", payload: { value: "updated" } }],
      activeTabId: "a",
    });
  });

  it("normalizes reset state", () => {
    expect(sidePanelTabsReducer(state(["a"]), {
      type: "reset",
      state: { tabs: [tab("b"), tab("b")], activeTabId: "missing" },
    })).toEqual({ tabs: [tab("b")], activeTabId: "b" });
  });
});
