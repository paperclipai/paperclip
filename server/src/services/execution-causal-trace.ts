const EXECUTION_CAUSAL_TRACE_VERSION = 1 as const;
const MAX_EXECUTION_CAUSAL_TRACE_ENTRIES = 16;

export const EXECUTION_CAUSAL_TRACE_KEY = "executionCausalTrace";

export type ExecutionCausalTraceKind = "wake" | "retry" | "recovery";

export interface ExecutionCausalTraceEntry {
  version: typeof EXECUTION_CAUSAL_TRACE_VERSION;
  kind: ExecutionCausalTraceKind;
  recordedAt: string;
  reason: string | null;
  source: string | null;
  triggerDetail: string | null;
  issueId: string | null;
  taskId: string | null;
  runId: string | null;
  retryOfRunId: string | null;
  recoveryActionId: string | null;
  originKind: string | null;
  originId: string | null;
}

type ExecutionCausalTraceEntryInput = Omit<ExecutionCausalTraceEntry, "version" | "recordedAt"> & {
  recordedAt?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeEntry(value: unknown): ExecutionCausalTraceEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const recordedAt = readNonEmptyString(record.recordedAt);
  const kind = readNonEmptyString(record.kind);
  if (!recordedAt || (kind !== "wake" && kind !== "retry" && kind !== "recovery")) return null;
  return {
    version: EXECUTION_CAUSAL_TRACE_VERSION,
    kind,
    recordedAt,
    reason: readNonEmptyString(record.reason),
    source: readNonEmptyString(record.source),
    triggerDetail: readNonEmptyString(record.triggerDetail),
    issueId: readNonEmptyString(record.issueId),
    taskId: readNonEmptyString(record.taskId),
    runId: readNonEmptyString(record.runId),
    retryOfRunId: readNonEmptyString(record.retryOfRunId),
    recoveryActionId: readNonEmptyString(record.recoveryActionId),
    originKind: readNonEmptyString(record.originKind),
    originId: readNonEmptyString(record.originId),
  };
}

function sameEntry(a: ExecutionCausalTraceEntry | null | undefined, b: ExecutionCausalTraceEntry) {
  return Boolean(a) &&
    a.kind === b.kind &&
    a.reason === b.reason &&
    a.source === b.source &&
    a.triggerDetail === b.triggerDetail &&
    a.issueId === b.issueId &&
    a.taskId === b.taskId &&
    a.runId === b.runId &&
    a.retryOfRunId === b.retryOfRunId &&
    a.recoveryActionId === b.recoveryActionId &&
    a.originKind === b.originKind &&
    a.originId === b.originId;
}

export function readExecutionCausalTrace(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is ExecutionCausalTraceEntry => entry !== null);
}

export function appendExecutionCausalTrace(
  target: Record<string, unknown>,
  entry: ExecutionCausalTraceEntryInput,
) {
  const nextEntry: ExecutionCausalTraceEntry = {
    version: EXECUTION_CAUSAL_TRACE_VERSION,
    kind: entry.kind,
    recordedAt: entry.recordedAt ?? new Date().toISOString(),
    reason: entry.reason ?? null,
    source: entry.source ?? null,
    triggerDetail: entry.triggerDetail ?? null,
    issueId: entry.issueId ?? null,
    taskId: entry.taskId ?? null,
    runId: entry.runId ?? null,
    retryOfRunId: entry.retryOfRunId ?? null,
    recoveryActionId: entry.recoveryActionId ?? null,
    originKind: entry.originKind ?? null,
    originId: entry.originId ?? null,
  };
  const trace = readExecutionCausalTrace(target[EXECUTION_CAUSAL_TRACE_KEY]);
  if (!sameEntry(trace[trace.length - 1], nextEntry)) trace.push(nextEntry);
  target[EXECUTION_CAUSAL_TRACE_KEY] = trace.slice(-MAX_EXECUTION_CAUSAL_TRACE_ENTRIES);
  return target;
}

export function inferExecutionCausalTraceKind(input: {
  reason?: string | null;
  retryOfRunId?: string | null;
  recoveryActionId?: string | null;
  originKind?: string | null;
}) {
  if (input.recoveryActionId || input.originKind?.includes("recovery") || input.reason?.includes("recovery")) {
    return "recovery" as const;
  }
  if (input.retryOfRunId || input.reason?.includes("retry")) return "retry" as const;
  return "wake" as const;
}
