import { describe, expect, it, vi } from "vitest";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { KEEPALIVE_BODY_LIMIT_BYTES, OtlpFetchExporter } from "./otlp-fetch-exporter";

function finishedSpan() {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  provider.getTracer("t").startSpan("page.load", { attributes: { "paperclip.page.route": "/:companyPrefix/issues" } }).end();
  return memory.getFinishedSpans();
}

describe("OtlpFetchExporter", () => {
  it("posts OTLP JSON with the ingest-key header, using keepalive while the tab is hidden", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const exporter = new OtlpFetchExporter({
      url: "https://api.honeycomb.io/v1/traces",
      headers: { "x-honeycomb-team": "hcaik_test" },
      fetch: fetchMock as unknown as typeof fetch,
      isPageHidden: () => true,
    });
    const result = await new Promise<{ code: number }>((resolve) => exporter.export(finishedSpan(), resolve));

    expect(result.code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.honeycomb.io/v1/traces");
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(init.headers).toEqual({ "content-type": "application/json", "x-honeycomb-team": "hcaik_test" });
    const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("page.load");
    expect(span.attributes).toEqual([{ key: "paperclip.page.route", value: { stringValue: "/:companyPrefix/issues" } }]);
  });

  it("reports failure without retrying when the collector rejects or is unreachable", async () => {
    for (const fetchMock of [vi.fn(async () => new Response("", { status: 401 })), vi.fn(async () => { throw new TypeError("offline"); })]) {
      const exporter = new OtlpFetchExporter({ url: "https://x.test/v1/traces", headers: {}, fetch: fetchMock as unknown as typeof fetch });
      const result = await new Promise<{ code: number }>((resolve) => exporter.export(finishedSpan(), resolve));
      expect(result.code).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("splits an oversized hidden-tab batch under the keepalive limit and keeps page.load", async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    const tracer = provider.getTracer("t");
    for (let i = 0; i < 600; i++) tracer.startSpan("GET", { attributes: { "paperclip.api.area": `issues-${"x".repeat(200)}` } }).end();
    tracer.startSpan("page.load", { attributes: { "paperclip.page.route": "/:companyPrefix/issues/:issueId" } }).end();
    const spans = memory.getFinishedSpans();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const exporter = new OtlpFetchExporter({
      url: "https://x.test/v1/traces", headers: {}, fetch: fetchMock as unknown as typeof fetch, isPageHidden: () => true,
    });
    const result = await new Promise<{ code: number }>((resolve) => exporter.export(spans, resolve));

    expect(result.code).toBe(0);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(1);
    let exported = 0;
    for (const [, init] of calls) {
      const size = (init.body as Uint8Array).byteLength;
      expect(size).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT_BYTES);
      exported += JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).resourceSpans[0].scopeSpans[0].spans.length;
    }
    expect(exported).toBe(spans.length);
    // page.load is in the first request, which is always within the keepalive quota.
    const first = JSON.parse(new TextDecoder().decode(calls[0]![1].body as Uint8Array));
    expect(first.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("page.load");
    expect(calls[0]![1].keepalive).toBe(true);
  });

  it("sends a visible-tab batch in one ordinary request regardless of size", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const exporter = new OtlpFetchExporter({
      url: "https://x.test/v1/traces", headers: {}, fetch: fetchMock as unknown as typeof fetch, isPageHidden: () => false,
    });
    await new Promise((resolve) => exporter.export(finishedSpan(), resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(false);
  });
});
