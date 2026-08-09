import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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
 * The common prefix for every sandbox-startup span attribute. One prefix keeps
 * the attribute namespace closed and easy to find in the telemetry backend.
 */
export const SANDBOX_STARTUP_SPAN_ATTR_PREFIX = "paperclip.sandbox.startup.";

/**
 * The closed attribute-name contract for every sandbox-startup span. This is
 * the single source of truth for the harness span attributes. Each name uses
 * the `paperclip.sandbox.startup.` prefix and a type suffix:
 *
 * - `*.wall_ms` — one wall-clock time in float milliseconds.
 * - `*.count` — a count.
 *
 * The producer sets only these keys. It never sets a free-form key, so a
 * command, a path, an argument, or an environment value can never ride a span.
 */
export const SANDBOX_STARTUP_SPAN_ATTRS = {
  /** The low-cardinality provider family (through `normalizeProviderFamily`). */
  provider: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}provider`,
  /** The step or execution outcome: `ok`, `skipped`, or `failed`. */
  outcome: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}outcome`,
  /** The wall-clock time of one measured step. */
  stepWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}step.wall_ms`,
  /** The clamped `argv[0]` command label of one execution. */
  execCommand: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.command`,
  /** The numeric process exit code of one execution. */
  execExitCode: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.exit_code`,
  /** The host-measured wall time of one execution. */
  execWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.wall_ms`,
  /** The provider handle-fetch wait before one execution ran. */
  execWaitBeforeMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.wait_before_ms`,
  /** The in-sandbox run time of one execution. */
  execSandboxMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.sandbox_ms`,
  /** The transport time the host adds around one execution. */
  execNetworkMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.network_ms`,
  /** Whether one execution sits on the startup critical path. */
  execCriticalPath: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.critical_path`,
  /** Whether the provider served the sandbox handle from its warm cache. */
  execCacheHit: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}exec.cache_hit`,
  /** The root-span wall time of the whole bring-up. */
  rootWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}root.wall_ms`,
  /** The sum of the step wall times of the whole bring-up. */
  rootWorkMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}root.work_ms`,
  /** The difference between the work sum and the wall time (overlap). */
  rootDiffMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}root.diff_ms`,
  /** Whether this bring-up is a cold start (no warm handle). */
  coldStart: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}cold_start`,
  /** The clamped region label (through `clampSpanLabel`). */
  region: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}region`,
  /** The hashed image-id label (through `clampSpanLabel`). */
  imageId: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}image_id`,
  /** The hashed sandbox-id label (through `clampSpanLabel`). */
  sandboxId: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}sandbox_id`,
  /** The hashed lease-id label (through `clampSpanLabel`). */
  leaseId: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}lease_id`,
  /** The create-runtime sub-time of the `acp.handshake` step. */
  handshakeCreateRuntimeWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}handshake.create_runtime.wall_ms`,
  /** The ensure-session sub-time of the `acp.handshake` step. */
  handshakeEnsureSessionWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}handshake.ensure_session.wall_ms`,
  /** A shared low-cardinality tag that marks two steps as one parallel batch. */
  batch: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}batch`,
  /** The host-local wall time of the pack step (build the tarball). */
  packWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}pack.wall_ms`,
  /** The wall time of the transfer step (upload the files to the sandbox). */
  transferWallMs: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}transfer.wall_ms`,
  /** The number of serial guard round trips before one transfer. */
  transferGuardCount: `${SANDBOX_STARTUP_SPAN_ATTR_PREFIX}transfer.guard.count`,
} as const;

/** The closed value set for the `outcome` attribute. */
export const SANDBOX_STARTUP_OUTCOME = {
  ok: "ok",
  skipped: "skipped",
  failed: "failed",
} as const;

export type SandboxStartupOutcome =
  (typeof SANDBOX_STARTUP_OUTCOME)[keyof typeof SANDBOX_STARTUP_OUTCOME];

/**
 * The known command labels. A raw `argv[0]` outside this set maps to `other`,
 * so a full command line, a path, or an argument never rides a span. Keep this
 * list closed and small; a new command that is safe to name adds one entry.
 */
const KNOWN_COMMAND_LABELS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "env",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "ln",
  "cat",
  "echo",
  "printf",
  "test",
  "chmod",
  "true",
  "tar",
  "git",
  "node",
  "npm",
  "pnpm",
  "sudo",
  "bwrap",
]);

/**
 * The known region labels. A raw region outside this set maps to `unknown`, so
 * a free-form region string never widens the attribute cardinality. Keep this
 * list closed; a new supported region adds one entry.
 */
const KNOWN_REGION_LABELS: ReadonlySet<string> = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
]);

/** The fallback value for a raw command outside the known-command allowlist. */
const OTHER_COMMAND_LABEL = "other";
/** The fallback value for a raw region outside the known-region allowlist. */
const UNKNOWN_REGION_LABEL = "unknown";

/**
 * Map a raw label value to a non-reversible short hash. An id or an image
 * reference can hold an internal codename or a secret-like string, so the span
 * carries a hash, never the raw value. The hash is a stable 12-hex-character
 * prefix of the SHA-256 digest; it is not reversible and it is low-collision
 * for correlation.
 */
function hashLabelValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Bound a span label value to a closed, low-cardinality set. This is the one
 * boundary function for every free-form label. It is a hard-coded per-label
 * map, the same pattern as `normalizeProviderFamily`:
 *
 * - `command` — a known command basename maps to itself; any other value maps
 *   to `other`, so a full command line, a path, or an argument never leaks.
 * - `region` — a known region maps to itself; any other value maps to
 *   `unknown`.
 * - `image_id` / `sandbox_id` / `lease_id` — the raw value maps to a
 *   non-reversible short hash, because it can hold an internal codename or a
 *   secret-like string, and the telemetry backend may index it.
 *
 * An unknown label name returns `undefined`, so the caller drops it. A missing
 * value for a hashed label returns `undefined` too (fail open — never a raw
 * value, never an empty attribute).
 */
export function clampSpanLabel(name: string, value: string | undefined): string | undefined {
  switch (name) {
    case "command":
      return value !== undefined && KNOWN_COMMAND_LABELS.has(value)
        ? value
        : OTHER_COMMAND_LABEL;
    case "region":
      return value !== undefined && KNOWN_REGION_LABELS.has(value)
        ? value
        : UNKNOWN_REGION_LABEL;
    case "image_id":
    case "sandbox_id":
    case "lease_id":
      return value && value.length > 0 ? hashLabelValue(value) : undefined;
    default:
      return undefined;
  }
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
 * The active step context that `measureStartupStep` publishes while it runs the
 * step body `fn`. Inner code (for example the host→sandbox exec seam) reads it
 * through `getActiveStepContext()` to parent a child span to the step span.
 *
 * - `span` — the open step span. A child span may set its status or read it.
 * - `parentContext` — a parent-context token whose active span is the step span.
 *   A child span opened with this token parents to the step span. It is opaque
 *   to `adapter-utils`; the server builds it through `contextWithSpan`.
 * - `criticalPath` — whether the step sits on the startup critical path. Two
 *   overlapping steps (the parallel bridges) set it `false`; every other step
 *   is `true`.
 */
export interface ActiveStepContext {
  readonly span: StartupSpan;
  readonly parentContext: StartupSpanContext;
  readonly criticalPath: boolean;
}

/**
 * The one storage for the active step context. `measureStartupStep` runs the
 * step body inside it; inner code reads it with `getActiveStepContext()`. It is
 * a module-level singleton, so the value propagates across `await` boundaries
 * and across package boundaries that share this module.
 */
const activeStepContextStorage = new AsyncLocalStorage<ActiveStepContext | undefined>();

/**
 * Return the active step context, or `null` when no measured step is running.
 * Inner code parents a child span to the step span through
 * `getActiveStepContext()?.parentContext`. A `null` result is a no-op: the
 * caller opens no child span or opens an unparented span.
 */
export function getActiveStepContext(): ActiveStepContext | null {
  return activeStepContextStorage.getStore() ?? null;
}

/**
 * Run `work` with no active step context, then restore the previous store. A
 * bridge boundary uses this to start its long-lived poll timer and socket
 * handlers outside the measured step store.
 *
 * Node snapshots the active store on each async resource at creation time. So a
 * timer or a handler scheduled inside a measured step body keeps that step store
 * after the step span ends. A later run-time exec then reads the ended step and
 * parents its `sandbox.exec` span to a dead startup step, and it copies the
 * step's `criticalPath` flag. This helper resets the store for the wrapped work,
 * so each continuation reads an empty store. Each run-time exec then opens an
 * unparented span with no stale `criticalPath` flag.
 *
 * The helper forwards only the opaque store, so this package stays free of
 * `@opentelemetry/api`. It needs no Node version gate.
 */
export function runWithoutActiveStep<T>(work: () => T): T {
  return activeStepContextStorage.run(undefined, work);
}

/**
 * Build the minimal active step context that the store publishes. The step path
 * and `runWithRuntimeParent` share this builder, so both write the same shape.
 */
function buildActiveStepContext(
  span: StartupSpan,
  parentContext: StartupSpanContext,
  criticalPath: boolean,
): ActiveStepContext {
  return { span, parentContext, criticalPath };
}

/**
 * Run `work` under a given parent-context token, then restore the previous
 * store. A run-time exec that reads `getActiveStepContext()` inside `work`
 * parents its span to `parentContext`, not to a startup step. The store carries
 * the no-op span, because there is no open step span at run time. It sets
 * `criticalPath` to `false`, because a run-time exec is not on the startup
 * critical path.
 *
 * When `parentContext` is `undefined`, the helper empties the store, exactly
 * like `runWithoutActiveStep`. Inner code then reads `null` and opens an
 * unparented span.
 *
 * The helper forwards only the opaque token, so this package stays free of
 * `@opentelemetry/api`.
 */
export function runWithRuntimeParent<T>(
  parentContext: StartupSpanContext,
  work: () => T,
): T {
  if (parentContext === undefined) {
    return activeStepContextStorage.run(undefined, work);
  }
  const activeStep = buildActiveStepContext(NOOP_SPAN, parentContext, false);
  return activeStepContextStorage.run(activeStep, work);
}

/**
 * Run one run-time operation inside its own wrapper span. The runner opens a
 * wrapper span parented to the current run span, publishes the wrapper span as
 * the runtime parent while `work` runs, and ends the span when `work` settles.
 * A child `sandbox.exec` span inside `work` parents to the wrapper span, so the
 * trace groups the operation's execs under one named span. A throwing `work`
 * sets the wrapper span error status before the span ends.
 *
 * The runner reads the run parent per call, so it always parents to the live
 * span (`agent.turn` during the turn, `task.run` otherwise). The default runner
 * opens no real span; it only runs `work` under the current run parent, so the
 * span path stays a no-op until the server injects a real tracer.
 */
export type RuntimeSpanRunner = <T>(name: string, work: () => Promise<T>) => Promise<T>;

/**
 * Build a {@link RuntimeSpanRunner} from a trace context and the run-parent
 * getter. The runner opens the wrapper span through `traceContext.tracer`, and
 * it derives the wrapper span's child parent token through
 * `traceContext.contextWithSpan`. A no-op trace context yields a runner that
 * opens no real span and runs `work` under the current run parent, so the span
 * path stays inert until the server injects a real tracer. Every tracer call
 * sits inside an error swallow, so a throwing tracer never changes control flow.
 */
export function createRuntimeSpanRunner(
  traceContext: StartupTraceContext,
  getRuntimeParentContext: () => StartupSpanContext | undefined,
): RuntimeSpanRunner {
  return async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const parentContext = getRuntimeParentContext();
    let span: StartupSpan;
    try {
      span = traceContext.tracer.startSpan(name, undefined, parentContext);
    } catch {
      // A throwing tracer must not change control flow; run `work` unwrapped.
      return runWithRuntimeParent(parentContext, work);
    }
    let childContext: StartupSpanContext;
    try {
      childContext = traceContext.contextWithSpan(span);
    } catch {
      childContext = parentContext;
    }
    let failed = false;
    try {
      return await runWithRuntimeParent(childContext, work);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      try {
        if (failed) span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
        span.end();
      } catch {
        // Observability must not change control flow.
      }
    }
  };
}

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
 * Optional per-step attribution for a `run.startup.step` event and its span.
 * The event payload carries only the high-level fields (`step`, `durationMs`,
 * `outcome`). The detailed per-step round-trip and provider-duration numbers
 * ride the OTel spans (the per-execution `sandbox.exec` child spans and the
 * step span), not the payload. These options configure the span path and the
 * step context.
 *
 * - `tracer` — an injected structural tracer. It defaults to a no-op, so the
 *   span path changes no runtime behavior until the server injects a real
 *   tracer. The span carries only the closed attribute allowlist from
 *   `SANDBOX_STARTUP_SPAN_ATTRS`: the normalized `provider`, the step wall time,
 *   and the outcome. The step name rides the span name, not an attribute. The
 *   round-trip and provider-duration detail rides the per-execution
 *   `sandbox.exec` child spans.
 * - `parentContext` — an opaque parent-context token from the root span. When
 *   set, the step's span parents to that root. `measureStartupStep` forwards it
 *   to `startSpan` and never inspects it, so parenting stays explicit and does
 *   not depend on ambient async-context propagation.
 * - `provider` — the raw provider key for the step. `measureStartupStep`
 *   normalizes it through `normalizeProviderFamily` before it sets the
 *   low-cardinality `provider` span attribute. It never sets the raw key.
 */
export interface StartupStepMeasureOptions {
  tracer?: StartupTracer;
  parentContext?: StartupSpanContext;
  provider?: string;
  /**
   * Build a parent-context token whose active span is a given span. The server
   * binds it to `@opentelemetry/api`. `measureStartupStep` uses it once, after
   * it opens the step span, to publish the step's child context on the active
   * step context. Inner code reads that context to parent an exec span to the
   * step span. When absent, the active step context carries no parent token, so
   * an inner exec span opens unparented (a no-op when tracing is off).
   */
  contextWithSpan?: (span: StartupSpan) => StartupSpanContext;
  /**
   * Whether the step sits on the startup critical path. It rides the active
   * step context, so an inner exec span records it. Two overlapping steps (the
   * parallel bridges) pass `false`; every other step defaults to `true`.
   */
  criticalPath?: boolean;
  /**
   * Report the step wall time (float ms) once the step settles. The executor
   * accumulates it into the root-span work sum. A throwing reporter never
   * changes startup control flow.
   */
  onWallMs?: (wallMs: number) => void;
  /**
   * A shared low-cardinality batch tag. Two steps that run in parallel (the
   * bridges) pass the same value, so the trace marks them as one batch. It
   * rides the span as the closed `…batch` attribute. Pass only a fixed literal,
   * never run or user data.
   */
  batch?: string;
  /**
   * Named wall-time sub-splits (float ms) that ride the step span as fixed,
   * closed attribute keys. Only `acp.handshake` uses it today, for the
   * create-runtime and ensure-session sub-times. The helper maps each value to
   * a hard-coded attribute key, so a free-form key can never widen the closed
   * span allowlist. A non-finite value sets no attribute.
   */
  spanWallTimes?: () => Partial<Record<"createRuntime" | "ensureSession", number>>;
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
 * `run.startup.step` event carrying only the high-level `{ step, durationMs,
 * outcome }`. The event fires in a `finally`, so a throwing step
 * still reports its duration before the error is re-thrown. `now` is injected
 * (never `Date.now()` here) so callers/tests stay deterministic, and
 * `ctx.onEvent` is optional — a missing sink is a no-op that neither throws nor
 * swallows `fn`'s return value or error. A step skipped by a warm cache never
 * calls this helper, so it emits no event (never a zero).
 *
 * When `options.tracer` is injected, the helper also opens one span at `start`
 * and ends it in the `finally`. The span carries a closed attribute allowlist
 * from `SANDBOX_STARTUP_SPAN_ATTRS`: the normalized `provider`, the step wall
 * time, and the outcome (`ok` or `failed`). The step name rides the span name.
 * A throwing `fn` sets the span error status before the span ends and the
 * outcome is `failed`. The round-trip and provider-duration detail rides the
 * spans, not the payload. The tracer
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

  // Open the span with only the low-cardinality allowlisted attributes known at
  // the start: the normalized provider family. The span name already carries
  // the step name, so no redundant `step` attribute rides the span.
  const tracer = options.tracer ?? NOOP_TRACER;
  const startAttributes: Record<string, string> = {};
  if (options.provider !== undefined) {
    startAttributes[SANDBOX_STARTUP_SPAN_ATTRS.provider] = normalizeProviderFamily(options.provider);
  }
  if (options.batch !== undefined) {
    startAttributes[SANDBOX_STARTUP_SPAN_ATTRS.batch] = options.batch;
  }
  let span: StartupSpan;
  try {
    span = tracer.startSpan(step, { attributes: startAttributes }, options.parentContext);
  } catch {
    // A throwing tracer must not change startup control flow.
    span = NOOP_SPAN;
  }

  // Publish the active step context while `fn` runs. Inner code (the host→
  // sandbox exec seam) reads it to parent an exec span to this step span. The
  // parent token is the step span's own child context; a missing
  // `contextWithSpan` (no injected trace context) yields `undefined`, so an
  // inner exec span opens unparented — a no-op when tracing is off. The
  // `contextWithSpan` call is guarded, so a throwing helper never changes
  // startup control flow.
  let stepChildContext: StartupSpanContext;
  try {
    stepChildContext = options.contextWithSpan?.(span);
  } catch {
    stepChildContext = undefined;
  }
  const activeStep = buildActiveStepContext(
    span,
    stepChildContext,
    options.criticalPath ?? true,
  );

  let stepFailed = false;
  try {
    return await activeStepContextStorage.run(activeStep, fn);
  } catch (err) {
    stepFailed = true;
    throw err;
  } finally {
    const durationMs = now() - start;

    // The step outcome. A throwing `fn` is `failed`; a settled `fn` is `ok`. A
    // step that a warm cache skips uses `emitSkippedStartupStep` instead.
    const outcome: SandboxStartupOutcome = stepFailed
      ? SANDBOX_STARTUP_OUTCOME.failed
      : SANDBOX_STARTUP_OUTCOME.ok;

    // The payload carries only the high-level fields. The detailed per-step
    // round-trip and provider-duration numbers ride the OTel spans now, so the
    // run-log copy is gone.
    const payload: Record<string, unknown> = { step, durationMs, outcome };

    try {
      if (stepFailed) span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
      // The step span carries only the step wall time and the outcome. The
      // per-execution `sandbox.exec` child spans now carry the round-trip and
      // provider-duration detail, so the step span no longer duplicates them.
      setFiniteNumberAttr(span, SANDBOX_STARTUP_SPAN_ATTRS.stepWallMs, durationMs);
      span.setAttribute(SANDBOX_STARTUP_SPAN_ATTRS.outcome, outcome);
      if (options.spanWallTimes) {
        // Map each named sub-time to a hard-coded, closed attribute key, so a
        // caller cannot widen the span allowlist with a free-form key.
        const sub = options.spanWallTimes();
        setFiniteNumberAttr(span, SANDBOX_STARTUP_SPAN_ATTRS.handshakeCreateRuntimeWallMs, sub.createRuntime);
        setFiniteNumberAttr(span, SANDBOX_STARTUP_SPAN_ATTRS.handshakeEnsureSessionWallMs, sub.ensureSession);
      }
      span.end();
    } catch {
      // Observability must not change startup control flow.
    }

    try {
      options.onWallMs?.(durationMs);
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

/**
 * The two root-span timing numbers. `wallMs` is the root span's own wall time.
 * `workMs` is the sum of the step wall times. The difference (`workMs − wallMs`)
 * is the overlap the parallel steps saved.
 */
export interface SandboxRootSpanTimings {
  wallMs: number;
  workMs: number;
}

/**
 * The low-cardinality root-span context. Each field is optional and omitted
 * when absent (fail open — never an invented value). The helper below bounds
 * each value: `provider` through `normalizeProviderFamily`, `region` through a
 * small allowlist, and each id or image through a non-reversible hash.
 */
export interface SandboxRootSpanContext {
  coldStart?: boolean;
  provider?: string;
  region?: string;
  imageId?: string;
  sandboxId?: string;
  leaseId?: string;
}

/**
 * Assemble every root-span (`sandbox.startup`) attribute in one place. This is
 * the single producer-side boundary for the root span: it sets only the closed
 * `paperclip.sandbox.startup.` allowlist. It records the wall, work, and diff
 * times, and the bounded context. A raw id, an image reference, or a region
 * never rides the span un-bounded, and an absent value sets no attribute.
 */
export function setSandboxRootSpanAttributes(
  span: StartupSpan,
  timings: SandboxRootSpanTimings,
  context: SandboxRootSpanContext,
): void {
  const A = SANDBOX_STARTUP_SPAN_ATTRS;
  setFiniteNumberAttr(span, A.rootWallMs, timings.wallMs);
  setFiniteNumberAttr(span, A.rootWorkMs, timings.workMs);
  setFiniteNumberAttr(span, A.rootDiffMs, timings.workMs - timings.wallMs);
  if (context.coldStart !== undefined) span.setAttribute(A.coldStart, context.coldStart);
  if (context.provider !== undefined) {
    span.setAttribute(A.provider, normalizeProviderFamily(context.provider));
  }
  // A region rides only when a value is present; an unknown region maps to
  // `unknown`, never a free-form string.
  if (context.region !== undefined) {
    const region = clampSpanLabel("region", context.region);
    if (region !== undefined) span.setAttribute(A.region, region);
  }
  // The image id and the ids ride only as non-reversible hashes.
  const imageId = clampSpanLabel("image_id", context.imageId);
  if (imageId !== undefined) span.setAttribute(A.imageId, imageId);
  const sandboxId = clampSpanLabel("sandbox_id", context.sandboxId);
  if (sandboxId !== undefined) span.setAttribute(A.sandboxId, sandboxId);
  const leaseId = clampSpanLabel("lease_id", context.leaseId);
  if (leaseId !== undefined) span.setAttribute(A.leaseId, leaseId);
}

/** The options a skipped step reuses from a measured step: the tracer, the root
 * parent-context token, and the raw provider key. */
export type SkippedStartupStepOptions = Pick<
  StartupStepMeasureOptions,
  "tracer" | "parentContext" | "provider"
>;

/**
 * Emit one `run.startup.step` span and event for a step that a warm cache
 * skips, with `outcome = skipped` and a zero wall time. A skipped step runs no
 * work, so this helper opens and ends the span without a body. It shows the
 * skip as a real, distinct outcome, never a misleading zero-work `ok` step.
 *
 * The span and the event carry the closed allowlist: the step name (the span
 * name), the normalized `provider` (when given), `step.wall_ms = 0`, and
 * `outcome = skipped`. Every tracer and sink call sits inside an error swallow,
 * so a throwing tracer or sink never changes startup control flow. The tracer
 * defaults to a no-op, so a caller with no tracer only emits the event.
 */
export async function emitSkippedStartupStep(
  ctx: Pick<AdapterExecutionContext, "onEvent">,
  step: string,
  options: SkippedStartupStepOptions = {},
): Promise<void> {
  const tracer = options.tracer ?? NOOP_TRACER;
  const startAttributes: Record<string, string> = {};
  if (options.provider !== undefined) {
    startAttributes[SANDBOX_STARTUP_SPAN_ATTRS.provider] = normalizeProviderFamily(options.provider);
  }
  let span: StartupSpan;
  try {
    span = tracer.startSpan(step, { attributes: startAttributes }, options.parentContext);
  } catch {
    span = NOOP_SPAN;
  }
  try {
    span.setAttribute(SANDBOX_STARTUP_SPAN_ATTRS.stepWallMs, 0);
    span.setAttribute(SANDBOX_STARTUP_SPAN_ATTRS.outcome, SANDBOX_STARTUP_OUTCOME.skipped);
    span.end();
  } catch {
    // Observability must not change startup control flow.
  }
  try {
    await ctx.onEvent?.(
      buildStepEvent({ step, durationMs: 0, outcome: SANDBOX_STARTUP_OUTCOME.skipped }),
    );
  } catch {
    // Observability must not change startup control flow.
  }
}
