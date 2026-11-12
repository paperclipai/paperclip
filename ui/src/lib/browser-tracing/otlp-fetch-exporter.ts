// A minimal OTLP/HTTP JSON trace exporter for the browser tracing chunk.
//
// It reuses `@opentelemetry/otlp-transformer` (already a server dependency)
// for the wire format and sends with `fetch` + `keepalive`, so a batch sent
// as the tab hides still arrives. Export is best effort: a failed batch is
// dropped, never retried, so tracing cannot add load to a struggling page.

import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-web";

/** `ExportResultCode` from `@opentelemetry/core`: 0 = SUCCESS, 1 = FAILED. */
const SUCCESS = 0;
const FAILED = 1;

export interface OtlpFetchExporterOptions {
  url: string;
  headers: Record<string, string>;
  /**
   * The un-instrumented `fetch`, captured before fetch instrumentation is
   * enabled, so exports never create spans of their own.
   */
  fetch: typeof fetch;
}

export class OtlpFetchExporter implements SpanExporter {
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: OtlpFetchExporterOptions) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    if (this.stopped || spans.length === 0) {
      resultCallback({ code: this.stopped ? FAILED : SUCCESS });
      return;
    }
    let body: Uint8Array | undefined;
    try {
      body = JsonTraceSerializer.serializeRequest(spans);
    } catch {
      body = undefined;
    }
    if (!body) {
      resultCallback({ code: FAILED });
      return;
    }
    const request = this.options.fetch(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      body: body as BodyInit,
      keepalive: true,
      credentials: "omit",
    })
      .then((response) => resultCallback({ code: response.ok ? SUCCESS : FAILED }))
      .catch(() => resultCallback({ code: FAILED }));
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.forceFlush();
  }
}
