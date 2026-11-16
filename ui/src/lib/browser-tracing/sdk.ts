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
//   GET|POST|…           same-origin `/api/` fetches that start while a
//                        page.load is open, as its children, with W3C trace
//                        context so the server's request span joins the
//                        trace; no network timing events
//   HTTP                 same-origin `/api/` requests made before this chunk
//                        loaded, rebuilt from Resource Timing under the
//                        page.load they belong to (no method, no server join)

import {
  context,
  propagation,
  trace,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanKind,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
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
import type { ApiResourceCollector, TracingSdkHandle } from "./controller";
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

/**
 * The tracer provider given to the fetch instrumentation. A request that
 * starts while no page load is being measured (background polling, a refetch
 * in an idle tab) gets a non-recording span with an invalid context: nothing
 * is recorded or exported, and the trace context propagator sends no
 * `traceparent` for an invalid context, so the server traces that request on
 * its own exactly as for an unsampled tab. A request that starts while a page
 * load is open is a normal child of it.
 */
export function measuredRequestsOnly(provider: TracerProvider, isMeasuring: () => boolean): TracerProvider {
  return {
    getTracer(name, version, options) {
      const tracer = provider.getTracer(name, version, options);
      const unrecorded = () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
      const gated: Tracer = {
        startSpan: (spanName, spanOptions, spanContext) =>
          isMeasuring() ? tracer.startSpan(spanName, spanOptions, spanContext) : unrecorded(),
        startActiveSpan: ((...args: unknown[]) => {
          if (isMeasuring()) return (tracer.startActiveSpan as (...a: unknown[]) => unknown)(...args);
          const fn = args[args.length - 1] as (span: Span) => unknown;
          return fn(unrecorded());
        }) as Tracer["startActiveSpan"],
      };
      return gated;
    },
  };
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
    ...(measurement.suspended ? { "paperclip.page.suspended": true } : {}),
    ...(measurement.view !== null ? { "paperclip.page.view": measurement.view } : {}),
  };
}

/** Span name for a request whose method is unknown (OpenTelemetry HTTP semantics). */
export const UNKNOWN_METHOD_SPAN_NAME = "HTTP";

/**
 * Child spans for the `/api/` requests a page load made before the SDK
 * loaded, from their Resource Timing entries: requests that started inside
 * the load's window and before `before` (from then on the live fetch spans
 * cover them). Windows do not overlap (an interrupted load ends where the
 * next one starts), so each request becomes exactly one span. The URL goes into `url.full` only for the sanitizer, which
 * turns it into `paperclip.api.area` and drops it, as for live fetch spans.
 */
function backfillApiSpans(
  tracer: ReturnType<WebTracerProvider["getTracer"]>,
  pageSpan: Span,
  measurement: PageLoadMeasurement,
  entries: readonly PerformanceResourceTiming[],
  before: number,
) {
  const windowEnd = Math.min(measurement.endTime ?? before, before);
  const parent = trace.setSpan(ROOT_CONTEXT, pageSpan);
  for (const entry of entries) {
    if (entry.startTime < measurement.startTime || entry.startTime >= windowEnd) continue;
    const attributes: Attributes = {
      "url.full": entry.name,
      "paperclip.api.timing_source": "resource_timing",
      "paperclip.page.route": measurement.routeTemplate,
    };
    // Only where the browser exposes it (Chromium); never guessed.
    const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
    if (typeof status === "number" && status > 0) attributes["http.response.status_code"] = status;
    const span = tracer.startSpan(UNKNOWN_METHOD_SPAN_NAME, { kind: SpanKind.CLIENT, startTime: entry.startTime, attributes }, parent);
    span.end(Math.max(entry.startTime, entry.responseEnd));
  }
}

/** Honeycomb weights each event by its `SampleRate` (1 in N). */
export function honeycombSampleRate(sampleRate: number): number | null {
  return sampleRate >= 1 ? null : Math.max(1, Math.round(1 / sampleRate));
}

export interface TracingSdkOptions {
  /** Replaces the OTLP exporter (tests). Spans are still sanitized. */
  exporter?: SpanExporter;
  /** `/api/` requests recorded before the SDK loaded (`observeApiResources`). */
  apiResources?: ApiResourceCollector;
  /** Overrides `EARLY_RESOURCE_GRACE_MS` (tests). */
  earlyResourceGraceMs?: number;
}

/**
 * After this long, a navigation whose history change preceded the SDK has
 * long since committed, so early entries no open measurement claims are
 * released even if the user never navigates again.
 */
export const EARLY_RESOURCE_GRACE_MS = 60_000;

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
    // The nine per-request timing events (fetchStart, responseEnd, …) are
    // each stored as a separate event by Honeycomb, about 10x the volume of
    // the request span, and its duration already covers them.
    ignoreNetworkEvents: true,
    enabled: false,
  });
  fetchInstrumentation.setTracerProvider(measuredRequestsOnly(provider, () => openPageSpan !== null));
  // Requests from here on get live fetch spans; earlier ones are backfilled.
  const liveFetchSince = performance.now();
  fetchInstrumentation.enable();

  // Who may still claim the early Resource Timing entries: any measurement
  // that started before `liveFetchSince` and has not ended, including one not
  // yet begun (a navigation's start is its history change, which can precede
  // the SDK while its route commits after it). Navigation starts only move
  // forward, so once a measurement that started after `liveFetchSince` has
  // begun, or the grace period has passed, no new claimant can appear; the
  // entries are released when, in addition, no claimant is open.
  const apiResources = options.apiResources ?? null;
  const earlyOpen = new Set<number>();
  let noNewEarlyClaimants = false;
  const releaseIfUnclaimed = () => {
    if (apiResources && noNewEarlyClaimants && earlyOpen.size === 0) apiResources.stop();
  };
  const graceTimer = apiResources
    ? window.setTimeout(() => {
      noNewEarlyClaimants = true;
      releaseIfUnclaimed();
    }, options.earlyResourceGraceMs ?? EARLY_RESOURCE_GRACE_MS)
    : undefined;

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
      if (measurement.startTime < liveFetchSince) {
        earlyOpen.add(measurement.id);
      } else {
        noNewEarlyClaimants = true;
        releaseIfUnclaimed();
      }
    },
    end(measurement) {
      const span = pageSpans.get(measurement.id);
      if (!span) return;
      pageSpans.delete(measurement.id);
      if (openPageSpan === span) openPageSpan = null;
      span.setAttributes(pageLoadAttributes(measurement));
      if (measurement.loadType === "hard") span.setAttributes(navigationTimingAttributes());
      if (apiResources && measurement.startTime < liveFetchSince) {
        backfillApiSpans(tracer, span, measurement, apiResources.entries(), liveFetchSince);
      }
      span.end(measurement.endTime ?? performance.now());
      earlyOpen.delete(measurement.id);
      releaseIfUnclaimed();
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
      window.clearTimeout(graceTimer);
      apiResources?.stop();
      await provider.shutdown().catch(() => undefined);
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
