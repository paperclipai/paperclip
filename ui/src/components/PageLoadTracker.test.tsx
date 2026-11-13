// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import type { PageLoadMeasurement, PageLoadRecorder } from "@/lib/browser-tracing/page-load-recorder";
import { resetPageSessionSampleForTest } from "@/lib/browser-tracing/controller";
import { PageLoadTracker } from "./PageLoadTracker";

const getSessionMock = vi.hoisted(() => vi.fn());
const sdkModuleImported = vi.hoisted(() => vi.fn());
const measurements = vi.hoisted(() => ({ begun: [] as PageLoadMeasurement[], ended: [] as PageLoadMeasurement[] }));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

// Records whether the tracing SDK chunk was ever imported; when it is, a
// fake sink stands in for OpenTelemetry.
vi.mock("@/lib/browser-tracing/sdk", () => {
  sdkModuleImported();
  return {
    startTracingSdk: (_config: BrowserTracingConfig, recorder: PageLoadRecorder) => {
      recorder.attachSink({
        begin: (measurement) => measurements.begun.push({ ...measurement }),
        end: (measurement) => measurements.ended.push({ ...measurement }),
      });
      return { forceFlush: async () => {}, shutdown: async () => {} };
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const config: BrowserTracingConfig = {
  tracesUrl: "https://api.honeycomb.io/v1/traces",
  ingestKey: "hcaik_test",
  serviceName: "paperclip-web",
  environment: "test",
  sampleRate: 1,
};

function session(browserTracing?: BrowserTracingConfig | null) {
  return {
    session: { id: "s", userId: "u" },
    user: { id: "u", email: null, name: null, image: null },
    sentryDsn: null,
    ...(browserTracing === undefined ? {} : { browserTracing }),
  };
}

let navigateTo: ((path: string) => void) | null = null;
function NavigateHandle() {
  navigateTo = useNavigate();
  return null;
}

const Page = () => <div>page</div>;
const routes = (
  <>
    <Route path=":companyPrefix" element={<Page />} />
    <Route path=":companyPrefix/issues" element={<Page />} />
    <Route path=":companyPrefix/issues/:issueId" element={<Page />} />
  </>
);

describe("PageLoadTracker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    measurements.begun.length = 0;
    measurements.ended.length = 0;
    resetPageSessionSampleForTest();
    window.history.replaceState(null, "", "/PAP/issues");
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render(initialPath: string) {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialPath]}>
            <PageLoadTracker routes={routes} />
            <NavigateHandle />
            <Routes>{routes}</Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  async function settle(ms = 400) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, ms));
    });
  }

  it.each([
    ["the server sends null (self-hosted, local dev, or no endpoint)", session(null)],
    ["an older server omits the field", session()],
    ["the browser is signed out", null],
  ])("never imports the tracing SDK when %s", async (_label, payload) => {
    getSessionMock.mockResolvedValue(payload);
    await render("/PAP/issues");
    await settle();
    expect(sdkModuleImported).not.toHaveBeenCalled();
    expect(measurements.begun).toHaveLength(0);
  });

  it("measures the hard load and a client-side navigation under route templates", async () => {
    getSessionMock.mockResolvedValue(session(config));
    await render("/PAP/issues");
    await vi.waitFor(() => expect(measurements.ended).toHaveLength(1), { timeout: 3000 });
    expect(sdkModuleImported).toHaveBeenCalledTimes(1);
    expect(measurements.ended[0]).toMatchObject({
      routeTemplate: "/:companyPrefix/issues",
      loadType: "hard",
      startTime: 0,
      outcome: "ready",
    });

    await act(async () => navigateTo!("/PAP/issues/PAP-4242"));
    await vi.waitFor(() => expect(measurements.ended).toHaveLength(2), { timeout: 3000 });
    const navigation = measurements.ended[1]!;
    expect(navigation).toMatchObject({
      routeTemplate: "/:companyPrefix/issues/:issueId",
      loadType: "client",
      outcome: "ready",
      readySignal: "idle",
    });
    expect(navigation.endTime).toBeGreaterThanOrEqual(navigation.startTime);
    expect(JSON.stringify(measurements)).not.toContain("PAP-4242");
  });

  it("downloads nothing for an unsampled page session", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    getSessionMock.mockResolvedValue(session({ ...config, sampleRate: 0.5 }));
    await render("/PAP/issues");
    await settle();
    expect(sdkModuleImported).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
