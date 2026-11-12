// The closed attribute allowlist for browser spans. Every span passes through
// `SanitizingSpanExporter` before it leaves the browser, so an attribute that
// an OpenTelemetry instrumentation adds (a full URL, a server address, an
// error message) is dropped unless it is listed here. Keep this list and the
// table in doc/browser-performance-tracing.md in sync.
//
// Part of the lazily loaded tracing chunk; the main bundle never imports it.

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-web";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { Attributes } from "@opentelemetry/api";

export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  "paperclip.page.route",
  "paperclip.page.load_type",
  "paperclip.page.outcome",
  "paperclip.page.ready_signal",
  "paperclip.page.was_hidden",
  "paperclip.page.navigation_type",
  "paperclip.page.ttfb_ms",
  "paperclip.page.dom_content_loaded_ms",
  "paperclip.page.load_event_ms",
  "paperclip.web_vital.name",
  "paperclip.web_vital.value",
  "paperclip.web_vital.rating",
  "paperclip.api.area",
  "http.request.method",
  "http.response.status_code",
  "error.type",
  "SampleRate",
]);

export const ALLOWED_RESOURCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "deployment.environment.name",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
]);

const API_AREA_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * The first path segment after `/api/` when it is a fixed lowercase word such
 * as `issues` or `companies`; `other` for anything else. Ids, query strings,
 * and the rest of the path are never kept. The server span for the same
 * request carries the exact route pattern.
 */
export function apiAreaFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/api/")) return null;
  const segment = pathname.split("/")[2] ?? "";
  return API_AREA_PATTERN.test(segment) ? segment : "other";
}

function pickAttributes(source: Attributes, allowed: ReadonlySet<string>): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

const sanitizedResources = new WeakMap<Resource, Resource>();

function sanitizeResource(resource: Resource): Resource {
  let sanitized = sanitizedResources.get(resource);
  if (!sanitized) {
    sanitized = resourceFromAttributes(pickAttributes(resource.attributes, ALLOWED_RESOURCE_ATTRIBUTES));
    sanitizedResources.set(resource, sanitized);
  }
  return sanitized;
}

export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes = pickAttributes(span.attributes, ALLOWED_SPAN_ATTRIBUTES);
  const url = span.attributes["url.full"];
  if (typeof url === "string") {
    const area = apiAreaFromUrl(url);
    if (area) attributes["paperclip.api.area"] = area;
  }
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    // A status message can carry a URL or error text; keep only the code.
    status: { code: span.status.code },
    attributes,
    links: [],
    // Network timing events keep their names and times, never attributes.
    events: span.events.map((event) => ({ name: event.name, time: event.time, droppedAttributesCount: 0 })),
    duration: span.duration,
    ended: span.ended,
    resource: sanitizeResource(span.resource),
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: 0,
  };
}

export class SanitizingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(sanitizeSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
