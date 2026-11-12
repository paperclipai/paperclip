// @vitest-environment jsdom

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_SORT_HIDDEN_COMMIT_MS,
  INBOX_SORT_IDLE_COMMIT_MS,
  type InboxSortAttention,
  type InboxSortCommitReason,
  useInboxSortAttention,
} from "./useInboxSortAttention";

type HarnessProps = {
  viewIdentity: string;
  onCommit: (reason: InboxSortCommitReason) => void;
  onReady: (attention: InboxSortAttention) => void;
};

function Harness({ viewIdentity, onCommit, onReady }: HarnessProps) {
  const attention = useInboxSortAttention({ viewIdentity, onCommit });
  useEffect(() => onReady(attention), [attention, onReady]);
  return null;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function mountHook(viewIdentity = "mine:all:none") {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onCommit = vi.fn<(reason: InboxSortCommitReason) => void>();
  let attention: InboxSortAttention | null = null;
  const onReady = (value: InboxSortAttention) => {
    attention = value;
  };

  const render = (nextViewIdentity = viewIdentity) => {
    flushSync(() => {
      root.render(
        <Harness
          viewIdentity={nextViewIdentity}
          onCommit={onCommit}
          onReady={onReady}
        />,
      );
    });
  };

  render();
  return {
    onCommit,
    render,
    attention: () => {
      if (!attention) throw new Error("Hook did not mount");
      return attention;
    },
    unmount: () => flushSync(() => root.unmount()),
  };
}

describe("useInboxSortAttention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("commits after the visible inbox is idle for the threshold", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS - 1);
    expect(hook.onCommit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hook.onCommit).toHaveBeenCalledWith("idle");
    hook.unmount();
  });

  it("keeps committing every interval while the inbox stays idle", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS);
    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS);
    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS);
    // The idle timer re-arms after each fire, so a long-idle inbox never freezes
    // at the first snapshot.
    const idleCalls = hook.onCommit.mock.calls.filter(([reason]) => reason === "idle");
    expect(idleCalls.length).toBe(3);
    hook.unmount();
  });

  it("resets the idle threshold on inbox interaction", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS - 1_000);
    hook.attention().noteInteraction();
    vi.advanceTimersByTime(1_000);
    expect(hook.onCommit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INBOX_SORT_IDLE_COMMIT_MS - 1_000);
    expect(hook.onCommit).toHaveBeenCalledWith("idle");
    hook.unmount();
  });

  it("commits after a long hide but not after a brief hide", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(INBOX_SORT_HIDDEN_COMMIT_MS - 1);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hook.onCommit).not.toHaveBeenCalled();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(INBOX_SORT_HIDDEN_COMMIT_MS);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hook.onCommit).toHaveBeenCalledTimes(1);
    expect(hook.onCommit).toHaveBeenCalledWith("visibility");
    hook.unmount();
  });

  it("always commits when remounted", () => {
    const first = mountHook();
    expect(first.onCommit).toHaveBeenCalledWith("mount");
    first.unmount();

    const second = mountHook();
    expect(second.onCommit).toHaveBeenCalledWith("mount");
    second.unmount();
  });

  it("commits for tab, filter, and group-by identity changes", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    hook.render("assigned:open:project");
    hook.render("assigned:closed:project");
    hook.render("assigned:closed:assignee");
    expect(hook.onCommit).toHaveBeenCalledTimes(3);
    expect(hook.onCommit).toHaveBeenNthCalledWith(1, "view-identity-change");
    expect(hook.onCommit).toHaveBeenNthCalledWith(2, "view-identity-change");
    expect(hook.onCommit).toHaveBeenNthCalledWith(3, "view-identity-change");
    hook.unmount();
  });

  it("always commits on manual refresh", () => {
    const hook = mountHook();
    hook.onCommit.mockClear();

    hook.attention().commitManualRefresh();
    hook.attention().commitManualRefresh();
    expect(hook.onCommit).toHaveBeenCalledTimes(2);
    expect(hook.onCommit).toHaveBeenNthCalledWith(1, "manual-refresh");
    expect(hook.onCommit).toHaveBeenNthCalledWith(2, "manual-refresh");
    hook.unmount();
  });
});
