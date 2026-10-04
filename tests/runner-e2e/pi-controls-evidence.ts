import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import type { ActiveStopCaller } from "./native-active-stop-evidence.js";

type Row = Record<string, any>;
export interface PiControlScope { companyId: string; issueId: string; runId: string; target: string }
export interface PiControlState { run: Row; issue: Row; events: readonly unknown[] }
export interface PiControlPending {
  schema: "paperclip.e2e.pi-control-pending.v1"; scope: PiControlScope; requestId: string; toolCallId: string; executionId: string;
  turnId: string; normalizedSessionId: string; sourceInstanceId: string; itemId: string;
  requestSourceSeq: number; startedSourceSeq: number; requestRowSha256: string; startedRowSha256: string; observedMonotonicNs: string;
}
const rec = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const hash = (v: unknown) => `sha256:${createHash("sha256").update(canonicalJson(v)).digest("hex")}`;
function requireProof(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Pi controls: ${reason}`); }
const terminalTypes = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
const closureTypes = new Set(["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"]);
const controlSettlementTypes = new Set(["run.result.accepted", "run.terminal"]);

/** Consume the actual Product projection. Pi does not emit Cursor/Copilot native
 * diagnostic notices; never manufacture those to reuse another provider's oracle. */
function origin(events: readonly unknown[], scope: PiControlScope) {
  requireProof(Object.values(scope).every(id) && events.length > 0 && events.length <= 20_000, "bounded exact scope required");
  const projected = events.map(rec).filter(row => rec(row.payload).prpEvent !== undefined).map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).sort((a, b) => a.row.seq - b.row.seq);
  const seqs = new Set<number>(), sourceIds = new Set<string>(), last = new Map<string, number>();
  for (const { row, event: e } of projected) {
    requireProof(row.companyId === scope.companyId && row.runId === scope.runId && isValidNativePrpEnvelope(e, row.protocolSchemaVersion)
      && (e.sourceKind === "runner" || (e.sourceKind === "control_plane" && controlSettlementTypes.has(e.eventType)))
      && e.runId === scope.runId && e.eventType === row.eventType && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq)
      && id(e.sourceInstanceId) && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > (last.get(e.sourceInstanceId) ?? 0)
      && e.sourceEventId === `${e.sourceInstanceId}:${e.runId}:${e.sourceSeq}` && !sourceIds.has(e.sourceEventId), "foreign, duplicate or reordered event");
    seqs.add(row.seq); sourceIds.add(e.sourceEventId); last.set(e.sourceInstanceId, e.sourceSeq);
  }
  const rows = projected.filter(x => x.event.sourceKind === "runner");
  const control = projected.filter(x => x.event.sourceKind === "control_plane");
  const created = rows.filter(x => x.event.eventType === "runtime_request.created");
  requireProof(created.length === 1, "one native permission required");
  const card = created[0]!, request = rec(rec(card.event.payload).request);
  requireProof(request.schema === "paperclip.runtime_request.v2" && request.type === "permission" && request.requestKind === "permission_approval" && request.status === "pending"
    && id(request.requestId) && id(request.itemId) && id(request.details?.toolCallId) && request.turnId === card.event.turnId && id(card.event.turnId)
    && id(card.event.normalizedSessionId) && hasAcpxNativeOrigin(request.origin, "pi", "session/request_permission")
    && Array.isArray(request.choices) && request.choices.some((c: Row) => c.key === "decline"), "native permission identity missing");
  const stream = (event: Row) => event.turnId === card.event.turnId && event.normalizedSessionId === card.event.normalizedSessionId && event.sourceInstanceId === card.event.sourceInstanceId;
  requireProof(rows.filter(x => x.event.turnId != null).every(x => stream(x.event)), "foreign turn, session or producer");
  // Product settlement adds a separate control-plane producer after the runner
  // terminal. Validate those records without using them as native tool proof.
  const terminals = rows.filter(x => terminalTypes.has(x.event.eventType));
  requireProof(control.length <= 2 && new Set(control.map(x => x.event.eventType)).size === control.length
    && control.every(x => terminals.length === 1 && x.row.seq > terminals[0]!.row.seq
      && x.event.sourceInstanceId === `${card.event.sourceInstanceId}:control`
      && x.event.turnId === card.event.turnId && x.event.normalizedSessionId === card.event.normalizedSessionId
      && (x.event.eventType === "run.result.accepted"
        ? rec(rec(x.event.payload).result).schema === "paperclip.run_result.v1"
        : rec(x.event.payload).schema === "paperclip.prp.terminal.v1"))
    && (control.length !== 2 || (control[0]!.event.eventType === "run.result.accepted" && control[1]!.event.eventType === "run.terminal")),
  "foreign, duplicate or premature control-plane settlement");
  const executionId = bootstrapReadExecutionId(request.details.toolCallId);
  const native = rows.filter(x => x.event.eventType.startsWith("tool.execution.") && rec(x.event.payload).transport === "builtin");
  const write = native.filter(x => rec(x.event.payload).executionId === executionId);
  const started = write.filter(x => x.event.eventType === "tool.execution.started");
  // Pi streams native tool arguments. The start and early progress rows can
  // have no path yet; the pending permission is admissible only after this
  // same execution provides the exact target. Conflicting paths and loss of a
  // previously known path still fail, including after denial or cancellation.
  const targetIndex = write.findIndex(x => x.event.payload.target === scope.target);
  requireProof(started.length === 1 && write.filter(x => x.event.eventType === "tool.execution.completed").length <= 1
    && write[0] === started[0] && targetIndex >= 0
    && write.every((x, index) => ["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(x.event.eventType)
      && x.event.payload.schema === "paperclip.tool.execution.v1" && x.event.payload.name === "write" && x.event.payload.operation === "edit"
      && (x.event.payload.target === scope.target || (index < targetIndex && x.event.payload.target === null && x.event.eventType !== "tool.execution.completed"))
      && x.event.payload.status === (x.event.eventType === "tool.execution.completed" ? "failed" : "running")), "exact native write lifecycle missing");
  requireProof(!write.some((x, index) => x.event.eventType === "tool.execution.completed" && index !== write.length - 1), "write activity after terminal");
  // Read-only orientation/bootstrap can precede the write. Never exempt another
  // edit, shell execution, or unknown native operation as an alleged bootstrap.
  requireProof(native.every(x => rec(x.event.payload).executionId === executionId || (x.event.payload.operation === "read" && x.row.seq < Math.min(card.row.seq, started[0]!.row.seq))), "extra native operation");
  return { rows, control, card, request, started: started[0]!, executionId, stream };
}
export function observePiControlPending(input: PiControlState & { scope: PiControlScope }): PiControlPending {
  const { run, issue, scope } = input, p = origin(input.events, scope);
  requireProof(run.id === scope.runId && run.companyId === scope.companyId && run.nativeIssueId === scope.issueId && run.status === "running" && run.runtimeMode === "native"
    && issue.id === scope.issueId && issue.companyId === scope.companyId && issue.status === "in_progress"
    && run.resultJson?.startupCancellation == null && run.resultJson?.nativeCancellation == null, "run is not fresh active work");
  requireProof(!p.rows.some(x => terminalTypes.has(x.event.eventType) || closureTypes.has(x.event.eventType)
    || (x.event.eventType === "tool.execution.completed" && x.event.payload.executionId === p.executionId)), "permission already answered or provider settled");
  return { schema: "paperclip.e2e.pi-control-pending.v1", scope, requestId: p.request.requestId, toolCallId: p.request.details.toolCallId, executionId: p.executionId,
    turnId: p.card.event.turnId, normalizedSessionId: p.card.event.normalizedSessionId, sourceInstanceId: p.card.event.sourceInstanceId, itemId: p.request.itemId,
    requestSourceSeq: p.card.event.sourceSeq, startedSourceSeq: p.started.event.sourceSeq, requestRowSha256: hash(p.card.row), startedRowSha256: hash(p.started.row), observedMonotonicNs: process.hrtime.bigint().toString() };
}
function retained(input: PiControlState & { pending: PiControlPending }) {
  const b = input.pending;
  requireProof(b.schema === "paperclip.e2e.pi-control-pending.v1", "pending receipt missing");
  const p = origin(input.events, b.scope);
  requireProof(hash(p.card.row) === b.requestRowSha256 && hash(p.started.row) === b.startedRowSha256 && p.card.event.sourceSeq === b.requestSourceSeq && p.started.event.sourceSeq === b.startedSourceSeq
    && p.request.requestId === b.requestId && p.request.details.toolCallId === b.toolCallId && p.executionId === b.executionId && p.request.itemId === b.itemId
    && p.card.event.turnId === b.turnId && p.card.event.normalizedSessionId === b.normalizedSessionId && p.card.event.sourceInstanceId === b.sourceInstanceId, "retained pending identity changed");
  return p;
}
export function assertSamePiPending(before: PiControlPending, after: PiControlPending) {
  requireProof(canonicalJson({ ...before, observedMonotonicNs: null }) === canonicalJson({ ...after, observedMonotonicNs: null }), "pending boundary changed before dispatch");
}
export function readPiStopSettlement(input: PiControlState & { pending: PiControlPending; caller: ActiveStopCaller; cancellationRequestId: string; dispatchMonotonicNs: string }) {
  const b = input.pending, p = retained(input), { run, issue, caller } = input;
  requireProof(/^[1-9][0-9]{0,29}$/u.test(b.observedMonotonicNs) && /^[1-9][0-9]{0,29}$/u.test(input.dispatchMonotonicNs)
    && BigInt(b.observedMonotonicNs) < BigInt(input.dispatchMonotonicNs) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.cancellationRequestId)
    && caller.type === "board" && caller.userId === "local-board" && caller.source === "local_implicit", "pre-dispatch caller proof missing");
  const closed = p.rows.filter(x => closureTypes.has(x.event.eventType)), terminal = p.rows.filter(x => terminalTypes.has(x.event.eventType));
  requireProof(closed.length === 1 && terminal.length === 1, "one cancellation closure and terminal required");
  const c = closed[0]!, t = terminal[0]!, cp = rec(c.event.payload), tp = rec(t.event.payload);
  requireProof(c.event.eventType === "runtime_request.cancelled" && cp.requestId === b.requestId && cp.turnId === b.turnId && cp.itemId === b.itemId && cp.requestKind === "permission_approval"
    && cp.reason === "turn_terminal" && cp.action === undefined && cp.response === undefined && cp.replayAllowed !== true
    && t.event.eventType === "turn.cancelled" && tp.status === "cancelled" && tp.error === null && c.event.sourceSeq > Math.max(b.requestSourceSeq, b.startedSourceSeq) && t.event.sourceSeq > c.event.sourceSeq
    && p.rows.filter(x => x.event.eventType.startsWith("tool.execution.")).every(x => x.event.sourceSeq < t.event.sourceSeq), "unanswered callback did not close through cancellation");
  const stop = rec(run.resultJson?.nativeCancellation), startup = rec(run.resultJson?.startupCancellation);
  requireProof(run.id === b.scope.runId && run.companyId === b.scope.companyId && run.nativeIssueId === b.scope.issueId && run.status === "cancelled" && run.runtimeMode === "native"
    && issue.id === b.scope.issueId && issue.companyId === b.scope.companyId && issue.status === "in_progress"
    && startup.requestedBy?.type === caller.type && startup.requestedBy?.userId === caller.userId && startup.cancellationRequestId === input.cancellationRequestId
    && stop.schema === "paperclip.native-cancellation.v1" && stop.intentId === `native-cancellation:${input.cancellationRequestId}` && stop.companyId === b.scope.companyId && stop.runId === run.id && stop.issueId === issue.id
    && stop.scope === "run" && stop.dispatched === true && stop.dispatchState === "acknowledged" && stop.reasonCode === "cancellation_run_only"
    && Array.isArray(stop.effects) && stop.effects.length === 1 && stop.effects[0] === "release_run_resources" && id(stop.intentAuditId) && id(stop.acknowledgementAuditId) && stop.intentAuditId !== stop.acknowledgementAuditId, "same-scope caller Stop acknowledgement missing");
  return { schema: "paperclip.e2e.pi-stop-settlement.v1", pending: b, cancellationRequestId: input.cancellationRequestId, dispatchMonotonicNs: input.dispatchMonotonicNs,
    closedRowSha256: hash(c.row), terminalRowSha256: hash(t.row), intentId: stop.intentId, intentAuditId: stop.intentAuditId, acknowledgementAuditId: stop.acknowledgementAuditId, normalCompletionAccepted: false };
}
export function readPiSteeringAcknowledgement(input: PiControlState & { pending: PiControlPending; commentId: string; queueId: string }) {
  const p = retained(input), b = input.pending, saved = rec(input.run.resultJson?.queuedSteeringAcknowledgements?.[input.commentId]);
  const receipts = p.rows.filter(x => x.event.eventType === "item.completed" && x.event.payload?.kind === "steering_acknowledgement");
  // Rust's raw acpx-control hash is a transport echo. The Product facade
  // suppresses it (codex-session-notifications.ts) and CodexHarnessSession.steer
  // emits this correlation-bound item only after request() is acknowledged.
  requireProof(input.run.id === b.scope.runId && input.run.companyId === b.scope.companyId && input.run.nativeIssueId === b.scope.issueId && input.run.runtimeMode === "native"
    && id(input.commentId) && id(input.queueId) && saved.status === "acknowledged" && saved.queueId === input.queueId && saved.turnId === b.turnId && Number.isFinite(Date.parse(saved.acknowledgedAt))
    && receipts.length === 1 && receipts[0]!.event.itemId === `${b.turnId}:steer:${input.commentId}` && receipts[0]!.event.payload.status === "acknowledged"
    && receipts[0]!.event.payload.mode === "steer" && receipts[0]!.event.sourceSeq > Math.max(b.requestSourceSeq, b.startedSourceSeq), "same-turn steering acknowledgement missing");
  return { schema: "paperclip.e2e.pi-steering-ack.v1", commentId: input.commentId, queueId: input.queueId, turnId: b.turnId, sourceSeq: receipts[0]!.event.sourceSeq, rowSha256: hash(receipts[0]!.row) };
}
export function readPiSteeringSettlement(input: PiControlState & { pending: PiControlPending; commentId: string; queueId: string; marker: string; finalMessage: string }) {
  const ack = readPiSteeringAcknowledgement(input), p = retained(input), b = input.pending;
  const accepted = rec(rec(p.control[0]?.event.payload).result), terminalResult = rec(p.control[1]?.event.payload);
  requireProof(p.control.length === 2 && p.control[0]!.event.eventType === "run.result.accepted" && p.control[1]!.event.eventType === "run.terminal"
    && accepted.reportedWorkDisposition === "done" && accepted.summary === input.marker
    && terminalResult.runTerminalState === "succeeded" && terminalResult.turnTerminalState === "completed" && terminalResult.reportedWorkDisposition === "done",
  "complete matching control-plane settlement required");
  const closed = p.rows.filter(x => closureTypes.has(x.event.eventType)), terminal = p.rows.filter(x => terminalTypes.has(x.event.eventType));
  const failed = p.rows.filter(x => x.event.eventType === "tool.execution.completed" && x.event.payload.executionId === b.executionId);
  requireProof(closed.length === 1 && closed[0]!.event.eventType === "runtime_request.resolved" && closed[0]!.event.payload.requestId === b.requestId && closed[0]!.event.payload.turnId === b.turnId
    && closed[0]!.event.payload.action === "decline" && closed[0]!.event.sourceSeq > ack.sourceSeq
    && failed.length === 1 && failed[0]!.event.sourceSeq > closed[0]!.event.sourceSeq && typeof failed[0]!.event.payload.output === "string" && failed[0]!.event.payload.output.includes("Pi operation was denied or cancelled")
    && terminal.length === 1 && terminal[0]!.event.eventType === "turn.completed" && terminal[0]!.event.sourceSeq > failed[0]!.event.sourceSeq
    && input.run.id === b.scope.runId && input.run.companyId === b.scope.companyId && input.run.nativeIssueId === b.scope.issueId && input.run.runtimeMode === "native" && input.run.status === "succeeded"
    && input.issue.id === b.scope.issueId && input.issue.companyId === b.scope.companyId && input.issue.status === "done"
    && input.run.resultJson?.nativeCancellation == null && input.run.resultJson?.startupCancellation == null
    && /^PI-STEER-[a-f0-9]{32}$/u.test(input.marker) && input.finalMessage === input.marker, "steering was not consumed in the original denied-write turn");
  return { schema: "paperclip.e2e.pi-steering-settlement.v1", pending: b, acknowledgement: ack, marker: input.marker, terminalRowSha256: hash(terminal[0]!.row), nativeFollowUpTested: false };
}
