import type { AdapterExecutionContext, AdapterRuntimeEvent } from "../types.js";

/**
 * Structured event emitted once per named sandbox run-startup boundary so the
 * duration of each bring-up step lands in the `heartbeat_run_events` stream
 * (jsonb `payload`) beside the existing "run started" / "adapter invocation"
 * anchors. Observability-only — it rides the existing
 * `ctx.onEvent → onAdapterEvent → appendRunEvent` bridge with no schema change.
 */
export const RUN_STARTUP_STEP_EVENT_TYPE = "run.startup.step";

/**
 * The public built-in sandbox provider families. A key in this set is safe to
 * emit as a low-cardinality span attribute. Any other key is operator-defined
 * (plugin-backed) and unbounded, so `normalizeProviderFamily` maps it to the
 * generic value `plugin`. Keep this list closed and small.
 */
const BUILT_IN_PROVIDER_FAMILIES: ReadonlySet<string> = new Set([
  "daytona",
  "kubernetes",
  "e2b",
  "cloudflare",
  "exe-dev",
  "modal",
  "novita",
]);

/** The generic family for any provider key outside the built-in list. */
const PLUGIN_PROVIDER_FAMILY = "plugin";

/**
 * Map a raw provider key to a low-cardinality public family. Return the key
 * unchanged when it is a built-in family. Return `plugin` for every other
 * value, so an operator-defined plugin key never becomes an unbounded span
 * attribute. A missing or empty key also maps to `plugin`.
 */
export function normalizeProviderFamily(key: string | undefined): string {
  if (key && BUILT_IN_PROVIDER_FAMILIES.has(key)) return key;
  return PLUGIN_PROVIDER_FAMILY;
}

/**
 * The value of `SpanStatusCode.ERROR` in `@opentelemetry/api`. `adapter-utils`
 * stays OTel-free, so the timing helper uses the numeric value directly. A real
 * injected OTel span reads it as the error status.
 */
const SPAN_STATUS_CODE_ERROR = 2;

/**
 * A minimal, OTel-free span contract. The server injects a real
 * `@opentelemetry/api` span, which satisfies this shape structurally. The
 * default is a no-op span, so a step with no injected tracer changes nothing.
 */
export interface StartupSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

/**
 * An opaque parent-context token. The server builds it from the OTel
 * `@opentelemetry/api` `context` / `trace` helpers. `adapter-utils` never reads
 * it; it only forwards it to `startSpan`, so this package stays OTel-free. A
 * child span opened with this token parents to the span the token carries.
 */
export type StartupSpanContext = unknown;

/**
 * A minimal, OTel-free tracer contract. The server injects a real
 * `@opentelemetry/api` tracer, which satisfies this shape structurally. The
 * `startSpan` signature is a subset of the OTel one, so a real tracer is
 * assignable here. The optional third argument is the explicit parent context:
 * a real OTel `startSpan(name, options, context)` parents the new span to the
 * span that `context` carries. `adapter-utils` passes it through as an opaque
 * token, so parenting never depends on ambient async-context propagation.
 */
export interface StartupTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
    context?: StartupSpanContext,
  ): StartupSpan;
}

/**
 * The injected tracer plus the one context helper the engine needs to build a
 * parent-context token from the root span. The server binds these to
 * `@opentelemetry/api` (`trace.getTracer`, `trace.setSpan` over
 * `context.active()`). The default is a no-op, so the whole span path stays a
 * no-op until the server injects a real implementation.
 */
export interface StartupTraceContext {
  readonly tracer: StartupTracer;
  /**
   * Return a parent-context token whose active span is `span`. A child span
   * opened with this token parents to `span`. The token is opaque to
   * `adapter-utils`.
   */
  contextWithSpan(span: StartupSpan): StartupSpanContext;
}

/** A shared no-op span. It implements the structural span contract and does
 * nothing, so a caller with no injected tracer changes no behavior. */
export const NOOP_STARTUP_SPAN: StartupSpan = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const NOOP_SPAN = NOOP_STARTUP_SPAN;

/**
 * The default tracer. It opens no real span, so `measureStartupStep` behaves
 * exactly as before when the caller injects no tracer.
 */
const NOOP_TRACER: StartupTracer = {
  startSpan: () => NOOP_SPAN,
};

/**
 * The default trace context. Its tracer is a no-op and it produces no parent
 * token, so the engine emits no spans until the server injects a real
 * implementation.
 */
export const NOOP_STARTUP_TRACE_CONTEXT: StartupTraceContext = {
  tracer: NOOP_TRACER,
  contextWithSpan: () => undefined,
};

/**
 * Set a numeric span attribute only when the value is a finite number. A reader
 * that returns `undefined` (the counter is unavailable) yields no attribute,
 * never `NaN` and never a misleading `0`. This mirrors the host counter guard
 * at `environment-execution-target.ts`.
 */
function setFiniteNumberAttr(
  span: StartupSpan,
  key: string,
  value: number | undefined,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    span.setAttribute(key, value);
  }
}

/**
 * Compute a counter delta from a reader. Return `undefined` when the reader is
 * absent, or when either the start or the end snapshot is not a finite number.
 * A `undefined` result yields no payload field and no span attribute.
 */
function finiteDelta(
  read: (() => number) | undefined,
  start: number | undefined,
): number | undefined {
  if (!read) return undefined;
  const end = read();
  if (typeof end !== "number" || !Number.isFinite(end)) return undefined;
  const base = typeof start === "number" && Number.isFinite(start) ? start : 0;
  return end - base;
}

/**
 * Optional per-step attribution attached to a `run.startup.step` event, all
 * additive to the free-form jsonb payload (no schema change). Each reader is a
 * plain `() => number` closure so the timing helper stays decoupled from the
 * runner/provider it reads (Risk R1): `measureStartupStep` snapshots the reader
 * before `fn` and again in `finally`, emitting the delta.
 *
 * - `roundTrips` — cumulative host→sandbox `runner.execute` count; the delta is
 *   how many round-trips the step performed (Open Q1, host boundary).
 * - `providerExecMs` / `providerGetMs` — cumulative provider-reported wall-time
 *   (ms) for the `executeCommand` REST call vs the `client.get` sandbox
 *   re-fetch; the delta attributes the step's round-trip time to its parts
 *   (Open Q1, finer provider attribution).
 * - `extra` — a reader (called once in `finally`, after `fn` settles) returning
 *   any additional numeric fields to merge into the payload; used by
 *   `acp.handshake` to carry its `createRuntimeMs` / `ensureSessionMs` sub-split
 *   (Open Q2), which are measured by the caller rather than read from a counter.
 *   The `extra` map feeds the EVENT payload only. Its keys never become span
 *   attributes, so a free-form key cannot widen the closed span allowlist.
 * - `tracer` — an injected structural tracer. It defaults to a no-op, so the
 *   span path changes no runtime behavior until the server injects a real
 *   tracer. The span carries only the closed attribute allowlist (`step`, the
 *   normalized `provider`, and the finite counter deltas).
 * - `parentContext` — an opaque parent-context token from the root span. When
 *   set, the step's span parents to that root. `measureStartupStep` forwards it
 *   to `startSpan` and never inspects it, so parenting stays explicit and does
 *   not depend on ambient async-context propagation.
 * - `provider` — the raw provider key for the step. `measureStartupStep`
 *   normalizes it through `normalizeProviderFamily` before it sets the
 *   low-cardinality `provider` span attribute. It never sets the raw key.
 */
export interface StartupStepMeasureOptions {
  roundTrips?: () => number;
  providerExecMs?: () => number;
  providerGetMs?: () => number;
  extra?: () => Record<string, number>;
  tracer?: StartupTracer;
  parentContext?: StartupSpanContext;
  provider?: string;
}

function buildStepEvent(payload: Record<string, unknown>): AdapterRuntimeEvent {
  const step = String(payload.step);
  const durationMs = payload.durationMs as number;
  return {
    eventType: RUN_STARTUP_STEP_EVENT_TYPE,
    stream: "system",
    level: "info",
    message: `startup step: ${step} (${durationMs}ms)`,
    payload,
  };
}

/**
 * Time `fn` with the injected `now` clock and emit exactly one
 * `run.startup.step` event carrying `{ step, durationMs }` plus any counters
 * supplied via `options`. The event fires in a `finally`, so a throwing step
 * still reports its duration before the error is re-thrown. `now` is injected
 * (never `Date.now()` here) so callers/tests stay deterministic, and
 * `ctx.onEvent` is optional — a missing sink is a no-op that neither throws nor
 * swallows `fn`'s return value or error. A step skipped by a warm cache never
 * calls this helper, so it emits no event (never a zero).
 *
 * When `options.tracer` is injected, the helper also opens one span at `start`
 * and ends it in the `finally`. The span carries a closed attribute allowlist:
 * `step`, the normalized `provider`, and the finite counter deltas
 * (`roundTrips` / `providerExecMs` / `providerGetMs`). A throwing `fn` sets the
 * span error status before the span ends. The span build reuses the same delta
 * values as the event payload, so the two paths never drift. The tracer
 * defaults to a no-op, so a caller with no tracer changes nothing. Every span
 * call sits inside the same error swallow as the event sink, so a throwing
 * tracer never changes startup control flow.
 */
export async function measureStartupStep<T>(
  ctx: Pick<AdapterExecutionContext, "onEvent">,
  now: () => number,
  step: string,
  fn: () => Promise<T>,
  options: StartupStepMeasureOptions = {},
): Promise<T> {
  const start = now();
  const roundTripsStart = options.roundTrips?.();
  const providerExecStart = options.providerExecMs?.();
  const providerGetStart = options.providerGetMs?.();

  // Open the span with only the low-cardinality allowlisted attributes known at
  // the start: the step name and the normalized provider family.
  const tracer = options.tracer ?? NOOP_TRACER;
  const startAttributes: Record<string, string> = { step };
  if (options.provider !== undefined) {
    startAttributes.provider = normalizeProviderFamily(options.provider);
  }
  let span: StartupSpan;
  try {
    span = tracer.startSpan(step, { attributes: startAttributes }, options.parentContext);
  } catch {
    // A throwing tracer must not change startup control flow.
    span = NOOP_SPAN;
  }

  let stepFailed = false;
  try {
    return await fn();
  } catch (err) {
    stepFailed = true;
    throw err;
  } finally {
    const durationMs = now() - start;

    // One attribute-build block feeds both the event payload and the span, so
    // the two paths never drift. `undefined` deltas produce neither a payload
    // field nor a span attribute (fail open — never `NaN`, never `0`).
    const roundTrips = finiteDelta(options.roundTrips, roundTripsStart);
    const providerExecMs = finiteDelta(options.providerExecMs, providerExecStart);
    const providerGetMs = finiteDelta(options.providerGetMs, providerGetStart);

    const payload: Record<string, unknown> = { step, durationMs };
    if (roundTrips !== undefined) payload.roundTrips = roundTrips;
    if (providerExecMs !== undefined) payload.providerExecMs = providerExecMs;
    if (providerGetMs !== undefined) payload.providerGetMs = providerGetMs;
    if (options.extra) {
      // `extra` feeds the EVENT payload only. Its keys never become span
      // attributes, so it cannot widen the closed span allowlist.
      Object.assign(payload, options.extra());
    }

    try {
      if (stepFailed) span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
      setFiniteNumberAttr(span, "roundTrips", roundTrips);
      setFiniteNumberAttr(span, "providerExecMs", providerExecMs);
      setFiniteNumberAttr(span, "providerGetMs", providerGetMs);
      span.end();
    } catch {
      // Observability must not change startup control flow.
    }

    try {
      await ctx.onEvent?.(buildStepEvent(payload));
    } catch {
      // Observability must not change startup control flow.
    }
  }
}
