import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";

const EXECUTION_CAUSAL_TRACE_VERSION = 1 as const;
const MAX_EXECUTION_CAUSAL_TRACE_ENTRIES = 16;
const MAX_CAUSAL_MESSAGE_CHARS = 240;
const EXECUTION_CAUSAL_EVENT_TYPES = {
  wake: "causal.wake",
  recoveryContext: "causal.recovery_context",
  toolSpan: "causal.tool_span",
  handoff: "causal.handoff",
  guardrail: "causal.guardrail",
} as const;

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

export type ExecutionCausalRunEventType =
  | typeof EXECUTION_CAUSAL_EVENT_TYPES.wake
  | typeof EXECUTION_CAUSAL_EVENT_TYPES.recoveryContext
  | typeof EXECUTION_CAUSAL_EVENT_TYPES.toolSpan
  | typeof EXECUTION_CAUSAL_EVENT_TYPES.handoff
  | typeof EXECUTION_CAUSAL_EVENT_TYPES.guardrail;

export type ExecutionCausalRunEventInput = {
  companyId: string;
  runId: string;
  agentId: string;
  eventType: ExecutionCausalRunEventType;
  message: string;
  level?: "info" | "warn" | "error";
  payload?: Record<string, unknown> | null;
};

type ExecutionCausalTraceEntryInput = Omit<ExecutionCausalTraceEntry, "version" | "recordedAt"> & {
  recordedAt?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncateMessage(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_CAUSAL_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_CAUSAL_MESSAGE_CHARS - 3)}...`;
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

export function executionCausalEventType(kind: keyof typeof EXECUTION_CAUSAL_EVENT_TYPES) {
  return EXECUTION_CAUSAL_EVENT_TYPES[kind];
}

export function buildExecutionCausalWakePayload(contextSnapshot: Record<string, unknown>) {
  const trace = readExecutionCausalTrace(contextSnapshot[EXECUTION_CAUSAL_TRACE_KEY]);
  const latest = trace[trace.length - 1] ?? null;
  return {
    traceVersion: EXECUTION_CAUSAL_TRACE_VERSION,
    wakeReason: readNonEmptyString(contextSnapshot.wakeReason),
    retryReason: readNonEmptyString(contextSnapshot.retryReason),
    wakeSource: readNonEmptyString(contextSnapshot.wakeSource),
    wakeTriggerDetail: readNonEmptyString(contextSnapshot.wakeTriggerDetail),
    issueId: readNonEmptyString(contextSnapshot.issueId),
    taskId: readNonEmptyString(contextSnapshot.taskId),
    retryOfRunId: readNonEmptyString(contextSnapshot.retryOfRunId),
    recoveryActionId: readNonEmptyString(contextSnapshot.recoveryActionId),
    sourceIssueId: readNonEmptyString(contextSnapshot.sourceIssueId),
    sourceRunId: readNonEmptyString(contextSnapshot.sourceRunId),
    latestTraceEntry: latest,
  };
}

export function buildExecutionRecoveryContextPayload(contextSnapshot: Record<string, unknown>) {
  const trace = readExecutionCausalTrace(contextSnapshot[EXECUTION_CAUSAL_TRACE_KEY]);
  const carriedKeys = Object.keys(contextSnapshot).filter((key) =>
    [
      "issueId",
      "taskId",
      "wakeReason",
      "retryReason",
      "retryOfRunId",
      "recoveryActionId",
      "source",
      "sourceIssueId",
      "sourceRunId",
      "originKind",
      "originId",
      "scheduledRetryAttempt",
      "scheduledRetryAt",
      "providerQuotaRetryNotBefore",
      "interactionId",
      "interactionKind",
      "continuationPolicy",
      "handoffRequired",
      "handoffReason",
      "handoffAttempt",
      "workspaceValidationRecovery",
      "paperclipSessionHandoffMarkdown",
    ].includes(key)
  );
  return {
    traceVersion: EXECUTION_CAUSAL_TRACE_VERSION,
    issueId: readNonEmptyString(contextSnapshot.issueId),
    taskId: readNonEmptyString(contextSnapshot.taskId),
    retryOfRunId: readNonEmptyString(contextSnapshot.retryOfRunId),
    recoveryActionId: readNonEmptyString(contextSnapshot.recoveryActionId),
    carriedContextKeys: carriedKeys,
    priorTraceCount: trace.length,
    handoffRequired: contextSnapshot.handoffRequired === true,
    handoffReason: readNonEmptyString(contextSnapshot.handoffReason),
    handoffAttempt: typeof contextSnapshot.handoffAttempt === "number" ? contextSnapshot.handoffAttempt : null,
  };
}

export function buildExecutionToolSpanPayload(input: {
  invocationId?: string | null;
  actionRequestId?: string | null;
  toolName: string;
  phase: "start" | "end";
  resultClass: "started" | "succeeded" | "failed" | "denied" | "approval_requested" | "approval_resolved";
  errorClass?: string | null;
  outcome?: string | null;
  reasonCode?: string | null;
}) {
  return {
    traceVersion: EXECUTION_CAUSAL_TRACE_VERSION,
    invocationId: input.invocationId ?? null,
    actionRequestId: input.actionRequestId ?? null,
    toolName: input.toolName,
    phase: input.phase,
    resultClass: input.resultClass,
    errorClass: input.errorClass ?? null,
    outcome: input.outcome ?? null,
    reasonCode: input.reasonCode ?? null,
  };
}

export async function appendExecutionCausalRunEvent(
  db: Db,
  input: ExecutionCausalRunEventInput,
) {
  const [row] = await db
    .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, input.runId));
  const seq = Number(row?.maxSeq ?? 0) + 1;
  await db.insert(heartbeatRunEvents).values({
    companyId: input.companyId,
    runId: input.runId,
    agentId: input.agentId,
    seq,
    eventType: input.eventType,
    stream: "system",
    level: input.level ?? "info",
    message: truncateMessage(input.message),
    payload: input.payload ?? null,
  });
  return seq;
}

export async function appendExecutionCausalRunEventForExistingRun(
  db: Db,
  input: Omit<ExecutionCausalRunEventInput, "companyId" | "agentId">,
) {
  const run = await db
    .select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  return appendExecutionCausalRunEvent(db, {
    ...input,
    companyId: run.companyId,
    agentId: run.agentId,
  });
}
