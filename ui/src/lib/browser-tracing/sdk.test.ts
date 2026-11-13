// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-web";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import { createPageLoadRecorder, type PageLoadRecorder } from "./page-load-recorder";
import { honeycombSampleRate, nonApiUrlPattern, startTracingSdk } from "./sdk";
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
});

describe("browser tracing helpers", () => {
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
