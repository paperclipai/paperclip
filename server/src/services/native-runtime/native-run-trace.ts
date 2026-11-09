import { getRunExecutionTraceContext } from "../execution-preparation-timing.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";

import { runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import {
  getStartupTraceContext,
  type StartupTraceContextHandle,
} from "../../instrumentation.js";
import {
  evaluateSpeedBudget,
  SPEED_BUDGET_EXCEEDED_EVENT_TYPE,
  type SpeedBudgetAdapter,
  type SpeedBudgetBreach,
  type SpeedBudgetStart,
} from "./native-speed-budgets.js";

export const NATIVE_RUN_SPAN_EVENT_TYPE = "run.performance.span";
export const NATIVE_RUN_TRACE_SCHEMA_VERSION = 3;

export type NativeRunSpanOutcome = "ok" | "failed";

export interface NativeRunHistoricalSpan {
  name: string;
  parentName?: string;
  startedAtMs: number;
  endedAtMs: number;
  outcome?: NativeRunSpanOutcome;
  attributes?: Record<string, string | number | boolean>;
}

export function isNativeRunRootHistoricalSpan(name: string): boolean {
  return (
    name === "heartbeat.queue" ||
    name === "comment.to_run_created" ||
    name === "question_response.to_run_created"
  );
}

/** Current causal ingress, not the older source comment kept for provenance. */
export function buildNativeWakeIngressSpan(input: {
  runCreatedAtMs: number;
  wakeComments: readonly unknown[];
  /** Attempt-local output of committed server authorization, never a wake marker. */
  attestedQuestionResponseAtMs: number | null;
}): NativeRunHistoricalSpan | null {
  const answeredAt = input.attestedQuestionResponseAtMs;
  if (answeredAt !== null && Number.isFinite(answeredAt) && answeredAt >= 0) {
    return {
      name: "question_response.to_run_created",
      parentName: "task.provider_session",
      startedAtMs: answeredAt,
      endedAtMs: Math.max(answeredAt, input.runCreatedAtMs),
    };
  }
  const createdAt = input.wakeComments
    .map((comment) => {
      const value =
        comment && typeof comment === "object" && !Array.isArray(comment)
          ? (comment as Record<string, unknown>).createdAt
          : null;
      return typeof value === "string" ? Date.parse(value) : Number.NaN;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return createdAt === undefined
    ? null
    : {
        name: "comment.to_run_created",
        parentName: "task.provider_session",
        startedAtMs: createdAt,
        endedAtMs: Math.max(createdAt, input.runCreatedAtMs),
      };
}

export function buildNativeHeartbeatPreparationSpans(input: {
  runCreatedAtMs: number;
  runStartedAtMs: number;
  attemptStartedAtMs: number;
  environmentAcquireStartedAtMs: number;
  environmentRealizeEndedAtMs: number;
  nativeDispatchAtMs: number;
}): NativeRunHistoricalSpan[] {
  return [
    {
      name: "heartbeat.queue",
      parentName: "task.provider_session",
      startedAtMs: input.runCreatedAtMs,
      endedAtMs: Math.max(input.runCreatedAtMs, input.runStartedAtMs),
    },
    {
      name: "heartbeat.prepare_before_environment",
      parentName: "task.provider_session",
      // A same-run resume retains startedAt for wall-time accounting; it is
      // not the beginning of this dispatch attempt's preparation.
      startedAtMs: input.attemptStartedAtMs,
      endedAtMs: Math.max(
        input.attemptStartedAtMs,
        input.environmentAcquireStartedAtMs,
      ),
    },
    {
      name: "heartbeat.prepare_after_environment",
      parentName: "task.provider_session",
      startedAtMs: Math.min(
        input.nativeDispatchAtMs,
        input.environmentRealizeEndedAtMs,
      ),
      endedAtMs: input.nativeDispatchAtMs,
    },
  ];
}

/** Which accepted input `task.time_to_first_token` is measured from. */
export type NativeTimeToFirstTokenAnchor =
  | "question_response"
  | "comment"
  | "wake_request"
  | "run_created";

/**
 * Resolve the start of `task.time_to_first_token`: the earliest accepted input
 * that caused this run. A question answer or a wake comment is already a root
 * historical span. Otherwise the run row's creation time is the fallback. A
 * durable wake request accepted earlier (deferred, coalesced or retried wakes)
 * moves the start back to that request, so queueing before the run row exists
 * is part of the measured latency.
 *
 * Run-log only. The wake request time is read after the first deliverable
 * text, never before `turn.start`.
 */
export function resolveNativeTimeToFirstTokenStart(input: {
  traceStartedAtMs: number;
  preparationSpans: readonly NativeRunHistoricalSpan[];
  wakeRequestedAtMs: number | null;
}): { startedAtMs: number; anchor: NativeTimeToFirstTokenAnchor } {
  const ingress = input.preparationSpans.find(
    (span) =>
      span.name === "question_response.to_run_created" ||
      span.name === "comment.to_run_created",
  );
  // The trace starts at the earliest preparation span. A comment coalesced
  // into an already-queued run starts after run creation, so it names the
  // start only when it is that earliest span.
  const ingressIsStart = ingress !== undefined && ingress.startedAtMs <= input.traceStartedAtMs;
  let anchor: NativeTimeToFirstTokenAnchor =
    !ingressIsStart
      ? "run_created"
      : ingress.name === "question_response.to_run_created"
        ? "question_response"
        : "comment";
  let startedAtMs = input.traceStartedAtMs;
  const wakeAt = input.wakeRequestedAtMs;
  if (
    wakeAt !== null &&
    Number.isFinite(wakeAt) &&
    wakeAt >= 0 &&
    wakeAt < startedAtMs
  ) {
    startedAtMs = wakeAt;
    anchor = "wake_request";
  }
  return { startedAtMs, anchor };
}

export function nativeRunPreparationStarts(
  spans: NativeRunHistoricalSpan[],
  nowMs: number,
): { runStartedAtMs: number; preparationStartedAtMs: number } {
  const runStartedAtMs = spans.reduce(
    (earliest, span) => Math.min(earliest, span.startedAtMs),
    nowMs,
  );
  // Queue and accepted-comment latency remain run-level history. Including
  // them in task.prepare would charge previous attempts and recovery delays
  // to every resumed attempt, even if its actual startup took milliseconds.
  const preparationStartedAtMs = spans
    .filter((span) => !isNativeRunRootHistoricalSpan(span.name))
    .reduce((earliest, span) => Math.min(earliest, span.startedAtMs), nowMs);
  return { runStartedAtMs, preparationStartedAtMs };
}

export interface NativeRunSpanScope {
  readonly name: string;
  readonly parentName: string;
  readonly startedAtMs: number;
}

type NativeRunTraceSink = (event: AdapterRuntimeEvent) => Promise<void>;

type SpanHandle = ReturnType<StartupTraceContextHandle["tracer"]["startSpan"]>;

interface NativeRunSpanScopeState extends NativeRunSpanScope {
  span: SpanHandle;
  context: unknown;
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
  persistRunLog: boolean;
}

const NOOP_SPAN: SpanHandle = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const SAFE_NATIVE_RUN_SPAN_ATTRIBUTE_KEYS = new Set([
  "adapter",
  "anchor",
  "bytesTransferred",
  "inputBytes", "toolSchemaBytes", "toolCount", "contextReused", "tokenDataAvailable",
  "connectionOwner",
  "driver",
  "duration_ms",
  "eventKind",
  "harness",
  "identityPresent",
  "lifecycleMode",
  "mode",
  "outcome",
  "operation",
  "provider",
  "reason",
  "runtime",
  "stateSource",
  "strategy",
  "target",
]);

function finiteMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function hashedId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeAttributes(
  attributes: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!attributes) return {};
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(
        ([key, value]) =>
          SAFE_NATIVE_RUN_SPAN_ATTRIBUTE_KEYS.has(key) &&
          (typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" && value.length <= 120)),
      )
      .slice(0, 16),
  );
}

/**
 * Run-scoped tracing for the native Paperclip runner path.
 *
 * A scope owns a real OpenTelemetry parent context. While work runs inside a
 * scope, nested native measurements and the existing sandbox/provider tracing
 * seams inherit that context. The persisted run-event copy retains the same
 * semantic parent name for developer installs without an OTLP collector.
 */
export function createNativeRunTrace(input: {
  runId: string;
  startedAtMs?: number;
  onEvent?: NativeRunTraceSink;
  traceContext?: StartupTraceContextHandle;
  /** Speed-budget subject (invariant 8). Absent or remote means no check. */
  budget?: {
    adapter: SpeedBudgetAdapter | null;
    environment: "local" | "remote";
    /** A restart-recovery dispatch: its TTFT and boot span the outage, so only
     * `restart_recovery` is judged. */
    restartRecovery?: boolean;
  };
}) {
  const tracing =
    input.traceContext ?? getStartupTraceContext("paperclip.native-runner");
  const traceStartedAtMs = finiteMs(input.startedAtMs ?? Date.now());
  const runIdHash = hashedId(input.runId);
  let rootSpan: SpanHandle;
  try {
    const owned = getRunExecutionTraceContext(input.runId);
    const trigger = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
      ? (owned ? trace.getSpan(owned) : trace.getActiveSpan())?.spanContext()
      : undefined;
    rootSpan = tracing.tracer.startSpan("task.provider_session", {
      startTime: traceStartedAtMs,
      attributes: {
        "paperclip.task.run.run_id": runIdHash,
        "paperclip.task.run.runtime": "paperclip_runner",
        "paperclip.task.run.trace_schema_version":
          NATIVE_RUN_TRACE_SCHEMA_VERSION,
      },
      ...(trigger && isSpanContextValid(trigger) ? { links: [{ context: trigger }] } : {}),
    }, ROOT_CONTEXT);
  } catch {
    rootSpan = NOOP_SPAN;
  }
  let rootContext: unknown;
  try {
    rootContext = tracing.contextWithSpan(rootSpan);
  } catch {
    rootContext = undefined;
  }

  const scopeStorage = new AsyncLocalStorage<
    NativeRunSpanScopeState | undefined
  >();
  const scopes = new WeakSet<NativeRunSpanScope>();
  const openScopes = new Set<NativeRunSpanScopeState>();
  const namedScopes = new Map<string, NativeRunSpanScopeState>();
  let runtimeParentScope: NativeRunSpanScopeState | undefined;
  let ended = false;

  const scopeState = (scope: NativeRunSpanScope): NativeRunSpanScopeState => {
    if (!scopes.has(scope)) throw new Error("native_run_trace_scope_invalid");
    return scope as NativeRunSpanScopeState;
  };

  const currentParent = (): { name: string; context: unknown } => {
    const active = scopeStorage.getStore();
    return active && !active.ended
      ? { name: active.name, context: active.context }
      : runtimeParentScope && !runtimeParentScope.ended
        ? { name: runtimeParentScope.name, context: runtimeParentScope.context }
        : { name: "task.provider_session", context: rootContext };
  };

  const parentFor = (
    parentName?: string,
  ): { name: string; context: unknown } => {
    if (parentName && parentName !== "task.provider_session") {
      const named = namedScopes.get(parentName);
      if (named) return { name: named.name, context: named.context };
      return currentParent();
    }
    if (parentName === "task.provider_session")
      return { name: "task.provider_session", context: rootContext };
    return currentParent();
  };

  const setOtelAttributes = (
    span: SpanHandle,
    attributes: Record<string, string | number | boolean>,
  ): void => {
    for (const [key, value] of Object.entries(attributes)) {
      try {
        span.setAttribute(`paperclip.native.span.${key}`, value);
      } catch {
        // Tracing is diagnostic-only and must never change runner control flow.
      }
    }
  };

  // Speed budgets (invariant 8). Breaches are written detached, after the
  // measurement, so the check never adds a wait to the turn path.
  let budgetStart: SpeedBudgetStart | null = null;
  let queueEndedAtMs: number | null = null;
  // When the run row was created (start of heartbeat.queue, end of the
  // ingress span). Input accepted before it waited for a run to exist, for
  // example a comment posted while the previous turn was still running.
  let runCreatedAtMs: number | null = null;
  let attemptStartedAtMs: number | null = null;
  let bootChecked = false;
  const reportBudgetBreach = (breach: SpeedBudgetBreach | null): void => {
    if (!breach || !input.onEvent) return;
    defer(async () => {
      await input.onEvent?.({
        eventType: SPEED_BUDGET_EXCEEDED_EVENT_TYPE,
        stream: "system",
        level: "warn",
        message: `speed budget exceeded: ${breach.metric} ${breach.measuredMs}ms > p95 ${breach.budgetP95Ms}ms (${breach.adapter}, ${breach.startKind})`,
        payload: breach,
      });
    });
  };
  const checkSpanBudget = (name: string, startedAtMs: number, endedAtMs: number): void => {
    if (!input.budget || input.budget.restartRecovery) return;
    const subject = { adapter: input.budget.adapter, environment: input.budget.environment };
    if (name === "heartbeat.queue") { queueEndedAtMs = endedAtMs; runCreatedAtMs ??= startedAtMs; }
    if (name === "comment.to_run_created" || name === "question_response.to_run_created") runCreatedAtMs ??= endedAtMs;
    // A resumed attempt keeps the run's original queue span; its own claim is
    // the start of this attempt's preparation.
    if (name === "heartbeat.prepare_before_environment") attemptStartedAtMs = startedAtMs;
    if (name === "task.time_to_first_agent_activity") {
      // The span keeps the full user-visible latency. The budget (baseline:
      // idle follow-ups) judges it from run creation: time the input spent
      // waiting for a run to exist (behind a live turn) is reported, not judged.
      // Time to first text (task.time_to_first_token) is reported, not budgeted.
      const inputWaitMs = runCreatedAtMs !== null && runCreatedAtMs > startedAtMs ? runCreatedAtMs - startedAtMs : 0;
      reportBudgetBreach(evaluateSpeedBudget({ ...subject, metric: "time_to_first_activity", start: budgetStart,
        measuredMs: endedAtMs - startedAtMs - inputWaitMs, ...(inputWaitMs > 0 ? { inputWaitMs } : {}) }));
    }
    // Agent boot: run claimed (end of heartbeat.queue) to the provider session
    // accepting turn.start (end of runner.turn.submit or runner.session.resume).
    if ((name === "runner.turn.submit" || name === "runner.session.resume") && !bootChecked && queueEndedAtMs !== null) {
      bootChecked = true;
      const claimedAtMs = Math.max(queueEndedAtMs, attemptStartedAtMs ?? queueEndedAtMs);
      reportBudgetBreach(evaluateSpeedBudget({ ...subject, metric: "agent_boot", start: budgetStart,
        measuredMs: endedAtMs - claimedAtMs }));
    }
  };

  const emitCompletedSpanEvent = async (
    span: NativeRunHistoricalSpan,
  ): Promise<void> => {
    const startedAtMs = finiteMs(span.startedAtMs);
    const endedAtMs = Math.max(startedAtMs, finiteMs(span.endedAtMs));
    const durationMs = endedAtMs - startedAtMs;
    const outcome = span.outcome ?? "ok";
    const attributes = safeAttributes(span.attributes);
    try {
      await input.onEvent?.({
        eventType: NATIVE_RUN_SPAN_EVENT_TYPE,
        stream: "system",
        level: outcome === "failed" ? "warn" : "info",
        message: `runner span: ${span.name} (${durationMs.toFixed(1)}ms)`,
        payload: {
          // Keep the persisted schema identifier stable; traceSchemaVersion
          // describes the OTel hierarchy independently of the run-log shape.
          schema: "paperclip.run-performance-span.v1",
          traceSchemaVersion: NATIVE_RUN_TRACE_SCHEMA_VERSION,
          span: span.name,
          parentSpan: span.parentName ?? "task.provider_session",
          startOffsetMs: startedAtMs - traceStartedAtMs,
          durationMs,
          outcome,
          ...attributes,
        },
      });
    } catch {
      // A diagnostic sink failure must not fail the task.
    }
  };

  const start = (
    name: string,
    options: {
      parentName?: string;
      startedAtMs?: number;
      attributes?: Record<string, string | number | boolean>;
      /** False only when an existing durable diagnostic batch already contains the measurements. */
      persistRunLog?: boolean;
    } = {},
  ): NativeRunSpanScope => {
    const startedAtMs = finiteMs(options.startedAtMs ?? Date.now());
    const attributes = safeAttributes(options.attributes);
    const parent = parentFor(options.parentName);
    let span: SpanHandle;
    try {
      span = tracing.tracer.startSpan(
        name,
        {
          startTime: startedAtMs,
          attributes: {
            "paperclip.native.span.trace_schema_version":
              NATIVE_RUN_TRACE_SCHEMA_VERSION,
            ...Object.fromEntries(
              Object.entries(attributes).map(([key, value]) => [
                `paperclip.native.span.${key}`,
                value,
              ]),
            ),
          },
        },
        parent.context ?? ROOT_CONTEXT,
      );
    } catch {
      span = NOOP_SPAN;
    }
    let context: unknown;
    try {
      context = tracing.contextWithSpan(span);
    } catch {
      context = undefined;
    }
    const state: NativeRunSpanScopeState = {
      name,
      parentName: parent.name,
      startedAtMs,
      span,
      context,
      attributes,
      ended: false,
      persistRunLog: options.persistRunLog !== false,
    };
    scopes.add(state);
    openScopes.add(state);
    namedScopes.set(name, state);
    return state;
  };

  const annotate = (
    scope: NativeRunSpanScope,
    attributes: Record<string, string | number | boolean>,
  ): void => {
    const state = scopeState(scope);
    const incoming = safeAttributes(attributes);
    const retained = Object.fromEntries(
      Object.entries(state.attributes).slice(
        0,
        Math.max(0, 16 - Object.keys(incoming).length),
      ),
    );
    const safe = { ...retained, ...incoming };
    state.attributes = safe;
    setOtelAttributes(state.span, safe);
  };

  const end = async (
    scope: NativeRunSpanScope,
    options: {
      endedAtMs?: number;
      outcome?: NativeRunSpanOutcome;
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<void> => {
    const state = scopeState(scope);
    if (state.ended) return;
    state.ended = true;
    openScopes.delete(state);
    const endedAtMs = Math.max(
      state.startedAtMs,
      finiteMs(options.endedAtMs ?? Date.now()),
    );
    const outcome = options.outcome ?? "ok";
    const durationMs = endedAtMs - state.startedAtMs;
    annotate(state, {
      ...options.attributes,
      duration_ms: durationMs,
      outcome,
    });
    if (outcome === "failed") { try { state.span.setStatus({ code: 2 }); } catch {} }
    try { state.span.end(endedAtMs); } catch {}
    if (state.persistRunLog) await emitCompletedSpanEvent({
      name: state.name,
      parentName: state.parentName,
      startedAtMs: state.startedAtMs,
      endedAtMs,
      outcome,
      attributes: state.attributes,
    });
    checkSpanBudget(state.name, state.startedAtMs, endedAtMs);
  };

  const activate = (scope: NativeRunSpanScope): void => {
    const state = scopeState(scope);
    if (state.ended) return;
    runtimeParentScope = state;
  };

  const run = <T>(scope: NativeRunSpanScope, fn: () => T): T => {
    const state = scopeState(scope);
    const dynamicContext = new Proxy<Record<PropertyKey, unknown>>(
      {},
      {
        get(_target, property) {
          const active = scopeStorage.getStore();
          const target =
            active && !active.ended
              ? active.context
              : runtimeParentScope && !runtimeParentScope.ended
                ? runtimeParentScope.context
                : state.context;
          if (
            (typeof target !== "object" || target === null) &&
            typeof target !== "function"
          ) {
            return undefined;
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      },
    );
    return scopeStorage.run(state, () =>
      runWithRuntimeParent(dynamicContext, fn),
    );
  };

  const record = async (span: NativeRunHistoricalSpan, options: { persistRunLog?: boolean } = {}): Promise<void> => {
    const scope = start(span.name, {
      parentName: span.parentName,
      startedAtMs: span.startedAtMs,
      attributes: span.attributes,
      persistRunLog: options.persistRunLog,
    });
    await end(scope, {
      endedAtMs: span.endedAtMs,
      outcome: span.outcome,
    });
  };

  const measure = async <T>(
    name: string,
    fn: () => Promise<T>,
    options: {
      parentName?: string;
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<T> => {
    const scope = start(name, options);
    let outcome: NativeRunSpanOutcome = "ok";
    try {
      return await run(scope, fn);
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      await end(scope, { outcome });
    }
  };

  /**
   * Diagnostic work that must not block the caller (for example a read that
   * anchors a span). It runs detached; `finish` settles it before the root
   * span closes. The work must bound its own waits.
   */
  const pendingDiagnostics = new Set<Promise<void>>();
  const defer = (work: () => Promise<void>): void => {
    if (ended) return;
    const pending: Promise<void> = Promise.resolve()
      .then(work)
      .catch(() => {
        // Diagnostics cannot change runner control flow.
      })
      .finally(() => {
        pendingDiagnostics.delete(pending);
      });
    pendingDiagnostics.add(pending);
  };

  const finish = async (outcome: NativeRunSpanOutcome): Promise<void> => {
    if (ended) return;
    // Settled diagnostics can defer more (a budget breach after a deferred
    // measurement), so drain until none remain.
    while (pendingDiagnostics.size > 0) await Promise.all([...pendingDiagnostics]);
    if (ended) return;
    ended = true;
    const endedAtMs = Date.now();
    for (const scope of [...openScopes].reverse()) {
      await end(scope, { endedAtMs, outcome });
    }
    try { rootSpan.setAttribute("paperclip.task.run.wall_ms", endedAtMs - traceStartedAtMs); } catch {}
    try { rootSpan.setAttribute("paperclip.task.run.outcome", outcome); } catch {}
    if (outcome === "failed") { try { rootSpan.setStatus({ code: 2 }); } catch {} }
    try { rootSpan.end(endedAtMs); } catch {}
    // Preserve the historical run-log record without emitting a duplicate
    // full-width child span into the OpenTelemetry waterfall.
    await emitCompletedSpanEvent({
      name: "task.provider_session.measured",
      parentName: "task.provider_session",
      startedAtMs: traceStartedAtMs,
      endedAtMs,
      outcome,
      attributes: { runtime: "paperclip_runner" },
    });
  };

  /** Labels the run cold (fresh provider session) or warm (reused). */
  const setBudgetStart = (kind: SpeedBudgetStart): void => {
    budgetStart ??= kind;
  };

  /** Restart recovery latency: control plane ready to the recovered run's
   * next provider event, checked once per run. */
  let recoveryChecked = false;
  const checkRestartRecovery = (measurement: RestartRecoveryMeasurement): void => {
    if (!input.budget || recoveryChecked || measurement.readyAtMs === null) return;
    // An event emitted before ready (buffered by a surviving runner and
    // committed late) is not the recovered run's next event; it must not use
    // the one check.
    if (measurement.emittedAtMs !== null && measurement.emittedAtMs < measurement.readyAtMs) return;
    if (measurement.committedAtMs < measurement.readyAtMs) return;
    recoveryChecked = true;
    reportBudgetBreach(evaluateSpeedBudget({ adapter: input.budget.adapter, environment: input.budget.environment,
      metric: "restart_recovery", start: null, measuredMs: measurement.committedAtMs - measurement.readyAtMs,
      disposition: measurement.disposition }));
  };

  return {
    traceStartedAtMs,
    setBudgetStart,
    checkRestartRecovery,
    start,
    annotate,
    activate,
    end,
    run,
    record,
    measure,
    defer,
    finish,
  };
}

export type NativeRunTrace = ReturnType<typeof createNativeRunTrace>;

/** Restart recovery latency: control plane ready to the recovered run's
 * next provider event. The event is filtered on when it was emitted and
 * measured to when it was committed (the baseline's run-log `created_at`). */
export type RestartRecoveryMeasurement = {
  readyAtMs: number | null;
  emittedAtMs: number | null;
  committedAtMs: number;
  disposition: string;
};

/** Group already-normalized provider measurements without exporting provider attributes. */
export async function recordNativeProviderPerformanceSpans(trace: NativeRunTrace, spans: NativeRunHistoricalSpan[]): Promise<void> {
  if (!spans.length) return;
  try {
    const scope = trace.start("provider.runtime", { parentName: "native.session.execute",
      startedAtMs: Math.min(...spans.map(span => span.startedAtMs)), persistRunLog: false });
    try {
      for (const span of spans) await trace.record({ name: span.name, parentName: "provider.runtime",
        startedAtMs: span.startedAtMs, endedAtMs: span.endedAtMs, outcome: span.outcome }, { persistRunLog: false });
    } finally {
      await trace.end(scope, { endedAtMs: Math.max(...spans.map(span => span.endedAtMs)),
        outcome: spans.some(span => span.outcome === "failed") ? "failed" : "ok" });
    }
  } catch { /* Diagnostics cannot replace the work's result. */ }
}

/** One local runner startup sub-step measured by the runner transport. */
export interface NativeRunnerStartupStep {
  name: "runner.runtime.stage" | "runner.process.launch" | "provider.session.load";
  mode: "bootstrap" | "resume";
  startedAtMs: number;
  endedAtMs: number;
  outcome: NativeRunSpanOutcome;
}

/**
 * Record a local runner startup sub-step under `runner.session.startup`.
 * Run log (and Observability when an operator endpoint is set) only, never
 * Telemetry. Detached: the run-log write never delays `turn.start`; the
 * trace settles it at finish.
 */
export function recordNativeRunnerStartupStep(trace: NativeRunTrace | undefined, step: NativeRunnerStartupStep): void {
  trace?.defer(() => trace.record({
    name: step.name,
    parentName: "runner.session.startup",
    startedAtMs: step.startedAtMs,
    endedAtMs: step.endedAtMs,
    outcome: step.outcome,
    attributes: { mode: step.mode, target: "local" },
  }));
}

/** Emit preparation failure even when execution aborts before a native session exists. */
export async function recordFailedSkillPreparation(input: {
  runId: string;
  startedAtMs: number;
  onEvent?: NativeRunTraceSink;
  traceContext?: StartupTraceContextHandle;
}): Promise<void> {
  try {
    const trace = createNativeRunTrace(input);
    const preparation = trace.start("task.prepare", { parentName: "task.provider_session", startedAtMs: input.startedAtMs });
    const endedAtMs = Date.now();
    await trace.record({ name: "skills.prepare", parentName: "task.prepare", startedAtMs: input.startedAtMs, endedAtMs, outcome: "failed" });
    await trace.end(preparation, { endedAtMs, outcome: "failed" });
    await trace.finish("failed");
  } catch {
    // Diagnostics must not replace the original preparation error.
  }
}
