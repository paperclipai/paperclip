import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { getTaskContextAction } from "../../packages/paperclip-runner/src/protocol-actions/get-task-context.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";

import type { KimiContextAuthority } from "./kimi-context-checkpoint.js";

type Row = Record<string, any>;
const rec = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const bytesHash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => bytesHash(canonicalJson(value));
const requireProof = (ok: unknown): void => { if (!ok) throw new Error("Kimi context rendezvous: exact scoped read proof is unavailable"); };
export interface KimiContextScope { companyId: string; agentId: string; environmentId: string; issueId: string; runId: string }
export interface KimiContextPending extends KimiContextScope {
  requestId: string; toolCallId: string; executionId: string; turnId: string; sessionId: string; sourceInstanceId: string;
  createdSeq: number; createdSha256: string;
}
export interface KimiContextPublication extends KimiContextPending {
  schema: "paperclip.e2e.kimi-context-publication.v1"; observerLeaseId: string; actionSha256: string; setupSha256: string; observerSha256: string;
}
export interface KimiContextProof extends Omit<KimiContextPublication, "schema"> {
  schema: "paperclip.e2e.kimi-context-proof.v1";
  callId: string; inputSha256: string; resultSha256: string; completedSeq: number; authority: KimiContextAuthority;
  rows: Array<{ seq: number; sha256: string }>;
}
function frames(events: readonly unknown[], scope: KimiContextScope) {
  requireProof(events.length > 0 && events.length <= 20_000);
  const rows = events.map(rec).filter(row => rec(row.payload).prpEvent !== undefined).map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).sort((a, b) => a.row.seq - b.row.seq);
  const seqs = new Set<number>(), sources = new Set<string>(), cursor = new Map<string, number>();
  for (const { row, event } of rows) {
    requireProof(row.companyId === scope.companyId && row.runId === scope.runId && isValidNativePrpEnvelope(event, row.protocolSchemaVersion)
      && event.runId === scope.runId && event.eventType === row.eventType && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq)
      && typeof event.sourceInstanceId === "string" && event.sourceInstanceId && Number.isSafeInteger(event.sourceSeq)
      && event.sourceSeq > (cursor.get(event.sourceInstanceId) ?? 0) && event.sourceEventId === `${event.sourceInstanceId}:${scope.runId}:${event.sourceSeq}`
      && !sources.has(event.sourceEventId));
    seqs.add(row.seq); sources.add(event.sourceEventId); cursor.set(event.sourceInstanceId, event.sourceSeq);
  }
  return rows;
}
function sameStream(event: Row, pending: KimiContextPending) {
  return event.sourceKind === "runner" && event.turnId === pending.turnId && event.normalizedSessionId === pending.sessionId && event.sourceInstanceId === pending.sourceInstanceId;
}
function declaredReadOnlyContext() {
  requireProof(getTaskContextAction.canonical.operationId === "get_task_context" && getTaskContextAction.canonical.sideEffectClass === "read"
    && canonicalJson(getTaskContextAction.live.descriptor.inputSchema) === canonicalJson({ type: "object", properties: {}, required: [], additionalProperties: false }));
}
export function kimiContextRendezvousPrompt(): string {
  return "Call the already configured Paperclip get_task_context tool exactly once with {}. Wait for the operator's one Allow once decision. Its returned activeTask.description will contain the complete task continuation. Perform no native read, shell, write, search, discovery, semantic mutation, or completion before receiving that context. After reading the returned description, perform only that supplied native action.";
}
export function pendingKimiContextPermission(events: readonly unknown[], scope: KimiContextScope): KimiContextPending | undefined {
  declaredReadOnlyContext();
  const rows = frames(events, scope), created = rows.filter(x => x.event.eventType === "runtime_request.created");
  if (!created.length) return undefined;
  requireProof(created.length === 1);
  const { row, event } = created[0]!, request = rec(rec(event.payload).request);
  requireProof(request.schema === "paperclip.runtime_request.v2" && request.requestKind === "permission_approval" && request.type === "permission" && request.status === "pending"
    && request.prompt === "mcp__paperclip__get_task_context" && request.method === "session/request_permission"
    && hasAcpxNativeOrigin(request.origin, "kimi", "session/request_permission") && request.turnId === event.turnId
    && typeof request.requestId === "string" && typeof request.details?.toolCallId === "string"
    && Array.isArray(request.choices) && request.choices.map((x: Row) => x.key).sort().join(",") === "accept,cancel,decline");
  const pending: KimiContextPending = { ...scope, requestId: request.requestId, toolCallId: request.details.toolCallId, executionId: bootstrapReadExecutionId(request.details.toolCallId),
    turnId: event.turnId, sessionId: event.normalizedSessionId, sourceInstanceId: event.sourceInstanceId, createdSeq: row.seq, createdSha256: hash(row) };
  requireProof([pending.turnId, pending.sessionId, pending.sourceInstanceId].every(value => typeof value === "string" && value.length > 0));
  const tools = rows.filter(x => x.event.eventType.startsWith("tool.execution."));
  requireProof(tools.every(x => sameStream(x.event, pending) && x.event.payload?.executionId === pending.executionId && x.event.payload?.target === null));
  const named = tools.filter(x => x.event.payload?.transport === "mcp" && x.event.payload?.namespace === "paperclip" && x.event.payload?.name === "get_task_context");
  if (!named.length) return undefined;
  requireProof(tools.every(x => x.event.payload?.status === "running" && x.event.eventType !== "tool.execution.completed")
    && rows.every(x => !x.event.eventType.startsWith("semantic_tool.") && !["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(x.event.eventType)));
  return pending;
}
export async function publishKimiContextContinuation(input: {
  pending: KimiContextPending; action: string;
  fixture: { actionFile: string; snapshot(label: string): Promise<Row> };
  api: { get<T>(path: string): Promise<T>; patch<T>(path: string, body: unknown): Promise<T> };
}): Promise<KimiContextPublication> {
  const p = input.pending; requireProof(input.action.trim().length > 0 && Buffer.byteLength(input.action) <= 16_384);
  const snapshot = await input.fixture.snapshot("before-kimi-context-publication"), binding = rec(snapshot.binding), setup = rec(snapshot.setup), actionSha256 = bytesHash(input.action);
  requireProof(snapshot.complete === true && snapshot.watcher?.complete === true && snapshot.watcher?.targetMutationCount === 0 && snapshot.watcher?.workspaceMutationCount === 0
    && typeof binding.leaseId === "string" && binding.leaseId.length > 0 && binding.companyId === p.companyId && binding.environmentId === p.environmentId && binding.runId === p.runId && setup.path === input.fixture.actionFile && setup.published === true && setup.sha256 === actionSha256);
  const [issue, run] = await Promise.all([input.api.get<Row>(`/api/issues/${p.issueId}`), input.api.get<Row>(`/api/heartbeat-runs/${p.runId}`)]);
  const owned = (task: Row) => task.id === p.issueId && task.companyId === p.companyId && task.assigneeAgentId === p.agentId && task.executionRunId === p.runId && task.status === "in_progress";
  requireProof(owned(issue) && run.id === p.runId && run.companyId === p.companyId && run.agentId === p.agentId && run.status === "running" && run.runtimeMode === "native" && run.nativeIssueId === p.issueId
    && run.nativeSessionId === p.sessionId && run.runnerInstanceId === p.sourceInstanceId);
  const updated = await input.api.patch<Row>(`/api/issues/${p.issueId}`, { description: input.action });
  const confirmed = await input.api.get<Row>(`/api/issues/${p.issueId}`);
  requireProof(owned(updated) && owned(confirmed) && updated.description === input.action && confirmed.description === input.action);
  return { ...p, schema: "paperclip.e2e.kimi-context-publication.v1", observerLeaseId: binding.leaseId, actionSha256, setupSha256: setup.sha256, observerSha256: hash(snapshot) };
}
export function readKimiContextProof(events: readonly unknown[], publication: KimiContextPublication, authority?: KimiContextAuthority): KimiContextProof | undefined {
  declaredReadOnlyContext();
  requireProof(publication.schema === "paperclip.e2e.kimi-context-publication.v1" && /^sha256:[a-f0-9]{64}$/.test(publication.actionSha256)
    && publication.setupSha256 === publication.actionSha256 && /^sha256:[a-f0-9]{64}$/.test(publication.observerSha256));
  const rows = frames(events, publication), same = rows.filter(x => sameStream(x.event, publication));
  const created = same.filter(x => x.event.eventType === "runtime_request.created" && x.event.payload?.request?.requestId === publication.requestId);
  requireProof(created.length === 1 && created[0]!.row.seq === publication.createdSeq && hash(created[0]!.row) === publication.createdSha256);
  const closed = same.filter(x => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(x.event.eventType) && x.event.payload?.requestId === publication.requestId);
  if (!closed.length) return undefined;
  requireProof(closed.length === 1 && closed[0]!.event.eventType === "runtime_request.resolved" && closed[0]!.event.payload.action === "accept" && closed[0]!.event.payload.requestKind === "permission_approval"
    && closed[0]!.event.payload.turnId === publication.turnId && closed[0]!.row.seq > publication.createdSeq);
  const beforeDecision = events.filter(value => rec(value).seq < closed[0]!.row.seq);
  const original = pendingKimiContextPermission(beforeDecision, publication);
  requireProof(original && Object.entries(original).every(([key, value]) => publication[key as keyof KimiContextPublication] === value));
  if (!authority) return undefined;
  requireProof(authority.schema === "paperclip.e2e.kimi-context-authority.v2"
    && ["companyId", "issueId", "agentId", "environmentId", "runId", "sessionId", "sourceInstanceId", "turnId", "actionSha256", "observerLeaseId", "requestId", "toolCallId"].every(key => (authority as unknown as Row)[key] === (publication as unknown as Row)[key])
    && authority.inputSha256 === hash({}) && typeof authority.callId === "string" && authority.callId.length > 0
    && [authority.inputEventSha256, authority.resultSha256, authority.correlationSha256, authority.commandSha256, authority.deliverySha256, authority.checkpointIdentitySha256, authority.requestCreatedSha256, authority.requestResolvedSha256, authority.turnStartSha256, authority.resolutionCommandSha256].every(value => /^sha256:[a-f0-9]{64}$/.test(value))
    && typeof authority.executionWorkspaceId === "string" && authority.executionWorkspaceId.length > 0
    && created[0]!.event.itemId === authority.controllerItemId && created[0]!.event.payload.request.itemId === authority.controllerItemId
    && created[0]!.event.payload.request.details?.itemId === authority.controllerItemId
    && created[0]!.event.payload.request.details?.turnId === publication.turnId
    && Number.isSafeInteger(authority.inputSourceSeq) && authority.requestCreatedSourceSeq < authority.requestResolvedSourceSeq && authority.requestResolvedSourceSeq < authority.inputSourceSeq
    && authority.authenticatedConnectionCount > 0 && authority.highestRecordedSourceSeq >= authority.inputSourceSeq);
  const native = same.filter(x => x.event.eventType.startsWith("tool.execution.") && x.event.payload?.executionId === publication.executionId);
  const finished = native.filter(x => x.event.eventType === "tool.execution.completed");
  if (!finished.length) return undefined;
  requireProof(finished.length === 1 && native[0]?.event.eventType === "tool.execution.started" && native.at(-1) === finished[0]
    && native.every((x, index) => x.event.payload?.schema === "paperclip.tool.execution.v1" && x.event.payload?.target === null
      && (x.event.payload.name === null || x.event.payload.name === "get_task_context")
      && (x.event.payload.namespace === null || x.event.payload.namespace === "paperclip")
      && x.event.payload.status === (index === native.length - 1 ? "completed" : "running")));
  const final = finished[0]!, output = final.event.payload;
  requireProof(final.row.seq > closed[0]!.row.seq && typeof output.output === "string" && Buffer.byteLength(output.output) <= 64 * 1024
    && typeof output.outputTruncated === "boolean" && Number.isSafeInteger(output.outputBytes) && output.outputBytes >= Buffer.byteLength(output.output)
    && typeof output.outputDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(output.outputDigest)
    && (output.outputTruncated || output.outputBytes === Buffer.byteLength(output.output) && output.outputDigest === bytesHash(output.output)));
  const retained = [...created, ...closed, ...native];
  requireProof(new Set(retained.map(x => x.row.seq)).size === retained.length);
  return { ...publication, schema: "paperclip.e2e.kimi-context-proof.v1", callId: authority.callId, inputSha256: authority.inputSha256, resultSha256: authority.resultSha256, authority,
    completedSeq: final.row.seq, rows: retained.map(x => ({ seq: x.row.seq, sha256: hash(x.row) })) };
}
export function withoutProvenKimiContext(events: readonly unknown[], proof?: KimiContextProof): unknown[] {
  if (!proof) return [...events];
  const checked = readKimiContextProof(events, { ...proof, schema: "paperclip.e2e.kimi-context-publication.v1" }, proof.authority);
  requireProof(checked && canonicalJson(checked) === canonicalJson(proof));
  const remove = new Map(proof.rows.map(row => [row.seq, row.sha256]));
  return events.filter(value => { const row = rec(value), expected = remove.get(row.seq); if (!expected) return true; requireProof(hash(row) === expected); return false; });
}

export async function approveKimiContextThroughUi(input: {
  page: Page; publication: KimiContextPublication; load(): Promise<{ events: readonly unknown[] }>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const before = pendingKimiContextPermission((await input.load()).events, input.publication);
  requireProof(before && Object.entries(before).every(([key, value]) => input.publication[key as keyof KimiContextPublication] === value));
  const card = input.page.getByTestId("task-chat-runtime-request").filter({ visible: true });
  await expect(card).toHaveCount(1);
  await expect(card.getByText("mcp__paperclip__get_task_context", { exact: true })).toBeVisible();
  const endpoint = `/api/heartbeat-runs/${input.publication.runId}/runtime-requests/${encodeURIComponent(input.publication.requestId)}/resolve`;
  const sent = input.page.waitForRequest(request => new URL(request.url()).pathname === endpoint && request.method() === "POST");
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  const body = (await sent).postDataJSON();
  requireProof(body.turnId === input.publication.turnId && body.requestKind === "permission_approval" && body.resolution?.action === "accept");
  await input.evidence("kimi-context-fixture-human-decision.json", { ...input.publication, action: "accept", source: "fixture human; normal browser Allow once for server-owned empty-input read", submittedBodySha256: hash(body) });
}
