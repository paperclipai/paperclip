// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import type { PageLoadMeasurement } from "./page-load-recorder";
import {
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

describe("startBrowserTracingController", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    resetPageSessionSampleForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
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
