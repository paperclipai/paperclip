import { describe, expect, it, vi } from "vitest";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OtlpFetchExporter } from "./otlp-fetch-exporter";

function finishedSpan() {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  provider.getTracer("t").startSpan("page.load", { attributes: { "paperclip.page.route": "/:companyPrefix/issues" } }).end();
  return memory.getFinishedSpans();
}

describe("OtlpFetchExporter", () => {
  it("posts OTLP JSON with the ingest-key header using keepalive", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const exporter = new OtlpFetchExporter({
      url: "https://api.honeycomb.io/v1/traces",
      headers: { "x-honeycomb-team": "hcaik_test" },
      fetch: fetchMock as unknown as typeof fetch,
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
});
