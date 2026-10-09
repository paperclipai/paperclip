// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { onlineManager, QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, OUTAGE_SIMULATOR_STORAGE_KEY } from "@/api/client";
import {
  ConnectivityProvider,
  createConnectivityStore,
  probeServerHealth,
  type ConnectivityStore,
  type ProbeResult,
} from "@/lib/connectivity";
import { bindConnectivity, createAppQueryClient } from "@/lib/query-client";
import {
  BACK_ONLINE_VISIBLE_MS,
  BANNER_SHOW_DELAY_MS,
  ConnectionStatusBanner,
  connectionBannerView,
  pendingWritesCopy,
} from "./ConnectionStatusBanner";

describe("connectionBannerView", () => {
  const base = { troubleSince: 0, recoveredAt: null, shownForOutage: false };

  it("waits before showing trouble", () => {
    expect(connectionBannerView({ ...base, status: "reconnecting", now: BANNER_SHOW_DELAY_MS - 1 })).toBe("hidden");
    expect(connectionBannerView({ ...base, status: "reconnecting", now: BANNER_SHOW_DELAY_MS })).toBe("reconnecting");
    expect(connectionBannerView({ ...base, status: "offline", now: BANNER_SHOW_DELAY_MS })).toBe("offline");
  });

  it("says back online only after an outage it showed", () => {
    const recovered = { status: "online" as const, troubleSince: null, recoveredAt: 10_000 };
    expect(connectionBannerView({ ...recovered, shownForOutage: true, now: 10_500 })).toBe("back_online");
    expect(connectionBannerView({ ...recovered, shownForOutage: false, now: 10_500 })).toBe("hidden");
    expect(connectionBannerView({ ...recovered, shownForOutage: true, now: 10_000 + BACK_ONLINE_VISIBLE_MS })).toBe("hidden");
  });

  it("counts pending writes", () => {
    expect(pendingWritesCopy(0)).toBeNull();
    expect(pendingWritesCopy(1)).toBe("1 change will send when you’re back online.");
    expect(pendingWritesCopy(2)).toBe("2 changes will send when you’re back online.");
  });
});

describe("ConnectionStatusBanner", () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ConnectivityStore;
  let probe: ReturnType<typeof vi.fn<() => Promise<ProbeResult>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue({ reachable: false, retryAfterMs: null });
    store = createConnectivityStore({ probe, browserOnline: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(
      <ConnectivityProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ConnectionStatusBanner />
        </QueryClientProvider>
      </ConnectivityProvider>,
    ));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    store.dispose();
    container.remove();
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    // Let React's scheduler run the render a timer queued.
    await vi.advanceTimersByTimeAsync(20);
    flushSync(() => {});
  }

  it("shows one banner for a sustained outage, then 'Back online'", async () => {
    store.reportError(new ApiError("down", 503, { error: "tenant_app_unavailable" }));
    await advance(0);
    expect(container.textContent).toBe("");
    await advance(BANNER_SHOW_DELAY_MS);
    expect(container.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(container.textContent).toContain("Reconnecting automatically");

    store.setPendingWrites("composer", 2);
    await advance(0);
    expect(container.textContent).toContain("2 changes will send when you’re back online.");

    store.reportSuccess();
    await advance(0);
    expect(container.textContent).toBe("Back online.");
    await advance(BACK_ONLINE_VISIBLE_MS);
    expect(container.textContent).toBe("");
  });

  it("stays hidden for a blip shorter than the show delay", async () => {
    store.reportError(new ApiError("down", 503, null));
    await advance(BANNER_SHOW_DELAY_MS / 2);
    store.reportSuccess();
    await advance(BANNER_SHOW_DELAY_MS * 2);
    expect(container.textContent).toBe("");
  });
});

describe("simulated tenant_app_unavailable blip", () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/health") ? Response.json({ status: "ok" }) : Response.json({ items: [] }));
  let root: Root;
  let container: HTMLDivElement;
  let store: ConnectivityStore;
  let client: QueryClient;
  let unbind: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(OUTAGE_SIMULATOR_STORAGE_KEY, "503:tenant_app_unavailable");
    store = createConnectivityStore({ probe: probeServerHealth, browserOnline: true });
    client = createAppQueryClient({ connectivity: store });
    client.mount();
    unbind = bindConnectivity(client, store);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(
      <ConnectivityProvider store={store}>
        <QueryClientProvider client={client}>
          <ConnectionStatusBanner />
        </QueryClientProvider>
      </ConnectivityProvider>,
    ));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    unbind();
    store.dispose();
    client.unmount();
    client.clear();
    container.remove();
    onlineManager.setOnline(true);
    window.localStorage.removeItem(OUTAGE_SIMULATOR_STORAGE_KEY);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fetchMock.mockClear();
  });

  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(20);
    flushSync(() => {});
  }

  it("shows exactly one readable banner, then recovers and refetches", async () => {
    const observer = new QueryObserver(client, { queryKey: ["companies"], queryFn: () => api.get("/companies") });
    const stop = observer.subscribe(() => {});

    await advance(BANNER_SHOW_DELAY_MS + 1_000);
    expect(container.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(container.textContent).toContain("Reconnecting automatically");
    expect(container.textContent).not.toMatch(/tenant_app_unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();

    window.localStorage.removeItem(OUTAGE_SIMULATOR_STORAGE_KEY);
    for (let waited = 0; store.getSnapshot().status !== "online" && waited < 15_000; waited += 500) await advance(500);
    expect(store.getSnapshot().status).toBe("online");
    expect(container.textContent).toBe("Back online.");
    await advance(0);
    expect(observer.getCurrentResult().data).toEqual({ items: [] });
    stop();
  });
});
