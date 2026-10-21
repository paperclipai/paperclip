import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { piPermissionRequests } from "./pi-native-evidence.js";
import type { RemoteNativeFixture, RemoteNativeSnapshot } from "./remote-native-fixtures.js";

type Row = Record<string, any>;
const hash = (row: unknown) => `sha256:${createHash("sha256").update(canonicalJson(row)).digest("hex")}`;
const requireProof = (ok: unknown) => { if (!ok) throw new Error("Pi bootstrap: exact published read approval is unproven"); };
export interface PiBootstrapApproval {
  schema: "paperclip.e2e.pi-bootstrap-read-approval.v1";
  companyId: string; issueId: string; runId: string; actionFile: string; publishedSha256: string;
  requestId: string; toolCallId: string; turnId: string; normalizedSessionId: string; sourceInstanceId: string;
  createdRowSha256: string; resolvedRowSha256: string; completedRowSha256: string;
}
export interface PiBootstrapState { run: Row; issue: Row; events: readonly unknown[] }

function readLifecycle(events: readonly unknown[], input: Pick<PiBootstrapApproval, "companyId" | "runId" | "actionFile" | "requestId">) {
  requireProof(events.length > 0 && events.length <= 20_000 && /^\.paperclip-eval-action-[a-f0-9]{36}\.txt$/u.test(input.actionFile));
  const seqs = new Set<number>(), sourceIds = new Set<string>(), lastSource = new Map<string, number>();
  for (const row of events as readonly Row[]) {
    const e = row.payload?.prpEvent; if (e === undefined) continue;
    requireProof(e && isValidNativePrpEnvelope(e, row.protocolSchemaVersion) && row.companyId === input.companyId
      && row.runId === input.runId && e.runId === input.runId && e.eventType === row.eventType
      && ["runner", "control_plane"].includes(e.sourceKind) && typeof e.sourceInstanceId === "string" && e.sourceInstanceId.length > 0
      && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq)
      && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > (lastSource.get(e.sourceInstanceId) ?? 0)
      && e.sourceEventId === `${e.sourceInstanceId}:${input.runId}:${e.sourceSeq}` && !sourceIds.has(e.sourceEventId)
      && Number.isFinite(Date.parse(e.emittedAt)));
    seqs.add(row.seq); sourceIds.add(e.sourceEventId); lastSource.set(e.sourceInstanceId, e.sourceSeq);
  }
  const created = piPermissionRequests(events, input.runId).filter(x => x.request.requestId === input.requestId);
  requireProof(created.length === 1); const card = created[0]!;
  requireProof(isValidNativePrpEnvelope(card.event, card.row.protocolSchemaVersion) && card.row.companyId === input.companyId && card.request.requestKind === "permission_approval"
    && typeof card.event.turnId === "string" && card.event.turnId.length > 0
    && typeof card.event.normalizedSessionId === "string" && card.event.normalizedSessionId.length > 0
    && card.request.choices.filter((choice: Row) => choice.key === "accept").length === 1);
  const executionId = bootstrapReadExecutionId(card.request.details.toolCallId);
  const rows = (events as readonly Row[]).filter(row => row.payload?.prpEvent?.payload?.executionId === executionId);
  requireProof(rows.length > 0 && rows.length <= 2048);
  let known = false, lastSeq = 0;
  for (const row of rows) {
    const event = row.payload.prpEvent, p = event.payload;
    requireProof(isValidNativePrpEnvelope(event, row.protocolSchemaVersion) && row.companyId === input.companyId && row.runId === input.runId && event.runId === input.runId
      && row.protocolSchemaVersion === 1 && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1
      && event.sourceKind === "runner" && event.turnId === card.event.turnId && event.normalizedSessionId === card.event.normalizedSessionId
      && event.sourceInstanceId === card.event.sourceInstanceId && event.eventType === row.eventType
      && Number.isSafeInteger(row.seq) && row.seq > lastSeq
      && p.schema === "paperclip.tool.execution.v1" && p.transport === "builtin" && p.name === "read" && p.operation === "read"
      && ["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(row.eventType)
      && (p.target === input.actionFile || (!known && p.target === null && row.eventType !== "tool.execution.completed")));
    known ||= p.target === input.actionFile; lastSeq = row.seq;
  }
  requireProof(known && rows[0]!.eventType === "tool.execution.started"
    && rows.filter(row => row.eventType === "tool.execution.started").length === 1
    && rows.filter(row => row.eventType === "tool.execution.completed").length <= 1
    && rows.every((row, index) => row.eventType === "tool.execution.completed"
      ? index === rows.length - 1 && row.payload.prpEvent.payload.status === "completed"
      : row.payload.prpEvent.payload.status === "running"));
  return { card, rows, executionId };
}

/** Remove only the two hash-bound setup permission records. All native read
 * lifecycle rows and every tested write/permission remain in the oracle. */
export function withoutApprovedPiBootstrapRequests(events: readonly unknown[], proof?: PiBootstrapApproval): unknown[] {
  if (!proof) return [...events];
  requireProof(proof.schema === "paperclip.e2e.pi-bootstrap-read-approval.v1" && /^sha256:[a-f0-9]{64}$/u.test(proof.publishedSha256));
  const { card, rows } = readLifecycle(events, proof);
  requireProof(card.request.details.toolCallId === proof.toolCallId && card.event.turnId === proof.turnId
    && card.event.normalizedSessionId === proof.normalizedSessionId && card.event.sourceInstanceId === proof.sourceInstanceId
    && hash(card.row) === proof.createdRowSha256);
  const closures = (events as readonly Row[]).filter(row => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(row.eventType)
    && row.payload?.prpEvent?.payload?.requestId === proof.requestId);
  requireProof(closures.length === 1); const closed = closures[0]!, e = closed.payload.prpEvent;
  requireProof(isValidNativePrpEnvelope(e, closed.protocolSchemaVersion) && closed.companyId === proof.companyId && closed.runId === proof.runId && closed.protocolSchemaVersion === 1
    && e.schema === "paperclip.prp.event.v1" && e.schemaVersion === 1 && e.sourceKind === "runner" && e.runId === proof.runId
    && e.eventType === "runtime_request.resolved" && closed.eventType === e.eventType && e.sourceInstanceId === proof.sourceInstanceId
    && e.turnId === proof.turnId && e.normalizedSessionId === proof.normalizedSessionId && e.payload.turnId === proof.turnId
    && e.payload.action === "accept" && closed.seq > card.row.seq && hash(closed) === proof.resolvedRowSha256);
  const completed = rows.at(-1)!;
  requireProof(completed.eventType === "tool.execution.completed" && completed.seq > closed.seq && hash(completed) === proof.completedRowSha256);
  const tested = piPermissionRequests(events, proof.runId).filter(x => x.request.requestId !== proof.requestId);
  requireProof(tested.every(x => x.row.seq > completed.seq && x.event.turnId === proof.turnId
    && x.event.normalizedSessionId === proof.normalizedSessionId && x.event.sourceInstanceId === proof.sourceInstanceId));
  return events.filter(row => row !== card.row && row !== closed);
}

/** The operator may approve one setup read after publication and observer
 * arming. Production permission policy and the tested write are untouched. */
export async function approvePiBootstrapRead(input: {
  api: RunnerApi; fixture: { actionFile: string; binding: Pick<RemoteNativeFixture["binding"], "companyId" | "runId">; snapshot(label: string): Promise<Pick<RemoteNativeSnapshot, "complete" | "setup">> }; companyId: string; issueId: string; runId: string;
  deadlineAt: number; load(): Promise<PiBootstrapState>; evidence(name: string, value: unknown): Promise<void>;
}): Promise<PiBootstrapApproval | undefined> {
  const actionFile = input.fixture.actionFile;
  requireProof(/^\.paperclip-eval-action-[a-f0-9]{36}\.txt$/u.test(actionFile)
    && input.fixture.binding.companyId === input.companyId && input.fixture.binding.runId === input.runId);
  const pending = await pollUntil({ label: "Pi published bootstrap read", deadlineAt: input.deadlineAt, intervalMs: 100,
    load: input.load, reject: state => ["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status) ? "Pi bootstrap run settled" : undefined,
    accept: state => piPermissionRequests(state.events, input.runId).length > 0 });
  requireProof(pending.run.status === "running" && pending.run.runtimeMode === "native" && pending.issue.status === "in_progress" && pending.run.id === input.runId && pending.run.companyId === input.companyId && pending.run.nativeIssueId === input.issueId
    && pending.issue.id === input.issueId && pending.issue.companyId === input.companyId);
  const requests = piPermissionRequests(pending.events, input.runId); requireProof(requests.length === 1);
  const card = requests[0]!, executionId = bootstrapReadExecutionId(card.request.details.toolCallId);
  const native = (pending.events as readonly Row[]).filter(row => row.payload?.prpEvent?.payload?.executionId === executionId);
  // A read permitted without delegation can already have led to the tested
  // write. There is no setup permission to remove in that existing path.
  if (native.some(row => row.payload.prpEvent.payload.operation === "edit")) return undefined;
  const checked = readLifecycle(pending.events, { companyId: input.companyId, runId: input.runId, actionFile, requestId: card.request.requestId });
  requireProof(!checked.rows.some(row => row.eventType === "tool.execution.completed"));
  const snapshot = await input.fixture.snapshot("bootstrap-read-published");
  requireProof(snapshot.complete && snapshot.setup.path === actionFile && snapshot.setup.published
    && /^sha256:[a-f0-9]{64}$/u.test(snapshot.setup.sha256 ?? ""));
  await input.evidence("pi-bootstrap-read-before-approval.json", { binding: input.fixture.binding, snapshot, request: card.row, native: checked.rows });
  await input.api.post(`/api/heartbeat-runs/${input.runId}/runtime-requests/${encodeURIComponent(card.request.requestId)}/resolve`,
    { turnId: card.event.turnId, requestKind: "permission_approval", resolution: { action: "accept" } });
  const finished = await pollUntil({ label: "Pi exact bootstrap read completion", deadlineAt: input.deadlineAt, intervalMs: 100, load: input.load,
    reject: state => ["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status) ? "Pi bootstrap run settled" : undefined,
    accept: state => (state.events as readonly Row[]).some(row => row.eventType === "tool.execution.completed"
      && row.payload?.prpEvent?.payload?.executionId === executionId) });
  const closure = (finished.events as readonly Row[]).find(row => row.eventType === "runtime_request.resolved" && row.payload?.prpEvent?.payload?.requestId === card.request.requestId);
  const completed = (finished.events as readonly Row[]).find(row => row.eventType === "tool.execution.completed" && row.payload?.prpEvent?.payload?.executionId === executionId);
  requireProof(closure && completed);
  const after = await input.fixture.snapshot("bootstrap-read-completed");
  requireProof(after.complete && after.setup.path === actionFile && after.setup.published && after.setup.sha256 === snapshot.setup.sha256);
  await input.evidence("pi-bootstrap-read-completed.json", { binding: input.fixture.binding, snapshot: after });
  const proof: PiBootstrapApproval = { schema: "paperclip.e2e.pi-bootstrap-read-approval.v1", companyId: input.companyId, issueId: input.issueId, runId: input.runId,
    actionFile, publishedSha256: snapshot.setup.sha256!, requestId: card.request.requestId, toolCallId: card.request.details.toolCallId,
    turnId: card.event.turnId, normalizedSessionId: card.event.normalizedSessionId, sourceInstanceId: card.event.sourceInstanceId,
    createdRowSha256: hash(card.row), resolvedRowSha256: hash(closure), completedRowSha256: hash(completed) };
  withoutApprovedPiBootstrapRequests(finished.events, proof);
  await input.evidence("pi-bootstrap-read-approval.json", proof); return proof;
}
