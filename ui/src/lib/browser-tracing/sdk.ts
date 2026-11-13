// The browser tracing SDK. Loaded only by `controller.ts` through a dynamic
// import, after the page settles, so it is a separate chunk that a self-hosted
// install, a signed-out page, or an unsampled session never downloads.
//
// Plain OpenTelemetry web packages are used rather than
// `@honeycombio/opentelemetry-web`: that distribution adds the full page URL,
// query string, hash, referrer, and user agent to every span and to the
// resource by default, and bundles log and metric pipelines this feature does
// not use. Honeycomb needs only OTLP/HTTP plus its ingest-key header.
//
// Emitted spans (see doc/browser-performance-tracing.md):
//   page.load            one per hard load or client-side navigation
//   web_vital.lcp|inp|cls Core Web Vitals
//   GET|POST|…           same-origin `/api/` fetches, with W3C trace context
//                        so the server's request span joins the trace

import { context, propagation, trace, ROOT_CONTEXT, type Context, type Span } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  StackContextManager,
  WebTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import type { TracingSdkHandle } from "./controller";
import type { PageLoadMeasurement, PageLoadRecorder } from "./page-load-recorder";
import { OtlpFetchExporter } from "./otlp-fetch-exporter";
import { SanitizingSpanExporter } from "./span-sanitizer";

const TRACER_NAME = "paperclip.browser";

/**
 * Makes the open page-load span the parent of work started while it is open,
 * so a navigation's API requests (and through trace context, their server
 * spans) appear under it in one trace.
 */
class PageLoadContextManager extends StackContextManager {
  constructor(private readonly openPageSpan: () => Span | null) {
    super();
  }

  override active(): Context {
    const active = super.active();
    if (active !== ROOT_CONTEXT) return active;
    const span = this.openPageSpan();
    return span ? trace.setSpan(active, span) : active;
  }
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches every URL that is not this origin's `/api/`; those get no span. */
export function nonApiUrlPattern(origin: string): RegExp {
  return new RegExp(`^(?!${escapeRegExp(origin)}/api/)`);
}

function roundMs(value: number): number {
  return Math.round(value);
}

function navigationTimingAttributes(): Record<string, string | number> {
  const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!entry) return {};
  const attributes: Record<string, string | number> = { "paperclip.page.navigation_type": entry.type };
  if (entry.responseStart > 0) attributes["paperclip.page.ttfb_ms"] = roundMs(entry.responseStart);
  if (entry.domContentLoadedEventEnd > 0) attributes["paperclip.page.dom_content_loaded_ms"] = roundMs(entry.domContentLoadedEventEnd);
  if (entry.loadEventEnd > 0) attributes["paperclip.page.load_event_ms"] = roundMs(entry.loadEventEnd);
  return attributes;
}

export function pageLoadAttributes(measurement: PageLoadMeasurement): Record<string, string | boolean> {
  return {
    "paperclip.page.route": measurement.routeTemplate,
    "paperclip.page.load_type": measurement.loadType,
    "paperclip.page.outcome": measurement.outcome ?? "interrupted",
    "paperclip.page.ready_signal": measurement.readySignal ?? "none",
    "paperclip.page.was_hidden": measurement.wasHidden,
  };
}

/** Honeycomb weights each event by its `SampleRate` (1 in N). */
export function honeycombSampleRate(sampleRate: number): number | null {
  return sampleRate >= 1 ? null : Math.max(1, Math.round(1 / sampleRate));
}

export interface TracingSdkOptions {
  /** Replaces the OTLP exporter (tests). Spans are still sanitized. */
  exporter?: SpanExporter;
}

export function startTracingSdk(
  config: BrowserTracingConfig,
  recorder: PageLoadRecorder,
  options: TracingSdkOptions = {},
): TracingSdkHandle {
  const pageSpans = new Map<number, Span>();
  let openPageSpan: Span | null = null;
  let stopped = false;

  // Captured before fetch instrumentation patches `fetch`, so exports are never traced.
  const uninstrumentedFetch = window.fetch.bind(window);
  const exporter = new SanitizingSpanExporter(options.exporter ?? new OtlpFetchExporter({
    url: config.tracesUrl,
    headers: config.ingestKey ? { "x-honeycomb-team": config.ingestKey } : {},
    fetch: uninstrumentedFetch,
  }));

  const sampleRateAttribute = honeycombSampleRate(config.sampleRate);
  const routeProcessor: SpanProcessor = {
    onStart(span) {
      const route = recorder.currentRouteTemplate();
      if (route && span.attributes["paperclip.page.route"] === undefined) {
        span.setAttribute("paperclip.page.route", route);
      }
      if (sampleRateAttribute !== null) span.setAttribute("SampleRate", sampleRateAttribute);
    },
    onEnd() {},
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };

  const buildCommit = typeof __PAPERCLIP_BUILD_COMMIT__ === "string" ? __PAPERCLIP_BUILD_COMMIT__ : null;
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": config.serviceName,
      ...(buildCommit ? { "service.version": buildCommit } : {}),
      ...(config.environment ? { "deployment.environment.name": config.environment } : {}),
    }),
    // Sampling is decided once per page session before this chunk loads.
    sampler: new AlwaysOnSampler(),
    spanProcessors: [routeProcessor, new BatchSpanProcessor(exporter)],
  });
  provider.register({ contextManager: new PageLoadContextManager(() => openPageSpan) });
  const tracer = provider.getTracer(TRACER_NAME);

  const fetchInstrumentation = new FetchInstrumentation({
    // Only this origin's API gets spans, and only it receives trace
    // headers: no third-party origin is listed for propagation.
    ignoreUrls: [nonApiUrlPattern(window.location.origin)],
    propagateTraceHeaderCorsUrls: [],
    clearTimingResources: false,
    enabled: false,
  });
  fetchInstrumentation.setTracerProvider(provider);
  fetchInstrumentation.enable();

  recorder.attachSink({
    begin(measurement) {
      const span = tracer.startSpan("page.load", {
        root: true,
        startTime: measurement.startTime,
        attributes: {
          "paperclip.page.route": measurement.routeTemplate,
          "paperclip.page.load_type": measurement.loadType,
        },
      });
      pageSpans.set(measurement.id, span);
      if (measurement.endTime === null) openPageSpan = span;
    },
    end(measurement) {
      const span = pageSpans.get(measurement.id);
      if (!span) return;
      pageSpans.delete(measurement.id);
      if (openPageSpan === span) openPageSpan = null;
      span.setAttributes(pageLoadAttributes(measurement));
      if (measurement.loadType === "hard") span.setAttributes(navigationTimingAttributes());
      span.end(measurement.endTime ?? performance.now());
    },
  });

  const reportVital = (metric: Metric) => {
    if (stopped) return;
    const route = (metric.name === "LCP" ? recorder.hardLoadRouteTemplate() : null) ?? recorder.currentRouteTemplate();
    const time = performance.now();
    const span = tracer.startSpan(`web_vital.${metric.name.toLowerCase()}`, {
      root: true,
      startTime: time,
      attributes: {
        "paperclip.web_vital.name": metric.name,
        "paperclip.web_vital.value": metric.value,
        "paperclip.web_vital.rating": metric.rating,
        ...(route ? { "paperclip.page.route": route } : {}),
      },
    });
    span.end(time);
    // Vitals are usually reported as the tab hides; send them before unload.
    if (document.visibilityState === "hidden") void provider.forceFlush();
  };
  onLCP(reportVital);
  onINP(reportVital);
  onCLS(reportVital);

  return {
    forceFlush: () => provider.forceFlush(),
    async shutdown() {
      if (stopped) return;
      stopped = true;
      // Unfinished page loads are dropped, not exported half measured.
      pageSpans.clear();
      openPageSpan = null;
      fetchInstrumentation.disable();
      await provider.shutdown().catch(() => undefined);
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
