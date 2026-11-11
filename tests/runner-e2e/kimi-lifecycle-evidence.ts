import { withoutProvenKimiContext, type KimiContextProof } from "./kimi-context-rendezvous.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import type { ActiveStopCaller } from "./native-active-stop-evidence.js";

type Row = Record<string, any>;
export interface KimiLifecycleScope { companyId: string; issueId: string; runId: string; target: string; actionFile?: string; contextProof?: KimiContextProof }
export interface KimiLifecycleState { run: Row; issue: Row; events: readonly unknown[] }
export interface KimiLifecyclePending {
  schema: "paperclip.e2e.kimi-native-write-pending.v1"; scope: KimiLifecycleScope;
  requestId: string; toolCallId: string; executionId: string; itemId: string; turnId: string;
  normalizedSessionId: string; sourceInstanceId: string; requestSourceSeq: number; startedSourceSeq: number;
  requestRowSha256: string; startedRowSha256: string; observedMonotonicNs: string;
}
const rec = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("[REDACTED]");
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const terminalTypes = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
const closureTypes = new Set(["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"]);
function demand(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Kimi native lifecycle: ${reason}`); }

function origin(events: readonly unknown[], scope: KimiLifecycleScope) {
  events = withoutProvenKimiContext(events, scope.contextProof);
  demand([scope.companyId, scope.issueId, scope.runId, scope.target].every(id) && events.length > 0 && events.length <= 20_000
    && !scope.target.startsWith("/") && !scope.target.split("/").some(part => part === ".." || part === "." || part === ""), "bounded exact scope required");
  const projected = events.map(rec).filter(row => rec(row.payload).prpEvent !== undefined)
    .map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).sort((a, b) => a.row.seq - b.row.seq);
  const seqs = new Set<number>(), sourceIds = new Set<string>(), cursors = new Map<string, number>();
  for (const { row, event: e } of projected) {
    demand(row.companyId === scope.companyId && row.runId === scope.runId && isValidNativePrpEnvelope(e, row.protocolSchemaVersion)
      && e.runId === scope.runId && e.eventType === row.eventType && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq)
      && id(e.sourceInstanceId) && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > (cursors.get(e.sourceInstanceId) ?? 0)
      && e.sourceEventId === `${e.sourceInstanceId}:${e.runId}:${e.sourceSeq}` && !sourceIds.has(e.sourceEventId)
      && (e.sourceKind === "runner" || e.sourceKind === "control_plane" && ["run.result.accepted", "run.terminal"].includes(e.eventType)), "foreign, duplicate or reordered canonical event");
    seqs.add(row.seq); sourceIds.add(e.sourceEventId); cursors.set(e.sourceInstanceId, e.sourceSeq);
  }
  const rows = projected.filter(x => x.event.sourceKind === "runner");
  const created = rows.filter(x => x.event.eventType === "runtime_request.created");
  demand(created.length === 1, "one native Write permission required");
  const card = created[0]!, request = rec(rec(card.event.payload).request);
  if (scope.contextProof) demand(card.row.seq > scope.contextProof.completedSeq && card.event.turnId === scope.contextProof.turnId
    && card.event.normalizedSessionId === scope.contextProof.sessionId && card.event.sourceInstanceId === scope.contextProof.sourceInstanceId,
    "native Write must follow the exact completed scoped context read");
  demand(request.schema === "paperclip.runtime_request.v2" && request.type === "permission" && request.requestKind === "permission_approval" && request.status === "pending"
    && id(request.requestId) && id(request.itemId) && id(request.details?.toolCallId) && request.turnId === card.event.turnId
    && id(card.event.turnId) && id(card.event.normalizedSessionId) && hasAcpxNativeOrigin(request.origin, "kimi", "session/request_permission")
    && request.prompt === `Change file: ${scope.target}` && (request.details.kind === undefined || request.details.kind === "edit")
    && Array.isArray(request.choices) && request.choices.some((choice: Row) => choice.key === "decline")
    && request.choices.some((choice: Row) => choice.key === "accept") && !request.choices.some((choice: Row) => choice.key === "accept_for_session"), "exact native Write permission identity missing");
  const stream = (event: Row) => event.turnId === card.event.turnId && event.normalizedSessionId === card.event.normalizedSessionId && event.sourceInstanceId === card.event.sourceInstanceId;
  demand(rows.filter(x => x.event.turnId != null).every(x => stream(x.event)), "foreign native turn, session or producer");
  const controls = projected.filter(x => x.event.sourceKind === "control_plane"), terminals = rows.filter(x => terminalTypes.has(x.event.eventType));
  demand(controls.length <= 2 && new Set(controls.map(x => x.event.eventType)).size === controls.length
    && controls.every(x => terminals.length === 1 && x.row.seq > terminals[0]!.row.seq
      && x.event.sourceInstanceId === `${card.event.sourceInstanceId}:control`
      && x.event.turnId === card.event.turnId && x.event.normalizedSessionId === card.event.normalizedSessionId), "foreign or premature controller settlement");
  const executionId = bootstrapReadExecutionId(request.details.toolCallId);
  const executions = rows.filter(x => x.event.eventType.startsWith("tool.execution."));
  const write = executions.filter(x => x.event.payload.executionId === executionId);
  const started = write.filter(x => x.event.eventType === "tool.execution.started"), metadataIndex = write.findIndex(x => x.event.payload.name === "Write" && x.event.payload.operation === "edit");
  demand(started.length === 1 && write[0] === started[0] && metadataIndex >= 0 && write.filter(x => x.event.eventType === "tool.execution.completed").length <= 1
    && write.every((x, index) => x.event.payload.schema === "paperclip.tool.execution.v1" && x.event.payload.transport === "builtin"
      && ["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(x.event.eventType)
      && (x.event.payload.name === "Write" || index < metadataIndex && x.event.payload.name === null)
      && (x.event.payload.operation === "edit" || index < metadataIndex && x.event.payload.operation === "unknown")
      && (x.event.payload.target === scope.target || x.event.payload.target === null)
      && x.event.payload.status === (x.event.eventType === "tool.execution.completed" ? "failed" : "running"))
    && !write.some((x, index) => x.event.eventType === "tool.execution.completed" && index !== write.length - 1), "exact native Write lifecycle missing or completed");
  const extra = executions.filter(x => x.event.payload.executionId !== executionId), reads = new Map<string, typeof extra>();
  for (const x of extra) {
    const p = rec(x.event.payload);
    demand(scope.actionFile && /^\.paperclip-eval-action-[a-f0-9]{36}\.txt$/u.test(scope.actionFile)
      && p.schema === "paperclip.tool.execution.v1" && p.transport === "builtin"
      && x.row.seq < Math.min(card.row.seq, started[0]!.row.seq) && id(p.executionId), "extra native or semantic operation");
    const group = reads.get(p.executionId) ?? []; group.push(x); reads.set(p.executionId, group);
  }
  for (const group of reads.values()) {
    const located = group.findIndex(x => x.event.payload.target === scope.actionFile && x.event.payload.name === "Read" && x.event.payload.operation === "read");
    demand(group.length >= 2 && located >= 0 && group[0]!.event.eventType === "tool.execution.started"
      && group.at(-1)!.event.eventType === "tool.execution.completed" && ["completed", "failed"].includes(group.at(-1)!.event.payload.status)
      && group.every((x, index) => (x.event.payload.name === "Read" || index < located && x.event.payload.name === null)
        && (x.event.payload.operation === "read" || index < located && x.event.payload.operation === "unknown")
        && (x.event.payload.target === scope.actionFile || index < located && x.event.payload.target === null))
      && group.slice(0, -1).every((x, index) => x.event.eventType === (index === 0 ? "tool.execution.started" : "tool.execution.progressed") && x.event.payload.status === "running"), "bootstrap Read did not close before Write");
  }
  return { rows, card, request, started: started[0]!, executionId, stream };
}

export function observeKimiLifecyclePending(input: KimiLifecycleState & { scope: KimiLifecycleScope }): KimiLifecyclePending {
  const { scope, run, issue } = input, p = origin(input.events, scope);
  demand(run.id === scope.runId && run.companyId === scope.companyId && run.nativeIssueId === scope.issueId && run.status === "running" && run.runtimeMode === "native"
    && run.nativeSessionId === p.card.event.normalizedSessionId && run.runnerInstanceId === p.card.event.sourceInstanceId
    && issue.id === scope.issueId && issue.companyId === scope.companyId && issue.status === "in_progress"
    && run.resultJson?.startupCancellation == null && run.resultJson?.nativeCancellation == null, "run is not original active native work");
  demand(!p.rows.some(x => terminalTypes.has(x.event.eventType) || closureTypes.has(x.event.eventType)
    || x.event.eventType === "tool.execution.completed" && x.event.payload.executionId === p.executionId), "permission or provider already settled");
  return { schema: "paperclip.e2e.kimi-native-write-pending.v1", scope, requestId: p.request.requestId, toolCallId: p.request.details.toolCallId,
    executionId: p.executionId, itemId: p.request.itemId, turnId: p.card.event.turnId, normalizedSessionId: p.card.event.normalizedSessionId,
    sourceInstanceId: p.card.event.sourceInstanceId, requestSourceSeq: p.card.event.sourceSeq, startedSourceSeq: p.started.event.sourceSeq,
    requestRowSha256: hash(p.card.row), startedRowSha256: hash(p.started.row), observedMonotonicNs: process.hrtime.bigint().toString() };
}
export function assertSameKimiPending(before: KimiLifecyclePending, after: KimiLifecyclePending) {
  demand(canonicalJson({ ...before, observedMonotonicNs: null }) === canonicalJson({ ...after, observedMonotonicNs: null }), "pending callback changed before action");
}
export function readKimiLifecycleSettlement(input: KimiLifecycleState & { pending: KimiLifecyclePending; branch: "stop" | "loss"; dispatchMonotonicNs: string; caller?: ActiveStopCaller; cancellationRequestId?: string }) {
  const b = input.pending, { run, issue } = input, p = origin(input.events, b.scope);
  demand(b.schema === "paperclip.e2e.kimi-native-write-pending.v1" && hash(p.card.row) === b.requestRowSha256 && hash(p.started.row) === b.startedRowSha256
    && p.request.requestId === b.requestId && p.request.details.toolCallId === b.toolCallId && p.executionId === b.executionId && p.request.itemId === b.itemId
    && p.card.event.turnId === b.turnId && p.card.event.normalizedSessionId === b.normalizedSessionId && p.card.event.sourceInstanceId === b.sourceInstanceId
    && p.card.event.sourceSeq === b.requestSourceSeq && p.started.event.sourceSeq === b.startedSourceSeq
    && /^[1-9][0-9]{0,29}$/u.test(b.observedMonotonicNs) && /^[1-9][0-9]{0,29}$/u.test(input.dispatchMonotonicNs)
    && BigInt(b.observedMonotonicNs) < BigInt(input.dispatchMonotonicNs), "original pre-action pending receipt changed or missing");
  const closed = p.rows.filter(x => closureTypes.has(x.event.eventType)), terminal = p.rows.filter(x => terminalTypes.has(x.event.eventType));
  demand(closed.length === 1 && terminal.length === 1, "one callback closure and one provider terminal required");
  const c = closed[0]!, t = terminal[0]!, cp = rec(c.event.payload), tp = rec(t.event.payload);
  demand(p.stream(c.event) && p.stream(t.event) && cp.requestId === b.requestId && cp.turnId === b.turnId && cp.itemId === b.itemId
    && cp.requestKind === "permission_approval" && cp.action === undefined && cp.response === undefined && cp.replayAllowed !== true
    && c.event.sourceSeq > Math.max(b.requestSourceSeq, b.startedSourceSeq) && t.event.sourceSeq > c.event.sourceSeq
    && p.rows.filter(x => x.event.eventType.startsWith("tool.execution.")).every(x => x.event.sourceSeq < t.event.sourceSeq)
    && !p.rows.some(x => ["completion.accepted", "task.completed", "run.result.proposed"].includes(x.event.eventType)), "callback accepted, replayed, or outlived its provider");
  demand(run.id === b.scope.runId && run.companyId === b.scope.companyId && run.nativeIssueId === b.scope.issueId && run.runtimeMode === "native"
    && run.nativeSessionId === b.normalizedSessionId && run.runnerInstanceId === b.sourceInstanceId && issue.id === b.scope.issueId && issue.companyId === b.scope.companyId, "run ownership or generation changed");
  if (input.branch === "stop") {
    const caller = input.caller, stop = rec(run.resultJson?.nativeCancellation), startup = rec(run.resultJson?.startupCancellation);
    demand(caller?.type === "board" && caller.userId === "local-board" && caller.source === "local_implicit"
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.cancellationRequestId ?? "")
      && c.event.eventType === "runtime_request.cancelled" && cp.reason === "turn_terminal"
      && t.event.eventType === "turn.cancelled" && tp.status === "cancelled" && tp.error === null && run.status === "cancelled" && issue.status === "in_progress"
      && startup.requestedBy?.type === caller.type && startup.requestedBy?.userId === caller.userId && startup.cancellationRequestId === input.cancellationRequestId
      && stop.schema === "paperclip.native-cancellation.v1" && stop.intentId === `native-cancellation:${input.cancellationRequestId}` && stop.companyId === b.scope.companyId && stop.runId === run.id && stop.issueId === issue.id
      && stop.scope === "run" && stop.dispatched === true && stop.dispatchState === "acknowledged" && stop.reasonCode === "cancellation_run_only"
      && Array.isArray(stop.effects) && stop.effects.length === 1 && stop.effects[0] === "release_run_resources"
      && id(stop.intentAuditId) && id(stop.acknowledgementAuditId) && stop.intentAuditId !== stop.acknowledgementAuditId, "caller-owned Stop acknowledgement missing");
  } else demand(c.event.eventType === "runtime_request.expired" && cp.reason === "provider_process_lost" && cp.requestType === "permission" && cp.replayAllowed === false
    && cp.request === undefined && t.event.eventType === "turn.failed" && run.status === "failed" && issue.status === "blocked"
    && run.resultJson?.nativeCancellation == null && run.resultJson?.startupCancellation == null, "spontaneous native-worker loss did not expire the original callback");
  return { schema: "paperclip.e2e.kimi-native-write-settlement.v1", branch: input.branch, pending: b,
    requestClosure: c.event.eventType, closedRowSha256: hash(c.row), terminalRowSha256: hash(t.row), replayAllowed: false, completedMutation: false };
}
