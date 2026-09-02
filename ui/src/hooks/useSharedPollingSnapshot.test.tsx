// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedPollingLeaseKey } from "../lib/cross-tab-poll";
import { useSharedPollingQuery } from "./useSharedPolling";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderCount = 0;
let lastIsLeader: boolean | null = null;

function Harness({ companyId }: { companyId: string }) {
  renderCount += 1;
  const shared = useSharedPollingQuery({
    companyId,
    resourceKey: "res",
    queryKey: ["res", companyId],
    leaderOnly: true,
  });
  lastIsLeader = shared.isLeader;
  return null;
}

describe("useSharedPollingQuery snapshot updates", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    renderCount = 0;
    lastIsLeader = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  function mount(companyId: string) {
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Harness companyId={companyId} />
        </QueryClientProvider>,
      );
    });
  }

  it("does not schedule an extra commit when the subscribed snapshot is value-equal", () => {
    // No foreign lease: this tab claims leadership on the coordinator's first
    // tick, so the snapshot delivered at subscribe time equals the hook's
    // initial optimistic state. That delivery is a fresh object; it must not
    // cost a re-render.
    mount("company-a");
    expect(lastIsLeader).toBe(true);
    expect(renderCount).toBe(1);
  });

  it("re-renders exactly once for a real leadership change and stays quiet after", () => {
    // Another tab holds an unexpired lease: this tab mounts optimistic-leader
    // and is demoted to follower by the subscribe-time snapshot.
    localStorage.setItem(
      sharedPollingLeaseKey("company-b"),
      JSON.stringify({ leader: "other-tab", expiresAt: Date.now() + 60_000, visible: true }),
    );

    mount("company-b");
    expect(lastIsLeader).toBe(false);
    expect(renderCount).toBe(2);

    // Ticks with unchanged leadership must not render at all.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(lastIsLeader).toBe(false);
    expect(renderCount).toBe(2);
  });
});
