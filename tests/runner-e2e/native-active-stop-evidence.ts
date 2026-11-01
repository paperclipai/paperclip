import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { assertCopilotRemoteRetirement, copilotRemoteDeniedSample, type CopilotRemoteSnapshot } from "./copilot-protection-evidence.js";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { readCursorToolEvidence } from "./cursor-native-evidence.js";
import { bootstrapReadExecutionId, withoutProvenBootstrapReads, type BootstrapReadProof } from "./native-bootstrap-read-proof.js";

type Row = Record<string, any>;
export interface ActiveStopCaller { type: "board"; userId: "local-board"; source: "local_implicit" }
export type ActiveStopProvider = "cursor" | "copilot";
export interface ActiveStopScope { provider: ActiveStopProvider; companyId: string; issueId: string; runId: string; target: string; commandSha256?: string }
export interface ActiveStopPending {
  schema: "paperclip.e2e.native-active-stop-pending.v2";
  caller: ActiveStopCaller; scope: ActiveStopScope; requestId: string; toolCallId: string; nativeSessionId: string; turnId: string;
  normalizedSessionId: string; sourceInstanceId: string; requestSourceSeq: number; permissionSourceSeq: number;
  requestRowSha256: string; permissionRowSha256: string; cancellationRequestId: string; observedMonotonicNs: string;
  toolOriginSourceSeq: number; toolStartedSourceSeq: number; toolOriginRowSha256: string; toolStartedRowSha256: string;
}
const rec = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
const hash = (v: unknown) => `sha256:${createHash("sha256").update(canonicalJson(v)).digest("hex")}`;
function fail(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`Native active Stop: ${reason}`); }
/** The isolated Product server uses local-trusted board authentication. Bind
 * the same public session observed by the API client, never infer a null actor. */
export function readActiveStopCaller(health: unknown, authentication: unknown): ActiveStopCaller {
  const session = rec(rec(authentication).session);
  fail(rec(health).deploymentMode === "local_trusted" && session.userId === "local-board"
    && session.id === "paperclip:local_implicit:local-board", "expected isolated board caller missing");
  return { type: "board", userId: "local-board", source: "local_implicit" };
}
function isActiveStopCaller(caller: unknown): caller is ActiveStopCaller {
  const value = rec(caller);
  return value.type === "board" && value.userId === "local-board" && value.source === "local_implicit";
}
function canonicalRows(events: readonly unknown[], scope: ActiveStopScope) {
  fail(events.length <= 20_000 && events.length > 0, "bounded durable evidence required");
  const rows = events.map(rec).filter(row => rec(row.payload).prpEvent !== undefined);
  const seen = new Set<number>(), source = new Set<string>();
  for (const row of rows) {
    const e = rec(rec(row.payload).prpEvent);
    fail(row.companyId === scope.companyId && row.runId === scope.runId && isValidNativePrpEnvelope(e, row.protocolSchemaVersion)
      && e.sourceKind === "runner" && e.runId === scope.runId
      && e.eventType === row.eventType && Number.isSafeInteger(row.seq) && row.seq > 0 && !seen.has(row.seq)
      && id(e.sourceInstanceId) && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > 0
      && e.sourceEventId === `${e.sourceInstanceId}:${e.runId}:${e.sourceSeq}` && !source.has(e.sourceEventId), "invalid/duplicate/foreign canonical row");
    seen.add(row.seq); source.add(e.sourceEventId);
  }
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const lastBySource = new Map<string, number>();
  for (const row of ordered) {
    const e = rec(rec(row.payload).prpEvent), previous = lastBySource.get(e.sourceInstanceId) ?? 0;
    fail(e.sourceSeq > previous, "durable source sequence reordered");
    lastBySource.set(e.sourceInstanceId, e.sourceSeq);
  }
  return ordered.map(row => ({ row, event: rec(rec(row.payload).prpEvent) }));
}
const terminals = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
const closures = new Set(["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"]);
function origin(events: readonly unknown[], scope: ActiveStopScope, bootstrap?: BootstrapReadProof) {
  fail([scope.companyId, scope.issueId, scope.runId, scope.target].every(id) && ["cursor", "copilot"].includes(scope.provider), "exact scope required");
  const rows = canonicalRows(events, scope);
  const notices = scope.provider === "cursor" ? readCursorToolEvidence(events, scope.runId) : readCopilotToolEvidence(events, scope.runId);
  const requests = notices.filter(n => n.stage === "permission_requested");
  fail(requests.length === 1, "one native permission required");
  const notice = requests[0]!;
  fail(id(notice.requestId) && notice.declineOffered === true && (scope.provider === "cursor"
    ? notice.operation === "execute" && /^sha256:[a-f0-9]{64}$/u.test(scope.commandSha256 ?? "") && notice.commandSha256 === scope.commandSha256
    : notice.operation === "edit" && "target" in notice && notice.target === scope.target), "exact native operation required");
  const permission = rows.find(x => x.row.seq === notice.seq);
  const created = rows.filter(x => x.event.eventType === "runtime_request.created");
  fail(permission && created.length === 1, "one durable native card required");
  const request = rec(rec(created[0]!.event.payload).request), p = permission.event;
  fail(request.schema === "paperclip.runtime_request.v2" && request.type === "permission" && request.requestKind === "permission_approval"
    && request.status === "pending" && request.requestId === notice.requestId && request.turnId === notice.turnId
    && rec(request.details).toolCallId === notice.toolCallId && hasAcpxNativeOrigin(request.origin, scope.provider, "session/request_permission")
    && id(p.normalizedSessionId) && p.turnId === notice.turnId && created[0]!.event.turnId === notice.turnId
    && created[0]!.event.normalizedSessionId === p.normalizedSessionId && created[0]!.event.sourceInstanceId === p.sourceInstanceId,
  "native notice/card identity mismatch");
  const stream = (event: Row) => event.turnId === notice.turnId && event.normalizedSessionId === p.normalizedSessionId && event.sourceInstanceId === p.sourceInstanceId;
  fail(rows.filter(x => x.event.turnId != null).every(x => stream(x.event)), "foreign turn/session/source");
  const tool = notices.find(n => n.stage === "tool" && n.toolCallId === notice.toolCallId);
  fail(tool, "native operation origin missing");
  const selected = withoutProvenBootstrapReads(notices, tool, bootstrap);
  fail(selected.every(n => n.runId === notice.runId && n.sessionId === notice.sessionId && n.turnId === notice.turnId
    && n.toolCallId === notice.toolCallId && (n.requestId === undefined || n.requestId === notice.requestId)
    && (n.operation === undefined || n.operation === notice.operation)
    && (!("target" in n) || n.target === undefined || n.target === scope.target)
    && (n.commandSha256 === undefined || n.commandSha256 === scope.commandSha256)
    && n.status !== "completed" && (n.stage !== "permission_delivered" || n.outcome === "cancel")), "extra/replayed/answered native operation");
  const tools = selected.filter(n => n.stage === "tool");
  fail(tools.filter(n => n.status === "pending").length === 1
    && tools.filter(n => n.status === "failed").length <= 1
    && tools[0]!.status === "pending"
    // Cursor queues permission evidence until its exact command origin exists.
    // Copilot projects the request immediately, including permission-first ACP.
    && (scope.provider !== "cursor" || tools[0]!.seq < notice.seq)
    && selected.filter(n => n.stage === "permission_delivered").length <= 1, "duplicate native operation lifecycle");
  const executions = rows.filter(x => x.event.eventType.startsWith("tool.execution.") && rec(x.event.payload).executionId === bootstrapReadExecutionId(notice.toolCallId));
  fail(executions.filter(x => x.event.eventType === "tool.execution.started").length === 1
    && executions.filter(x => x.event.eventType === "tool.execution.completed").length <= 1
    && executions.every(x => rec(x.event.payload).schema === "paperclip.tool.execution.v1" && rec(x.event.payload).transport === "builtin"
      && ["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(x.event.eventType)
      && rec(x.event.payload).status === (x.event.eventType === "tool.execution.completed" ? "failed" : "running")), "duplicate canonical operation lifecycle");
  // ACP permits a permission request before its tool notification. Require
  // both in the pre-Stop observation, without imposing a card/start order.
  const toolOrigin = rows.find(x => x.row.seq === tools[0]!.seq);
  const toolStarted = executions.find(x => x.event.eventType === "tool.execution.started");
  fail(toolOrigin && toolStarted, "native operation origin missing");
  const allowed = new Set(notices.filter(n => n.stage === "tool").map(n => bootstrapReadExecutionId(n.toolCallId)));
  fail(rows.filter(x => x.event.eventType.startsWith("tool.execution.")).every(x => allowed.has(rec(x.event.payload).executionId)), "unattributed operation");
  fail(rows.filter(x => x.event.eventType === "tool.execution.completed" && rec(x.event.payload).executionId === bootstrapReadExecutionId(notice.toolCallId))
    .every(x => rec(x.event.payload).status !== "completed"), "target operation completed");
  return { rows, notice, permission, created: created[0]!, toolOrigin, toolStarted, request, stream };
}
export function observeActiveStopPending(input: { events: readonly unknown[]; run: Row; issue: Row; scope: ActiveStopScope; caller: ActiveStopCaller; cancellationRequestId: string; bootstrap?: BootstrapReadProof }): ActiveStopPending {
  const { run, issue, scope } = input, proof = origin(input.events, scope, input.bootstrap);
  fail(isActiveStopCaller(input.caller) && uuid(input.cancellationRequestId) && run.id === scope.runId && run.companyId === scope.companyId && run.nativeIssueId === scope.issueId
    && run.status === "running" && run.runtimeMode === "native" && issue.id === scope.issueId && issue.companyId === scope.companyId && issue.status === "in_progress"
    && run.resultJson?.startupCancellation == null && run.resultJson?.nativeCancellation == null, "run is not fresh active work");
  fail(!(scope.provider === "cursor" ? readCursorToolEvidence(input.events, scope.runId) : readCopilotToolEvidence(input.events, scope.runId)).some(n => n.stage === "permission_delivered"), "permission already answered");
  fail(!proof.rows.some(x => terminals.has(x.event.eventType) || closures.has(x.event.eventType)), "request or provider already settled");
  fail(!proof.rows.some(x => x.event.eventType === "tool.execution.completed" && rec(x.event.payload).executionId === bootstrapReadExecutionId(proof.notice.toolCallId)), "operation already ended");
  return { schema: "paperclip.e2e.native-active-stop-pending.v2", scope, caller: input.caller, requestId: proof.notice.requestId!, toolCallId: proof.notice.toolCallId,
    nativeSessionId: proof.notice.sessionId, turnId: proof.notice.turnId, normalizedSessionId: proof.permission.event.normalizedSessionId,
    sourceInstanceId: proof.permission.event.sourceInstanceId, requestSourceSeq: proof.created.event.sourceSeq, permissionSourceSeq: proof.permission.event.sourceSeq,
    requestRowSha256: hash(proof.created.row), permissionRowSha256: hash(proof.permission.row), cancellationRequestId: input.cancellationRequestId,
    toolOriginSourceSeq: proof.toolOrigin.event.sourceSeq, toolStartedSourceSeq: proof.toolStarted.event.sourceSeq,
    toolOriginRowSha256: hash(proof.toolOrigin.row), toolStartedRowSha256: hash(proof.toolStarted.row),
    observedMonotonicNs: process.hrtime.bigint().toString() };
}
export function readActiveStopSettlement(input: { events: readonly unknown[]; run: Row; issue: Row; pending: ActiveStopPending; dispatchMonotonicNs: string; bootstrap?: BootstrapReadProof }) {
  const before = input.pending, { run, issue } = input;
  fail(before?.schema === "paperclip.e2e.native-active-stop-pending.v2" && isActiveStopCaller(before.caller) && uuid(before.cancellationRequestId)
    && /^[1-9][0-9]{0,29}$/u.test(before.observedMonotonicNs) && /^[1-9][0-9]{0,29}$/u.test(input.dispatchMonotonicNs)
    && BigInt(before.observedMonotonicNs) < BigInt(input.dispatchMonotonicNs), "pre-dispatch pending observation missing");
  const proof = origin(input.events, before.scope, input.bootstrap);
  fail(hash(proof.created.row) === before.requestRowSha256 && hash(proof.permission.row) === before.permissionRowSha256
    && hash(proof.toolOrigin.row) === before.toolOriginRowSha256 && hash(proof.toolStarted.row) === before.toolStartedRowSha256
    && proof.toolOrigin.event.sourceSeq === before.toolOriginSourceSeq && proof.toolStarted.event.sourceSeq === before.toolStartedSourceSeq
    && proof.notice.sessionId === before.nativeSessionId && proof.notice.turnId === before.turnId && proof.notice.toolCallId === before.toolCallId
    && proof.notice.requestId === before.requestId && proof.permission.event.normalizedSessionId === before.normalizedSessionId
    && proof.permission.event.sourceInstanceId === before.sourceInstanceId && proof.created.event.sourceSeq === before.requestSourceSeq
    && proof.permission.event.sourceSeq === before.permissionSourceSeq, "observed pending request changed");
  const closed = proof.rows.filter(x => closures.has(x.event.eventType)), terminal = proof.rows.filter(x => terminals.has(x.event.eventType));
  fail(closed.length === 1 && terminal.length === 1, "one closed request and one terminal required");
  const c = closed[0]!, t = terminal[0]!, cp = rec(c.event.payload), tp = rec(t.event.payload);
  // Product persists the harness projection, not the raw runnerd backend
  // payload. The terminal mapper closes pending permissions with turn_terminal
  // and emits {status,error}. Bind that exact boundary to the retained native
  // request and caller-owned Stop below; a generic terminal is insufficient.
  fail(proof.stream(c.event) && proof.stream(t.event) && c.event.eventType === "runtime_request.cancelled" && cp.requestId === before.requestId && cp.turnId === before.turnId
    && cp.requestKind === "permission_approval" && cp.reason === "turn_terminal"
    && cp.itemId === proof.request.itemId && cp.action === undefined && cp.response === undefined && cp.replayAllowed !== true
    && t.event.eventType === "turn.cancelled" && tp.status === "cancelled" && tp.error === null
    && c.event.sourceSeq > Math.max(before.requestSourceSeq, before.permissionSourceSeq, before.toolOriginSourceSeq, before.toolStartedSourceSeq)
    && t.event.sourceSeq > c.event.sourceSeq,
  "pending callback did not close through cancellation");
  fail(proof.rows.filter(x => x.event.eventType.startsWith("tool.execution.")
    || (x.event.eventType === "provider.notice.recorded" && ["cursor_tool_evidence_v1", "copilot_tool_evidence_v1"].includes(rec(x.event.payload).category)))
    .every(x => x.event.sourceSeq < t.event.sourceSeq), "native operation after provider cancellation");
  const stop = rec(rec(run.resultJson).nativeCancellation), startup = rec(rec(run.resultJson).startupCancellation);
  fail(run.id === before.scope.runId && run.companyId === before.scope.companyId && run.nativeIssueId === before.scope.issueId && run.runtimeMode === "native" && run.status === "cancelled"
    && issue.id === before.scope.issueId && issue.companyId === before.scope.companyId && issue.status === "in_progress"
    && rec(startup.requestedBy).type === before.caller.type && rec(startup.requestedBy).userId === before.caller.userId
    && startup.cancellationRequestId === before.cancellationRequestId && stop.intentId === `native-cancellation:${before.cancellationRequestId}`
    && stop.schema === "paperclip.native-cancellation.v1" && stop.companyId === before.scope.companyId && stop.runId === run.id && stop.issueId === issue.id
    && stop.scope === "run" && stop.dispatched === true && stop.dispatchState === "acknowledged" && stop.reasonCode === "cancellation_run_only"
    && Array.isArray(stop.effects) && stop.effects.length === 1 && stop.effects[0] === "release_run_resources"
    && id(stop.intentAuditId) && id(stop.acknowledgementAuditId) && stop.intentAuditId !== stop.acknowledgementAuditId,
  "same-scope caller Stop acknowledgement missing");
  return { schema: "paperclip.e2e.native-active-stop-settlement.v2", pending: before, dispatchMonotonicNs: input.dispatchMonotonicNs,
    branch: "pending_permission_cancelled" as const, closedRequestSourceSeq: c.event.sourceSeq, terminalSourceSeq: t.event.sourceSeq,
    closedRequestRowSha256: hash(c.row), terminalRowSha256: hash(t.row), intentId: stop.intentId as string,
    intentAuditId: stop.intentAuditId as string, acknowledgementAuditId: stop.acknowledgementAuditId as string,
    taskStillInProgress: true, normalCompletionAccepted: false, replayAllowed: false };
}

export interface ActiveStopRemoteObservation {
  phase: "before-request" | "pending" | "owned-process-retirement";
  source: "live-snapshot" | "retirement-seal";
  snapshot: CopilotRemoteSnapshot;
}

/** A per-turn Daytona observer seals itself when the owned tree retires. The
 * host may retrieve that receipt later; retrieval is not a fresh observation. */
export function readActiveStopRemoteRetirement(input: {
  scope: Pick<ActiveStopScope, "companyId" | "runId" | "target">; observations: readonly ActiveStopRemoteObservation[];
}) {
  const observations = input.observations;
  fail(observations.length === 3
    && observations.map(o => `${o.phase}:${o.source}`).join(",") === "before-request:live-snapshot,pending:live-snapshot,owned-process-retirement:retirement-seal",
  "remote seal cannot stand in for a fresh causal sample");
  const [baseline, pending, terminal] = observations.map(o => o.snapshot) as [CopilotRemoteSnapshot, CopilotRemoteSnapshot, CopilotRemoteSnapshot];
  fail(baseline.binding.companyId === input.scope.companyId && baseline.binding.runId === input.scope.runId, "remote observation belongs to another run");
  for (const snapshot of [baseline, pending, terminal]) {
    fail(!copilotRemoteDeniedSample(snapshot, baseline, input.scope.target, "pending").exists, "remote target changed");
  }
  fail(BigInt(baseline.observedMonotonicNs) < BigInt(pending.observedMonotonicNs)
    && BigInt(pending.observedMonotonicNs) < BigInt(terminal.observedMonotonicNs), "remote observation reused or out of order");
  fail(!baseline.setup.published && pending.setup.published && pending.setup.sha256 === terminal.setup.sha256
    && baseline.processes.captured && pending.processes.captured
    && baseline.processes.live.includes(baseline.processes.root?.pid ?? -1)
    && pending.processes.live.includes(pending.processes.root?.pid ?? -1), "remote pending lifetime unproven");
  assertCopilotRemoteRetirement(terminal, baseline);
  assertCopilotRemoteRetirement(terminal, pending);
  for (const snapshot of [baseline, pending]) {
    fail(snapshot.processes.journal.every(p => terminal.processes.journal.some(q =>
      p.pid === q.pid && p.startTicks === q.startTicks && p.bootId === q.bootId)), "remote descendant journal lost");
  }
  return { schema: "paperclip.e2e.native-active-stop-remote-retirement.v1" as const,
    coverage: "continuous-through-owned-process-retirement" as const, filesystemAfterRetirementObserved: false as const,
    binding: terminal.binding, target: input.scope.target,
    observations: observations.map(o => ({ phase: o.phase, source: o.source,
      observedMonotonicNs: o.snapshot.observedMonotonicNs, snapshotSha256: hash(o.snapshot) })) };
}

/** Local files remain accessible through teardown. Remote per-turn files do
 * not: require the complete lifetime seal, never relabel it as a later sample. */
export function assertActiveStopRetirement(input: {
  completed: boolean; identityChanged: boolean;
  processes: { captured: boolean; live: readonly number[] };
  watcher: { complete: boolean; targetMutationCount: number };
} & ({ environment: "local"; samples: ReadonlyArray<{ phase: string; absent: boolean }> }
  | { environment: "daytona"; remote: Parameters<typeof readActiveStopRemoteRetirement>[0] })) {
  fail(input.completed && !input.identityChanged && input.processes.captured
    && input.processes.live.length === 0 && input.watcher.complete && input.watcher.targetMutationCount === 0,
  "retirement or continuous no-effect proof is incomplete");
  if (input.environment === "daytona") return readActiveStopRemoteRetirement(input.remote);
  fail(input.environment === "local" && input.samples.length === 4 && input.samples.every(s => s.absent === true)
    && input.samples.map(s => s.phase).join(",") === "before-request,pending,after-stop,after-cleanup",
  "causal target observation missing or changed");
  return { coverage: "local-through-cleanup" as const };
}
