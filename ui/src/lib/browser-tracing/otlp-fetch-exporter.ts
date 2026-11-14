// A minimal OTLP/HTTP JSON trace exporter for the browser tracing chunk.
//
// It reuses `@opentelemetry/otlp-transformer` (already a server dependency)
// for the wire format and sends with `fetch`. While the tab is hidden it uses
// `keepalive` so a batch sent as the tab closes still arrives, split to stay
// under the browser's 64 KiB keepalive limit. Export is best effort: a failed batch is
// dropped, never retried, so tracing cannot add load to a struggling page.

import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-web";

/** `ExportResultCode` from `@opentelemetry/core`: 0 = SUCCESS, 1 = FAILED. */
const SUCCESS = 0;
const FAILED = 1;

/**
 * Browsers reject a keepalive request whose body, together with every other
 * keepalive body still in flight, exceeds 64 KiB. Stay under it with margin.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

export interface OtlpFetchExporterOptions {
  url: string;
  headers: Record<string, string>;
  /**
   * The un-instrumented `fetch`, captured before fetch instrumentation is
   * enabled, so exports never create spans of their own.
   */
  fetch: typeof fetch;
  /** Overridable for tests. */
  isPageHidden?: () => boolean;
}

/** Page-load and Web Vital spans go first, so a lost tail costs only API spans. */
function priority(span: ReadableSpan): number {
  return span.name === "page.load" || span.name.startsWith("web_vital.") ? 0 : 1;
}

export class OtlpFetchExporter implements SpanExporter {
  private readonly pending = new Set<Promise<boolean>>();
  private keepaliveBytesInFlight = 0;
  private stopped = false;

  constructor(private readonly options: OtlpFetchExporterOptions) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    if (this.stopped || spans.length === 0) {
      resultCallback({ code: this.stopped ? FAILED : SUCCESS });
      return;
    }
    const ordered = [...spans].sort((a, b) => priority(a) - priority(b));
    // Keepalive is only needed while the tab is hiding or unloading; a
    // visible page sends with an ordinary request, which has no size limit.
    const hidden = (this.options.isPageHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden"))();
    const bodies = hidden ? this.chunk(ordered) : [this.serialize(ordered)];
    if (bodies.some((body) => body === null)) {
      resultCallback({ code: FAILED });
      return;
    }
    void Promise.all((bodies as Uint8Array[]).map((body) => this.send(body, hidden)))
      .then((results) => resultCallback({ code: results.every(Boolean) ? SUCCESS : FAILED }));
  }

  private serialize(spans: ReadableSpan[]): Uint8Array | null {
    try {
      return JsonTraceSerializer.serializeRequest(spans) ?? null;
    } catch {
      return null;
    }
  }

  /** Split into bodies under the keepalive limit, halving until each fits. */
  private chunk(spans: ReadableSpan[]): Array<Uint8Array | null> {
    const body = this.serialize(spans);
    if (!body || body.byteLength <= KEEPALIVE_BODY_LIMIT_BYTES || spans.length === 1) return [body];
    const middle = Math.ceil(spans.length / 2);
    return [...this.chunk(spans.slice(0, middle)), ...this.chunk(spans.slice(middle))];
  }

  private send(body: Uint8Array, hidden: boolean): Promise<boolean> {
    const keepalive = hidden
      && body.byteLength <= KEEPALIVE_BODY_LIMIT_BYTES
      && this.keepaliveBytesInFlight + body.byteLength <= KEEPALIVE_BODY_LIMIT_BYTES;
    if (keepalive) this.keepaliveBytesInFlight += body.byteLength;
    const request = this.options.fetch(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      body: body as BodyInit,
      keepalive,
      credentials: "omit",
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        if (keepalive) this.keepaliveBytesInFlight -= body.byteLength;
      });
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request));
    return request;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.forceFlush();
  }
}
