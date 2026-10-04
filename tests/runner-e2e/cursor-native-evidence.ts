import { withoutProvenBootstrapReads, type BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

export interface CursorToolNotice {
  runId: string; sessionId: string; turnId: string; toolCallId: string; seq: number;
  stage: "tool" | "permission_requested" | "permission_delivered";
  status?: string; operation?: string; commandSha256?: string; readTargetSha256?: string; requestId?: string; declineOffered?: boolean; outcome?: string;
}
const rec = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const enums = { stage: ["tool", "permission_requested", "permission_delivered"], status: ["pending", "in_progress", "completed", "failed"], operation: ["execute", "read"], outcome: ["allow_once", "allow_always", "reject_once", "cancel"] };
const names = new Set(["stage", "toolCallId", "status", "operation", "commandSha256", "readTargetSha256", "requestId", "declineOffered", "outcome"]);
export function readCursorToolEvidence(rows: readonly unknown[], runId: string): CursorToolNotice[] {
  const result: CursorToolNotice[] = [];
  for (const value of rows) {
    const row = rec(value), event = rec(rec(row.payload).prpEvent), p = rec(event.payload);
    if (p.category !== "cursor_tool_evidence_v1") continue;
    const origin = rec(p.provenance);
    if (row.eventType !== "provider.notice.recorded" || row.runId !== runId || row.protocolSchemaVersion !== 1 || event.schemaVersion !== 1 || p.schema !== "paperclip.provider.notice.v1" || p.scope !== "turn" || event.schema !== "paperclip.prp.event.v1" || event.sourceKind !== "runner" || event.eventType !== row.eventType || event.runId !== runId || !id(origin.sessionId) || !id(origin.turnId) || origin.turnId !== event.turnId || !Array.isArray(p.details) || p.details.length > 12 || !Number.isSafeInteger(row.seq) || row.seq < 0 || !Number.isFinite(Date.parse(event.emittedAt))) throw new Error("Invalid Cursor evidence binding");
    const fields: Record<string, string> = {};
    for (const value of p.details) {
      const d = rec(value);
      if (d.name === "stage" && d.value === "evidence_incomplete") throw new Error("Cursor evidence is explicitly incomplete");
      if (!names.has(d.name) || Object.hasOwn(fields, d.name) || typeof d.value !== "string" || d.value.length > 1024 || d.value.includes("[REDACTED]")) throw new Error("Invalid Cursor evidence detail");
      fields[d.name] = d.value;
    }
    if (!id(fields.toolCallId) || !enums.stage.includes(fields.stage!) || origin.eventType !== fields.stage || origin.method !== (fields.stage === "tool" ? "session/update" : "session/request_permission")) throw new Error("Invalid Cursor evidence origin");
    for (const [key, values] of Object.entries(enums)) if (fields[key] !== undefined && !values.includes(fields[key]!)) throw new Error("Invalid Cursor evidence enum");
    if (fields.requestId !== undefined && !id(fields.requestId)) throw new Error("Invalid Cursor request identity");
    if (fields.readTargetSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(fields.readTargetSha256)) throw new Error("Invalid Cursor read digest");
    if (fields.commandSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(fields.commandSha256)) throw new Error("Invalid Cursor command digest");
    if (fields.declineOffered !== undefined && !["true", "false"].includes(fields.declineOffered)) throw new Error("Invalid Cursor offered choice");
    result.push({ ...fields, runId, sessionId: origin.sessionId, turnId: origin.turnId, seq: row.seq, declineOffered: fields.declineOffered === "true" } as CursorToolNotice);
  }
  if (new Set(result.map(row => row.seq)).size !== result.length) throw new Error("Duplicate Cursor evidence sequence");
  return result;
}

/** Exact absolute target removes any dependency on implicit native shell cwd. */
export function cursorDeniedCommand(path: string) {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Invalid denial target");
  const command = `printf 'MUST-NOT-EXIST' > '${path.replaceAll("'", "'\\''")}'`;
  return { command, commandSha256: `sha256:${createHash("sha256").update(command).digest("hex")}` };
}
export function hasCursorDeniedCommand(input: {
  notices: readonly CursorToolNotice[]; runId: string; turnId: string; requestId: string; toolCallId: string; commandSha256: string; bootstrapReadProof?: BootstrapReadProof;
}): boolean {
  const origin = input.notices.find(row => row.stage === "tool" && row.status === "pending" && row.operation === "execute" && row.toolCallId === input.toolCallId && row.commandSha256 === input.commandSha256);
  let notices: readonly CursorToolNotice[];
  try { notices = origin ? withoutProvenBootstrapReads(input.notices, origin, input.bootstrapReadProof) : input.notices; }
  catch { return false; }
  const requests = notices.filter(row => row.stage === "permission_requested");
  if (requests.length !== 1) return false;
  const request = requests[0]!;
  const same = (row: CursorToolNotice) => row.runId === input.runId && row.turnId === input.turnId && row.toolCallId === input.toolCallId && row.sessionId === request.sessionId && row.commandSha256 === input.commandSha256 && row.operation === "execute";
  if (!same(request) || request.requestId !== input.requestId || !request.declineOffered) return false;
  const origins = notices.filter(row => row.stage === "tool" && row.status === "pending");
  const delivered = notices.filter(row => row.stage === "permission_delivered");
  // Cursor reports a denied call as completed when its transport settles. That
  // status does not prove execution; correlated reject_once and independent
  // continuous filesystem observation establish denial in the Product flow.
  const settled = notices.filter(row => row.stage === "tool" && ["failed", "completed"].includes(row.status ?? ""));
  return origins.length === 1 && same(origins[0]!) && delivered.length === 1 && same(delivered[0]!)
    && delivered[0]!.requestId === input.requestId && delivered[0]!.outcome === "reject_once"
    && settled.length === 1 && same(settled[0]!) && origins[0]!.seq < request.seq && request.seq < delivered[0]!.seq && delivered[0]!.seq < settled[0]!.seq
    && notices.every(row => same(row));
}

/** A denied native turn may end without semantic completion. Never qualify
 * that as task success or as an acknowledged operator cancellation. */
export function hasCursorDeniedTurnTerminal(input: {
  run: unknown; issue: unknown; events: readonly unknown[]; runId: string; turnId: string; requestId: string;
}): boolean {
  const run = rec(input.run), issue = rec(input.issue);
  const missingResult = run.errorCode === "native_session_interrupted" && run.error === "native_finalization_missing: session returned no semantic result";
  const declined = run.errorCode === "native_permission_declined" && run.error === "native_finalization_missing: session returned no semantic result; Cursor permission was declined; explicit direction is required";
  if (!id(input.runId) || !id(input.turnId) || !id(input.requestId) || run.id !== input.runId || run.nativeIssueId !== issue.id
    || run.status !== "failed" || run.runtimeMode !== "native" || issue.status !== (declined ? "blocked" : "in_progress")
    || (!missingResult && !declined)) return false;
  const terminals = input.events.map(rec).map(row => ({ row, event: rec(rec(row.payload).prpEvent) }))
    .filter(({ event }) => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType));
  const delivered = readCursorToolEvidence(input.events, input.runId).filter(notice => notice.stage === "permission_delivered"
    && notice.turnId === input.turnId && notice.requestId === input.requestId && notice.outcome === "reject_once");
  if (terminals.length !== 1 || delivered.length !== 1) return false;
  const { row, event } = terminals[0]!;
  return row.runId === input.runId && row.eventType === event.eventType && event.runId === input.runId && event.turnId === input.turnId
    && event.eventType === "turn.completed" && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1
    && row.protocolSchemaVersion === 1 && event.sourceKind === "runner" && rec(event.payload).status === "completed"
    && rec(event.payload).error === null && Number.isSafeInteger(row.seq) && row.seq > delivered[0]!.seq
    && Number.isFinite(Date.parse(event.emittedAt));
}

export function hasCursorCancellation(input: { run: unknown; issue: unknown; events: readonly unknown[]; runId: string; turnId: string; requestedAt: number }): boolean {
  const run = rec(input.run), cancellation = rec(rec(run.resultJson).nativeCancellation);
  const terminals = input.events.map(rec).map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).filter(({ event }) => ["turn.cancelled", "turn.interrupted"].includes(event.eventType));
  return run.id === input.runId && run.status === "cancelled" && rec(input.issue).status === "in_progress"
    && cancellation.dispatchState === "acknowledged" && cancellation.dispatched === true && cancellation.scope === "run"
    && terminals.length === 1 && terminals.every(({ row, event }) => row.runId === input.runId && event.runId === input.runId && event.turnId === input.turnId
      && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1 && row.protocolSchemaVersion === 1 && event.sourceKind === "runner"
      && Number.isFinite(input.requestedAt) && Date.parse(event.emittedAt) >= input.requestedAt);
}

/** Controller-observed sandbox receipts; never substitute host copy-back files. */
export interface CursorRemoteBinding {
  companyId: string; environmentId: string; runId: string; leaseId: string;
  sandboxId: string; remoteCwd: string; image: string;
}
export interface CursorRemoteSnapshot {
  binding: CursorRemoteBinding; observedAtMs: number; complete: boolean;
  workspace: Record<string, string>;
  targets: Record<string, { absent: boolean; sha256: string | null; parent: { dev: string; ino: string }; mutationCount: number; complete: boolean }>;
  watcher: { complete: boolean; targetMutationCount: number; workspaceMutationCount: number };
  processes: { captured: boolean; root: { pid: number; startTicks: string; bootId: string } | null;
    journal: Array<{ pid: number; ppid: number; startTicks: string; bootId: string }>; live: number[] };
}
export function assertCursorRemoteSnapshot(snapshot: CursorRemoteSnapshot, binding: CursorRemoteBinding): void {
  if (!snapshot.complete || !snapshot.watcher.complete || (!Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs < 0)
    || !Object.keys(binding).every(key => snapshot.binding[key as keyof CursorRemoteBinding] === binding[key as keyof CursorRemoteBinding])
    || !isAbsolute(binding.remoteCwd) || posix.normalize(binding.remoteCwd) !== binding.remoteCwd || !/^.+@sha256:[a-f0-9]{64}$/u.test(binding.image) || ![binding.companyId, binding.environmentId, binding.runId, binding.leaseId, binding.sandboxId].every(id)) throw new Error("Cursor remote evidence lacks exact complete lease authority");
  const entries = Object.entries(snapshot.workspace);
  if (entries.length > 2048 || entries.some(([name, value]) => !name || name.startsWith("/") || /[\\\u0000-\u001f\u007f]/u.test(name)
    || name.replace(/\/$/u, "").split("/").some(part => !part || part === "." || part === "..")
    || (value !== "directory" && !/^sha256:[a-f0-9]{64}$/u.test(value)))) throw new Error("Cursor remote workspace evidence is malformed or unbounded");
  if (![snapshot.watcher.targetMutationCount, snapshot.watcher.workspaceMutationCount].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Cursor remote watcher receipt is malformed");
}
export function hasCursorRemoteRetirement(snapshot: CursorRemoteSnapshot, binding: CursorRemoteBinding): boolean {
  try { assertCursorRemoteSnapshot(snapshot, binding); } catch { return false; }
  const p = snapshot.processes, root = p.root;
  return p.captured && root !== null && Number.isSafeInteger(root.pid) && root.pid > 1 && /^\d+$/u.test(root.startTicks)
    && /^[a-f0-9-]{36}$/iu.test(root.bootId) && p.live.length === 0 && p.journal.length > 0
    && p.journal.some(item => item.pid === root.pid && item.startTicks === root.startTicks && item.bootId === root.bootId)
    && p.journal.every(item => Number.isSafeInteger(item.pid) && item.pid > 1 && /^\d+$/u.test(item.startTicks) && item.bootId === root.bootId);
}

export function cursorRemoteDeniedSample(snapshot: CursorRemoteSnapshot, binding: CursorRemoteBinding, relative: string, phase: string,
  expectedParent?: { dev: string; ino: string }) {
  assertCursorRemoteSnapshot(snapshot, binding);
  if (!/^[a-zA-Z0-9_-]+\.txt$/u.test(relative)) throw new Error("Invalid remote denied target");
  const target = snapshot.targets[relative];
  if (!target || !target.complete || !/^\d+$/u.test(target.parent.dev) || !/^\d+$/u.test(target.parent.ino)
    || !Number.isSafeInteger(target.mutationCount) || target.mutationCount !== 0
    || (expectedParent && (target.parent.dev !== expectedParent.dev || target.parent.ino !== expectedParent.ino))) throw new Error("Cursor remote denied target observation is incomplete or changed");
  return { phase, path: posix.join(binding.remoteCwd, relative), absent: target.absent === true && target.sha256 === null,
    observedAt: snapshot.observedAtMs, parent: target.parent };
}

export function hasCursorRemoteWorkspaceUnchanged(snapshot: CursorRemoteSnapshot, baseline: CursorRemoteSnapshot): boolean {
  try { assertCursorRemoteSnapshot(snapshot, baseline.binding); assertCursorRemoteSnapshot(baseline, baseline.binding); } catch { return false; }
  return snapshot.observedAtMs >= baseline.observedAtMs
    && snapshot.watcher.workspaceMutationCount === baseline.watcher.workspaceMutationCount
    && JSON.stringify(Object.entries(snapshot.workspace).sort()) === JSON.stringify(Object.entries(baseline.workspace).sort());
}
