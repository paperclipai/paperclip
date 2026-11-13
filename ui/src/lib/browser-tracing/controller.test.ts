// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import type { PageLoadMeasurement } from "./page-load-recorder";
import {
  observeApiResources,
  resetPageSessionSampleForTest,
  SDK_LOAD_DEADLINE_MS,
  startBrowserTracingController,
  type TracingSdkModule,
} from "./controller";

const config: BrowserTracingConfig = {
  tracesUrl: "https://api.honeycomb.io/v1/traces",
  ingestKey: "hcaik_test",
  serviceName: "paperclip-web",
  environment: null,
  sampleRate: 1,
};

/**
 * The page's clock starts at navigation start. A test process can be older
 * than the 30 s page-load timeout, which would turn the hard load (start 0)
 * into a timeout, so the clock is restarted for each test.
 */
function restartPageClock() {
  const realNow = performance.now.bind(performance);
  const origin = realNow();
  vi.spyOn(performance, "now").mockImplementation(() => realNow() - origin);
}

describe("startBrowserTracingController", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    resetPageSessionSampleForTest();
    restartPageClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility("visible");
  });

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  }

  function hangingQueryClient() {
    const queryClient = new QueryClient();
    void queryClient.fetchQuery({ queryKey: ["hangs"], queryFn: () => new Promise(() => {}) });
    return queryClient;
  }

  function recordingSdk(ended: PageLoadMeasurement[]) {
    return vi.fn(async (): Promise<TracingSdkModule> => ({
      startTracingSdk: (_config, recorder) => {
        recorder.attachSink({ begin: () => {}, end: (m) => ended.push({ ...m }) });
        return { forceFlush: async () => {}, shutdown: async () => {} };
      },
    }));
  }

  it("ends a hard load in a background tab as hidden instead of a 30 s timeout", async () => {
    setVisibility("hidden");
    const ended: PageLoadMeasurement[] = [];
    const controller = startBrowserTracingController(config, {
      queryClient: hangingQueryClient(),
      initialPathname: "/PAP/issues",
      initialRouteTemplate: "/:companyPrefix/issues",
      loadSdk: recordingSdk(ended),
      scheduleSdkLoad: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(SDK_LOAD_DEADLINE_MS);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]).toMatchObject({ loadType: "hard", outcome: "hidden", startTime: 0, endTime: 0, wasHidden: true });
    controller?.stop();
  });

  it("ends an open load as hidden when the tab hides", async () => {
    const ended: PageLoadMeasurement[] = [];
    const controller = startBrowserTracingController(config, {
      queryClient: hangingQueryClient(),
      initialPathname: "/PAP/issues",
      initialRouteTemplate: "/:companyPrefix/issues",
      loadSdk: recordingSdk(ended),
      scheduleSdkLoad: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility("hidden");
    const hiddenAt = performance.now();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(SDK_LOAD_DEADLINE_MS);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]!.outcome).toBe("hidden");
    expect(ended[0]!.endTime).toBeGreaterThanOrEqual(hiddenAt);
    expect(ended[0]!.endTime).toBeLessThan(hiddenAt + 1_000);
    controller?.stop();
  });

  it("records the all-tasks page view from the URL", async () => {
    window.history.replaceState(null, "", "/PAP/issues?view=mine&q=private-search");
    const ended: PageLoadMeasurement[] = [];
    const controller = startBrowserTracingController(config, {
      queryClient: hangingQueryClient(),
      initialPathname: "/PAP/issues",
      initialRouteTemplate: "/:companyPrefix/issues",
      loadSdk: recordingSdk(ended),
      scheduleSdkLoad: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(SDK_LOAD_DEADLINE_MS);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]!.view).toBe("mine");
    controller?.stop();
    window.history.replaceState(null, "", "/");
  });

  it("still loads the SDK and exports a timed-out hard load when the page never settles", async () => {
    const queryClient = new QueryClient();
    // A request that hangs: its query has no data and is always fetching.
    void queryClient.fetchQuery({ queryKey: ["hangs"], queryFn: () => new Promise(() => {}) });
    const ended: PageLoadMeasurement[] = [];
    const loadSdk = vi.fn(async (): Promise<TracingSdkModule> => ({
      startTracingSdk: (_config, recorder) => {
        recorder.attachSink({ begin: () => {}, end: (m) => ended.push({ ...m }) });
        return { forceFlush: async () => {}, shutdown: async () => {} };
      },
    }));
    const controller = startBrowserTracingController(config, {
      queryClient,
      initialPathname: "/PAP/issues",
      initialRouteTemplate: "/:companyPrefix/issues",
      loadSdk,
      // The page never settles.
      scheduleSdkLoad: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(SDK_LOAD_DEADLINE_MS - 1);
    expect(loadSdk).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]).toMatchObject({ routeTemplate: "/:companyPrefix/issues", loadType: "hard", outcome: "timeout" });
    controller?.stop();
  });

  it("loads the SDK once when the page settles first", async () => {
    let settle: (() => void) | null = null;
    const loadSdk = vi.fn(async (): Promise<TracingSdkModule> => ({
      startTracingSdk: () => ({ forceFlush: async () => {}, shutdown: async () => {} }),
    }));
    const controller = startBrowserTracingController(config, {
      queryClient: new QueryClient(),
      initialPathname: "/",
      initialRouteTemplate: "/",
      loadSdk,
      scheduleSdkLoad: (start) => {
        settle = start;
        return () => {};
      },
    });
    settle!();
    await vi.advanceTimersByTimeAsync(SDK_LOAD_DEADLINE_MS * 2);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    controller?.stop();
  });
});

describe("observeApiResources", () => {
  type Listener = (list: { getEntries(): PerformanceEntry[] }) => void;

  function fakeObserver() {
    const state: { listener: Listener | null; options: PerformanceObserverInit | null; disconnected: boolean } = {
      listener: null,
      options: null,
      disconnected: false,
    };
    class FakeObserver {
      static supportedEntryTypes = ["resource"];
      constructor(listener: Listener) {
        state.listener = listener;
      }
      observe(options: PerformanceObserverInit) {
        state.options = options;
      }
      disconnect() {
        state.disconnected = true;
      }
    }
    return { state, Observer: FakeObserver as unknown as typeof PerformanceObserver };
  }

  const entry = (name: string, initiatorType = "fetch") => ({ name, initiatorType, entryType: "resource", startTime: 5 }) as unknown as PerformanceEntry;

  it("keeps only this origin's /api/ fetches, including ones already buffered", () => {
    const { state, Observer } = fakeObserver();
    const collector = observeApiResources("https://acme.paperclip.app", Observer);
    expect(state.options).toEqual({ type: "resource", buffered: true });
    state.listener!({
      getEntries: () => [
        entry("https://acme.paperclip.app/api/issues?view=mine"),
        entry("https://acme.paperclip.app/api/companies", "xmlhttprequest"),
        entry("https://acme.paperclip.app/assets/index.js", "script"),
        entry("https://acme.paperclip.app.evil.com/api/issues"),
        entry("https://api.honeycomb.io/v1/traces"),
      ],
    });
    expect(collector.entries().map((e) => e.name)).toEqual([
      "https://acme.paperclip.app/api/issues?view=mine",
      "https://acme.paperclip.app/api/companies",
    ]);
    collector.stop();
    expect(state.disconnected).toBe(true);
    expect(collector.entries()).toEqual([]);
  });

  it("does nothing where resource timing is unavailable", () => {
    const collector = observeApiResources("https://acme.paperclip.app", null);
    expect(collector.entries()).toEqual([]);
    collector.stop();
  });
});
