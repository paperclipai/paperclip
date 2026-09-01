import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import {
  getStartupTraceContext,
  type StartupTraceContextHandle,
} from "../../instrumentation.js";

export const NATIVE_RUN_SPAN_EVENT_TYPE = "run.performance.span";
export const NATIVE_RUN_TRACE_SCHEMA_VERSION = 2;

export type NativeRunSpanOutcome = "ok" | "failed";

export interface NativeRunHistoricalSpan {
  name: string;
  parentName?: string;
  startedAtMs: number;
  endedAtMs: number;
  outcome?: NativeRunSpanOutcome;
  attributes?: Record<string, string | number | boolean>;
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
}

const NOOP_SPAN: SpanHandle = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const SAFE_NATIVE_RUN_SPAN_ATTRIBUTE_KEYS = new Set([
  "adapter",
  "bytesTransferred",
  "connectionOwner",
  "driver",
  "duration_ms",
  "eventKind",
  "harness",
  "identityPresent",
  "lifecycleMode",
  "mode",
  "outcome",
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
}) {
  const tracing =
    input.traceContext ?? getStartupTraceContext("paperclip.native-runner");
  const traceStartedAtMs = finiteMs(input.startedAtMs ?? Date.now());
  const runIdHash = hashedId(input.runId);
  let rootSpan: SpanHandle;
  try {
    rootSpan = tracing.tracer.startSpan("task.run", {
      startTime: traceStartedAtMs,
      attributes: {
        "paperclip.task.run.run_id": runIdHash,
        "paperclip.task.run.runtime": "paperclip_runner",
        "paperclip.task.run.trace_schema_version":
          NATIVE_RUN_TRACE_SCHEMA_VERSION,
      },
    });
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
        : { name: "task.run", context: rootContext };
  };

  const parentFor = (
    parentName?: string,
  ): { name: string; context: unknown } => {
    if (parentName && parentName !== "task.run") {
      const named = namedScopes.get(parentName);
      if (named) return { name: named.name, context: named.context };
      return currentParent();
    }
    if (parentName === "task.run")
      return { name: "task.run", context: rootContext };
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
          parentSpan: span.parentName ?? "task.run",
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
        parent.context,
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
    try {
      if (outcome === "failed") state.span.setStatus({ code: 2 });
      state.span.end(endedAtMs);
    } catch {
      // Tracing is diagnostic-only and must never change runner control flow.
    }
    await emitCompletedSpanEvent({
      name: state.name,
      parentName: state.parentName,
      startedAtMs: state.startedAtMs,
      endedAtMs,
      outcome,
      attributes: state.attributes,
    });
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

  const record = async (span: NativeRunHistoricalSpan): Promise<void> => {
    const scope = start(span.name, {
      parentName: span.parentName,
      startedAtMs: span.startedAtMs,
      attributes: span.attributes,
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

  const finish = async (outcome: NativeRunSpanOutcome): Promise<void> => {
    if (ended) return;
    ended = true;
    const endedAtMs = Date.now();
    for (const scope of [...openScopes].reverse()) {
      await end(scope, { endedAtMs, outcome });
    }
    try {
      rootSpan.setAttribute(
        "paperclip.task.run.wall_ms",
        endedAtMs - traceStartedAtMs,
      );
      rootSpan.setAttribute("paperclip.task.run.outcome", outcome);
      if (outcome === "failed") rootSpan.setStatus({ code: 2 });
      rootSpan.end(endedAtMs);
    } catch {
      // Tracing is diagnostic-only and must never change runner control flow.
    }
    // Preserve the historical run-log record without emitting a duplicate
    // full-width child span into the OpenTelemetry waterfall.
    await emitCompletedSpanEvent({
      name: "task.run.measured",
      parentName: "task.run",
      startedAtMs: traceStartedAtMs,
      endedAtMs,
      outcome,
      attributes: { runtime: "paperclip_runner" },
    });
  };

  return {
    traceStartedAtMs,
    start,
    annotate,
    activate,
    end,
    run,
    record,
    measure,
    finish,
  };
}

export type NativeRunTrace = ReturnType<typeof createNativeRunTrace>;
