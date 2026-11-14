// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-web";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import { createPageLoadRecorder, type PageLoadRecorder } from "./page-load-recorder";
import { honeycombSampleRate, nonApiUrlPattern, pageLoadAttributes, startTracingSdk } from "./sdk";
import { apiAreaFromUrl } from "./span-sanitizer";
import type { TracingSdkHandle } from "./controller";

const config: BrowserTracingConfig = {
  tracesUrl: "https://api.honeycomb.io/v1/traces",
  ingestKey: "hcaik_test",
  serviceName: "paperclip-web",
  environment: "staging",
  sampleRate: 0.25,
};

function idleRecorder(): PageLoadRecorder {
  let frames: Array<() => void> = [];
  const recorder = createPageLoadRecorder({
    now: () => performance.now(),
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => {
      frames = [];
    },
    setTimer: () => 0,
    clearTimer: () => {},
    isDocumentHidden: () => false,
    hasPendingPrimaryData: () => false,
    readGates: () => ({ blockingCount: 0, contentCount: 0, pendingContentCount: 0, lastContentReadyAt: null }),
  });
  (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames = () => {
    for (let i = 0; i < 2; i++) {
      const due = frames;
      frames = [];
      for (const callback of due) callback();
    }
  };
  return recorder;
}

describe("startTracingSdk", () => {
  let exporter: InMemorySpanExporter;
  let handle: TracingSdkHandle | null = null;
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    globalThis.fetch = realFetch;
  });

  it("exports a page.load span with the route template and only allowlisted attributes", async () => {
    const recorder = idleRecorder();
    handle = startTracingSdk(config, recorder, { exporter });
    recorder.begin({ routeTemplate: "/:companyPrefix/issues/:issueId", loadType: "client", startTime: performance.now() });
    (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
    await handle.forceFlush();

    const spans = exporter.getFinishedSpans().filter((span) => span.name === "page.load");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toEqual({
      "paperclip.page.route": "/:companyPrefix/issues/:issueId",
      "paperclip.page.load_type": "client",
      "paperclip.page.outcome": "ready",
      "paperclip.page.ready_signal": "idle",
      "paperclip.page.was_hidden": false,
      SampleRate: 4,
    });
    // service.version is the build commit, absent in tests.
    expect(Object.keys(spans[0]!.resource.attributes).sort()).toEqual([
      "deployment.environment.name",
      "service.name",
    ]);
    expect(spans[0]!.resource.attributes["service.name"]).toBe("paperclip-web");
  });

  it("propagates trace context only to this origin's API and strips URLs from fetch spans", async () => {
    const recorder = idleRecorder();
    recorder.begin({ routeTemplate: "/:companyPrefix/issues/:issueId", loadType: "client", startTime: performance.now() });
    handle = startTracingSdk(config, recorder, { exporter });

    await fetch(`${window.location.origin}/api/issues/PAP-77?includeComments=true`);
    await fetch("https://third-party.example.com/api/collect?user=someone");
    await fetch(`${window.location.origin}/assets/index.js`);

    const headersOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers);
    expect(headersOf(fetchMock.mock.calls[0]!).get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headersOf(fetchMock.mock.calls[1]!).get("traceparent")).toBeNull();
    expect(headersOf(fetchMock.mock.calls[2]!).get("traceparent")).toBeNull();

    (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
    // Fetch spans end after the instrumentation's resource-timing wait.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await handle.forceFlush();
    const fetchSpans = exporter.getFinishedSpans().filter((span) => span.name !== "page.load");
    expect(fetchSpans).toHaveLength(1);
    const [span] = fetchSpans;
    expect(span!.name).toBe("GET");
    expect(span!.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "paperclip.api.area": "issues",
      "paperclip.page.route": "/:companyPrefix/issues/:issueId",
    });
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("PAP-77");
    expect(serialized).not.toContain("includeComments");
    expect(serialized).not.toContain("://");
    expect(serialized).not.toContain(window.location.host);
    expect(span!.attributes["url.full"]).toBeUndefined();
    // The open navigation is the parent, so the server span joins its trace.
    const pageSpan = exporter.getFinishedSpans().find((s) => s.name === "page.load");
    expect(span!.spanContext().traceId).toBe(pageSpan!.spanContext().traceId);
    expect(span!.parentSpanContext?.spanId).toBe(pageSpan!.spanContext().spanId);
    const traceparent = headersOf(fetchMock.mock.calls[0]!).get("traceparent")!;
    expect(traceparent.split("-")[1]).toBe(pageSpan!.spanContext().traceId);
  });

  it("records no span and sends no traceparent for an API request made while no page load is measured", async () => {
    const recorder = idleRecorder();
    const flush = (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames;
    recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: performance.now() });
    flush();
    handle = startTracingSdk(config, recorder, { exporter });

    // Background polling with no navigation open.
    await fetch(`${window.location.origin}/api/companies/abc/live-runs`);
    await fetch(`${window.location.origin}/api/issues`, { method: "POST" });
    // The next navigation's requests are recorded again.
    recorder.begin({ routeTemplate: "/:companyPrefix/issues/:issueId", loadType: "client", startTime: performance.now() });
    await fetch(`${window.location.origin}/api/issues/PAP-77`);

    const headersOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers);
    expect(headersOf(fetchMock.mock.calls[0]!).get("traceparent")).toBeNull();
    expect(headersOf(fetchMock.mock.calls[1]!).get("traceparent")).toBeNull();
    expect(headersOf(fetchMock.mock.calls[2]!).get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await handle.forceFlush();
    const spans = exporter.getFinishedSpans();
    const requests = spans.filter((span) => span.name !== "page.load");
    expect(requests.map((span) => span.attributes["paperclip.api.area"])).toEqual(["issues"]);
    const issuePage = spans.find((span) => span.name === "page.load" && span.attributes["paperclip.page.route"] === "/:companyPrefix/issues/:issueId")!;
    expect(requests[0]!.parentSpanContext?.spanId).toBe(issuePage.spanContext().spanId);
    // Every exported span is a page load, a vital, or a child of a page load.
    const pageSpanIds = new Set(spans.filter((span) => span.name === "page.load").map((span) => span.spanContext().spanId));
    for (const span of requests) expect(pageSpanIds.has(span.parentSpanContext!.spanId)).toBe(true);
  });

  it("sends request spans without per-request network timing events", async () => {
    const recorder = idleRecorder();
    recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: performance.now() });
    handle = startTracingSdk(config, recorder, { exporter });
    const url = `${window.location.origin}/api/issues`;
    // The browser's Resource Timing entry for the request, which the fetch
    // instrumentation turns into `fetchStart`, `responseEnd`, … events.
    let timing: PerformanceResourceTiming | null = null;
    fetchMock.mockImplementationOnce(async () => {
      const start = performance.now();
      timing = {
        name: url, entryType: "resource", initiatorType: "fetch", startTime: start,
        fetchStart: start, domainLookupStart: start, domainLookupEnd: start, connectStart: start,
        secureConnectionStart: start, connectEnd: start, requestStart: start, responseStart: start + 0.1,
        responseEnd: start + 0.2, encodedBodySize: 2, decodedBodySize: 2,
      } as unknown as PerformanceResourceTiming;
      return new Response("{}", { status: 200 });
    });
    const realGetEntriesByType = performance.getEntriesByType.bind(performance);
    const getEntries = vi.spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
      type === "resource" && timing ? [timing] : realGetEntriesByType(type)) as typeof performance.getEntriesByType);
    try {
      await fetch(url);
      (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await handle.forceFlush();
      // The instrumentation found the entry, so timing events could be added.
      expect(getEntries).toHaveBeenCalledWith("resource");
    } finally {
      getEntries.mockRestore();
    }
    const [request] = exporter.getFinishedSpans().filter((span) => span.name === "GET");
    expect(request).toBeDefined();
    expect(request!.events.map((event) => event.name)).toEqual([]);
  });
});

describe("hard-load API spans from Resource Timing", () => {
  let exporter: InMemorySpanExporter;
  let handle: TracingSdkHandle | null = null;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
  });

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
  });

  const origin = () => window.location.origin;
  const resource = (name: string, startTime: number, responseEnd: number, extra: Record<string, unknown> = {}) =>
    ({ name, initiatorType: "fetch", entryType: "resource", startTime, responseEnd, ...extra }) as unknown as PerformanceResourceTiming;

  it("backfills child spans under a hard load that finished before the SDK loaded", async () => {
    const recorder = idleRecorder();
    recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "hard", startTime: 0 });
    (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
    const loadEnd = performance.now();
    let stopped = false;
    const entries = [
      resource(`${origin()}/api/auth/get-session`, 0.5, 1, { responseStatus: 200 }),
      resource(`${origin()}/api/companies/0f6b6d1e-2c4f-4b5e/issues?view=mine&q=secret`, 1, 2, { responseStatus: 404 }),
      // Before the browser exposes a status, none is invented.
      resource(`${origin()}/api/issues/PAP-77`, 1.5, 3),
      // Started after the load ended: not part of it.
      resource(`${origin()}/api/issues`, loadEnd + 1, loadEnd + 2),
    ];
    handle = startTracingSdk(config, recorder, {
      exporter,
      apiResources: { entries: () => entries, stop: () => { stopped = true; } },
      earlyResourceGraceMs: 0,
    });
    await handle.forceFlush();

    const spans = exporter.getFinishedSpans();
    const pageSpan = spans.find((span) => span.name === "page.load")!;
    const children = spans.filter((span) => span.name !== "page.load");
    expect(children.map((span) => span.name)).toEqual(["HTTP", "HTTP", "HTTP"]);
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(pageSpan.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(pageSpan.spanContext().traceId);
      const serialized = JSON.stringify(child.attributes);
      expect(serialized).not.toContain("://");
      expect(serialized).not.toContain("0f6b6d1e");
      expect(serialized).not.toContain("PAP-77");
      expect(serialized).not.toContain("secret");
      expect(child.attributes["url.full"]).toBeUndefined();
    }
    expect(children.map((span) => span.attributes)).toEqual([
      { "paperclip.api.area": "auth", "paperclip.api.timing_source": "resource_timing", "http.response.status_code": 200, "paperclip.page.route": "/:companyPrefix/issues", SampleRate: 4 },
      { "paperclip.api.area": "companies", "paperclip.api.timing_source": "resource_timing", "http.response.status_code": 404, "paperclip.page.route": "/:companyPrefix/issues", SampleRate: 4 },
      { "paperclip.api.area": "issues", "paperclip.api.timing_source": "resource_timing", "paperclip.page.route": "/:companyPrefix/issues", SampleRate: 4 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(true);
  });

  it("backfills every buffered navigation, not only the first one replayed", async () => {
    const recorder = idleRecorder();
    const flush = (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames;
    recorder.begin({ routeTemplate: "/:companyPrefix/dashboard", loadType: "hard", startTime: 0 });
    flush();
    const clientStart = performance.now();
    recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: clientStart });
    flush();
    const clientEnd = performance.now();
    let entries: PerformanceResourceTiming[] = [
      resource(`${origin()}/api/companies`, 0.5, 1, { responseStatus: 200 }),
      resource(`${origin()}/api/issues`, clientStart, clientEnd, { responseStatus: 200 }),
    ];
    handle = startTracingSdk(config, recorder, {
      exporter,
      // A real collector drops its entries when stopped.
      apiResources: { entries: () => entries, stop: () => { entries = []; } },
    });
    await handle.forceFlush();

    const spans = exporter.getFinishedSpans();
    const pages = spans.filter((span) => span.name === "page.load");
    const childrenOf = (route: string) => {
      const page = pages.find((span) => span.attributes["paperclip.page.route"] === route)!;
      return spans.filter((span) => span.parentSpanContext?.spanId === page.spanContext().spanId).map((span) => span.attributes["paperclip.api.area"]);
    };
    expect(childrenOf("/:companyPrefix/dashboard")).toEqual(["companies"]);
    expect(childrenOf("/:companyPrefix/issues")).toEqual(["issues"]);
  });

  it("keeps early entries for a navigation that started before the SDK loaded but commits after it", async () => {
    const recorder = idleRecorder();
    const flush = (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames;
    recorder.begin({ routeTemplate: "/:companyPrefix/dashboard", loadType: "hard", startTime: 0 });
    flush();
    // The user clicks (history change) just before the SDK finishes loading;
    // the route commits after it.
    const historyChange = performance.now();
    let entries: PerformanceResourceTiming[] = [
      resource(`${origin()}/api/companies`, 0.5, 1, { responseStatus: 200 }),
      resource(`${origin()}/api/issues`, historyChange, historyChange + 5, { responseStatus: 200 }),
    ];
    let stopped = false;
    handle = startTracingSdk(config, recorder, {
      exporter,
      apiResources: { entries: () => entries, stop: () => { stopped = true; entries = []; } },
    });
    expect(stopped).toBe(false);
    recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: historyChange });
    flush();
    await handle.forceFlush();

    const spans = exporter.getFinishedSpans();
    const childrenOf = (route: string) => {
      const page = spans.find((span) => span.name === "page.load" && span.attributes["paperclip.page.route"] === route)!;
      return spans.filter((span) => span.parentSpanContext?.spanId === page.spanContext().spanId).map((span) => span.attributes["paperclip.api.area"]);
    };
    expect(childrenOf("/:companyPrefix/dashboard")).toEqual(["companies"]);
    expect(childrenOf("/:companyPrefix/issues")).toEqual(["issues"]);
    // Released once a navigation that started after the SDK loaded begins.
    recorder.begin({ routeTemplate: "/:companyPrefix/agents", loadType: "client", startTime: performance.now() + 1 });
    expect(stopped).toBe(true);
  });

  it("releases early entries after the grace period when no later navigation happens", async () => {
    const recorder = idleRecorder();
    recorder.begin({ routeTemplate: "/", loadType: "hard", startTime: 0 });
    (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
    let stopped = false;
    handle = startTracingSdk(config, recorder, {
      exporter,
      apiResources: { entries: () => [], stop: () => { stopped = true; } },
      earlyResourceGraceMs: 0,
    });
    expect(stopped).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(true);
  });

  it("does not backfill requests that the live fetch instrumentation already traces", async () => {
    const recorder = idleRecorder();
    recorder.begin({ routeTemplate: "/", loadType: "hard", startTime: 0 });
    const afterSdk = () => performance.now() + 1;
    const entries: PerformanceResourceTiming[] = [];
    handle = startTracingSdk(config, recorder, {
      exporter,
      apiResources: { entries: () => entries, stop: () => {} },
    });
    entries.push(resource(`${origin()}/api/issues`, afterSdk(), afterSdk() + 1));
    (recorder as PageLoadRecorder & { flushFrames(): void }).flushFrames();
    await handle.forceFlush();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["page.load"]);
  });
});

describe("browser tracing helpers", () => {
  it("reports hidden, suspended, and view attributes on page.load", () => {
    expect(pageLoadAttributes({
      id: 1,
      routeTemplate: "/:companyPrefix/issues",
      loadType: "hard",
      startTime: 0,
      endTime: 30_000,
      outcome: "timeout",
      readySignal: null,
      wasHidden: false,
      suspended: true,
      view: "mine",
    })).toEqual({
      "paperclip.page.route": "/:companyPrefix/issues",
      "paperclip.page.load_type": "hard",
      "paperclip.page.outcome": "timeout",
      "paperclip.page.ready_signal": "none",
      "paperclip.page.was_hidden": false,
      "paperclip.page.suspended": true,
      "paperclip.page.view": "mine",
    });
  });

  it("ignores every URL outside this origin's API", () => {
    const pattern = nonApiUrlPattern("https://acme.paperclip.app");
    expect(pattern.test("https://acme.paperclip.app/api/issues")).toBe(false);
    expect(pattern.test("https://acme.paperclip.app/assets/a.js")).toBe(true);
    expect(pattern.test("https://acme.paperclip.app.evil.com/api/issues")).toBe(true);
    expect(pattern.test("https://api.honeycomb.io/v1/traces")).toBe(true);
  });

  it("reduces an API URL to its fixed area name", () => {
    expect(apiAreaFromUrl("https://x.test/api/issues/PAP-1/comments?q=secret")).toBe("issues");
    expect(apiAreaFromUrl("https://x.test/api/0f6b6d1e-2c4f/thing")).toBe("other");
    expect(apiAreaFromUrl("https://x.test/assets/a.js")).toBeNull();
  });

  it("converts a sample ratio to Honeycomb's one-in-N SampleRate", () => {
    expect(honeycombSampleRate(1)).toBeNull();
    expect(honeycombSampleRate(0.25)).toBe(4);
    expect(honeycombSampleRate(0.3)).toBe(3);
  });
});
