import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { getActiveStepContext, runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { getStartupTraceContext, traceparentFromContextToken, type StartupTraceContextHandle } from "../instrumentation.js";

type Attributes = Record<string, string | number | boolean>;
type Outcome = "ok" | "failed" | "cancelled";
export interface SandboxPerformanceRecord {
  name: string; id: string; parentId?: string; traceId?: string;
  startedAtMs: number; durationMs: number; outcome: Outcome; attributes: Attributes;
  clock?: "remote_relative";
}
interface TraceState {
  tracing: StartupTraceContextHandle; records: SandboxPerformanceRecord[];
  limit: number; dropped: number; runHash: string; startedAtMs: number; closed?: boolean;
  root?: SandboxOperation;
}
interface ScopeState { trace: TraceState; id: string; context: unknown; parent?: ScopeState; ended?: boolean; }
const scopes = new AsyncLocalStorage<ScopeState | undefined>();
function openScope(scope: ScopeState | undefined) {
  while (scope?.ended) scope = scope.parent;
  return scope;
}
const numericKeys = new Set([
  "bytes", "files", "requestCount", "attempt", "retries", "parallelism", "repositoryIndex", "fileIndex", "scopeIndex", "chunkIndex",
  "objects", "entries", "batchIndex", "batches", "operations", "completed", "offset", "limit", "queueDepth", "dropped",
  "executionMs", "transportOverheadMs", "durationMs", "startOffsetMs", "endOffsetMs", "waitMs", "gitListMs", "hashMs", "readMs", "writeMs", "publishMs", "decodeMs", "encodeMs",
  "inputBytes", "outputBytes", "roundtripMs", "hashFiles", "hashBytes", "droppedPhases", "scanMs", "listMs", "recordCount", "operationIndex", "readWaitMs", "bodyNonReadMs", "chunks",
]);
const booleanKeys = new Set(["cold", "warm", "reused", "cacheHit", "exists", "changed", "repository", "bound", "tracked", "ignored", "cancelled", "final", "enabled", "repeated"]);
// String attributes describe operations, never user input. Names and string
// values must also pass a token grammar; callers must use fixed literals.
const stringKeys = new Set(["scope", "phase", "operation", "runtime", "outcome", "mode", "source", "trigger", "clock", "strategy"]);
function safe(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (numericKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (booleanKeys.has(key) && typeof value === "boolean") result[key] = value;
    else if (stringKeys.has(key) && typeof value === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(value)) result[key] = value;
  }
  return result;
}
function safeName(name: string) { return /^[a-z][a-z0-9_.]{0,95}$/.test(name) ? name : "sandbox.invalid_operation"; }
function identity(context: unknown) {
  const value = traceparentFromContextToken(context)?.split("-");
  return value && !/^0+$/.test(value[1]!) && !/^0+$/.test(value[2]!) ? { traceId: value[1], spanId: value[2] } : undefined;
}
function operationParent(scope: ScopeState | undefined) {
  const active = getActiveStepContext()?.parentContext;
  const currentTrace = identity(scope?.context)?.traceId;
  // Reused native sessions can invoke callbacks under a previous run's startup
  // context. Keep its spans out of the current run's accounting. Startup steps
  // in this trace still retain their more specific parent.
  if (currentTrace && identity(active)?.traceId !== currentTrace) return scope?.context;
  return active ?? scope?.context;
}
function record(trace: TraceState, entry: SandboxPerformanceRecord) {
  if (trace.closed) return;
  if (trace.records.length < trace.limit) trace.records.push(entry);
  else trace.dropped++;
}
export interface SandboxOperation {
  set(attributes: Attributes): void;
  end(outcome?: Outcome): void;
  run<T>(work: () => T): T;
  recordRemotePhase(name: string, startOffsetMs: number, durationMs: number, attributes?: Attributes): void;
}
const noop: SandboxOperation = { set() {}, end() {}, run: (work) => work(), recordRemotePhase() {} };

/** Capture at stream creation, not when an unrelated consumer later reads it. */
export function captureSandboxPerformanceContext(): <T>(work: () => T) => T {
  const scope = scopes.getStore();
  const parent = operationParent(scope);
  return (work) => {
    const current = openScope(scope);
    const token = current === scope ? parent : current?.context;
    const within = () => scopes.run(current, () => runWithRuntimeParent(token, work));
    return current?.trace.tracing.withContext ? current.trace.tracing.withContext(token, within) : within();
  };
}
export function hasSandboxPerformanceTrace() { return Boolean(openScope(scopes.getStore()) && !scopes.getStore()?.trace.closed); }
export function setSandboxPerformanceRunAttributes(attributes: Attributes): void {
  scopes.getStore()?.trace.root?.set(attributes);
}

export function startSandboxOperation(name: string, attributes: Attributes = {}): SandboxOperation {
  const current = openScope(scopes.getStore());
  if (!current || current.trace.closed) return noop;
  const trace = current.trace;
  const parentContext = operationParent(current);
  const parentId = identity(parentContext)?.spanId ?? current.id;
  const startedAtMs = Date.now(), started = performance.now();
  const values = safe(attributes);
  let span: ReturnType<StartupTraceContextHandle["tracer"]["startSpan"]> | undefined;
  let context = parentContext;
  name = safeName(name);
  try {
    span = trace.tracing.tracer.startSpan(name, { startTime: startedAtMs, attributes: { "paperclip.sandbox.run_hash": trace.runHash } }, parentContext);
    context = trace.tracing.contextWithSpan(span);
  } catch { /* Diagnostics must never change task behavior. */ }
  const ids = span ? identity(context) : undefined, id = ids?.spanId ?? randomBytes(8).toString("hex");
  const child: ScopeState = { trace, id, context, parent: current };
  let ended = false;
  return {
    set(next) { if (!ended) Object.assign(values, safe(next)); },
    run(work) {
      const within = () => scopes.run(child, () => runWithRuntimeParent(context, work));
      return trace.tracing.withContext ? trace.tracing.withContext(context, within) : within();
    },
    recordRemotePhase(remoteName, startOffsetMs, durationMs, remoteAttributes = {}) {
      if (ended || !Number.isFinite(startOffsetMs) || startOffsetMs < 0 || !Number.isFinite(durationMs) || durationMs < 0) return;
      const attrs = safe({ ...remoteAttributes, clock: "remote_relative", startOffsetMs, durationMs });
      // Remote offsets have no measured host-clock alignment. Preserve them as
      // events on the real command span; never fabricate host timestamps.
      try { (span as typeof span & { addEvent?: (n: string, a: Attributes) => void })?.addEvent?.(safeName(remoteName), attrs); } catch { /* fail open */ }
      record(trace, { name: safeName(remoteName), id: randomBytes(8).toString("hex"), parentId: id, traceId: ids?.traceId,
        startedAtMs: startOffsetMs, durationMs, outcome: "ok", attributes: attrs, clock: "remote_relative" });
    },
    end(outcome = "ok") {
      if (ended) return;
      ended = true;
      child.ended = true;
      const durationMs = Math.max(0, performance.now() - started);
      try {
        for (const [key, value] of Object.entries(values)) span?.setAttribute(`paperclip.sandbox.${key}`, value);
        span?.setAttribute("paperclip.sandbox.outcome", outcome);
        span?.setAttribute("paperclip.sandbox.duration_ms", durationMs);
        if (outcome !== "ok") span?.setStatus({ code: 2 }); // Never export the exception message.
        span?.end(startedAtMs + durationMs);
      } catch { /* fail open */ }
      record(trace, { name, id, parentId, traceId: ids?.traceId, startedAtMs, durationMs, outcome, attributes: values });
    },
  };
}

export async function measureSandboxOperation<T>(name: string, attributes: Attributes, work: (span: SandboxOperation) => Promise<T>): Promise<T> {
  if (!scopes.getStore()) return work(noop);
  const span = startSandboxOperation(name, attributes);
  let outcome: Outcome = "ok";
  try { return await span.run(() => work(span)); }
  catch (error) { outcome = "failed"; throw error; }
  finally { span.end(outcome); }
}

/** Lazy, bounded body consumption. GET response wait is a separate operation. */
export function measureSandboxStream(name: string, attributes: Attributes, source: Readable): Readable {
  if (!hasSandboxPerformanceTrace()) return source;
  const within = captureSandboxPerformanceContext();
  let earlyError: Error | undefined;
  // A prefetched response can fail before anybody starts consuming the wrapper.
  // Keep its error observable without starting the stream or buffering bytes.
  const onSourceError = (error: Error) => { earlyError = error; };
  source.on("error", onSourceError);
  const wrapped = Readable.from((async function* () {
    const span = within(() => startSandboxOperation(name, attributes));
    let bytes = 0, chunks = 0, readWaitMs = 0, complete = false, outcome: Outcome = "cancelled";
    const bodyStarted = performance.now();
    const iterator = source[Symbol.asyncIterator]();
    try {
      if (earlyError) throw earlyError;
      for (;;) {
        const readStarted = performance.now();
        let next: IteratorResult<unknown>;
        try { next = await span.run(() => iterator.next()); }
        finally { readWaitMs += performance.now() - readStarted; }
        if (next.done) { complete = true; outcome = "ok"; break; }
        bytes += Buffer.isBuffer(next.value) ? next.value.length : Buffer.byteLength(String(next.value));
        chunks++;
        yield next.value;
      }
    } catch (error) { outcome = "failed"; throw error; }
    finally {
      try {
        if (!complete) { try { await iterator.return?.(); } finally { source.destroy(); } }
      } finally {
        span.set({ bytes, chunks, readWaitMs, bodyNonReadMs: Math.max(0, performance.now() - bodyStarted - readWaitMs) }); span.end(outcome);
      }
    }
  })());
  wrapped.once("close", () => {
    // Also closes a response whose lazy generator was never entered.
    source.destroy();
    if (source.closed) source.removeListener("error", onSourceError);
    else source.once("close", () => source.removeListener("error", onSourceError));
  });
  const destroy = wrapped.destroy.bind(wrapped);
  wrapped.destroy = (error?: Error) => {
    source.destroy();
    return destroy(error);
  };
  return wrapped;
}

export async function runWithSandboxPerformanceTrace<T>(input: {
  runId: string; enabled?: boolean; traceContext?: StartupTraceContextHandle; maxRecords?: number;
  onBatch?: (batch: { schema: "paperclip.sandbox-performance.v1"; runHash: string; records: SandboxPerformanceRecord[]; dropped: number }) => Promise<void>;
}, work: () => Promise<T>): Promise<T> {
  if (!(input.enabled ?? Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()))) return work();
  const trace: TraceState = { tracing: input.traceContext ?? getStartupTraceContext("paperclip.sandbox"), records: [],
    limit: Number.isFinite(input.maxRecords) ? Math.max(1, Math.min(50_000, Math.floor(input.maxRecords!))) : 20_000, dropped: 0,
    runHash: createHash("sha256").update(input.runId).digest("hex").slice(0, 12), startedAtMs: Date.now() };
  const initial = { trace, id: "", context: getActiveStepContext()?.parentContext };
  try {
    return await scopes.run(initial, () => measureSandboxOperation("sandbox.run", {}, async (span) => {
      trace.root = span;
      try { return await work(); }
      finally {
        span.set({ recordCount: trace.records.length + (trace.records.length < trace.limit ? 1 : 0),
          dropped: trace.dropped + (trace.records.length >= trace.limit ? 1 : 0) });
      }
    }));
  }
  finally {
    trace.closed = true;
    // No per-file DB writes, no synchronous exporter call and no unbounded
    // promise queue. The run-log sanitizer allows fifty array items. Keep each
    // batch within that bound so retained records are not silently truncated.
    // The SDK independently exports ended spans through its batch processor.
    for (let offset = 0; offset < trace.records.length; offset += 50) {
      try { await input.onBatch?.({ schema: "paperclip.sandbox-performance.v1", runHash: trace.runHash,
        records: trace.records.slice(offset, offset + 50), dropped: trace.dropped }); } catch { break; }
    }
  }
}
