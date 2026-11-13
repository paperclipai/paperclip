import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";

/** Public durable permission/tool evidence. Independent filesystem and process
 * proofs remain required; assistant text can never satisfy this oracle. */
type Row = Record<string, any>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export interface PiDeniedPermission { runId: string; turnId: string; requestId: string; toolCallId: string; target: string }
export function piPermissionRequests(rows: readonly unknown[], runId: string): Array<{ row: Row; event: Row; request: Row }> {
  return rows.map(record).flatMap(row => {
    const event = record(record(row.payload).prpEvent), request = record(record(event.payload).request), origin = record(request.origin);
    if (row.eventType !== "runtime_request.created" || event.eventType !== row.eventType || row.runId !== runId || event.runId !== runId
      || row.protocolSchemaVersion !== 1 || event.schemaVersion !== 1 || event.schema !== "paperclip.prp.event.v1" || event.sourceKind !== "runner"
      || (!Number.isSafeInteger(row.seq) || row.seq < 1) || typeof event.turnId !== "string" || !event.turnId || request.turnId !== event.turnId
      || request.type !== "permission" || request.status !== "pending" || !hasAcpxNativeOrigin(origin, "pi", "session/request_permission")
      || typeof request.requestId !== "string" || !request.requestId || typeof request.details?.toolCallId !== "string" || !request.details.toolCallId
      || !Array.isArray(request.choices) || !request.choices.some((choice: unknown) => record(choice).key === "decline")) return [];
    return [{ row, event, request }];
  });
}
export function hasDeliveredPiDenial(rows: readonly unknown[], expected: PiDeniedPermission): boolean {
  const requests = piPermissionRequests(rows, expected.runId).filter(value => value.request.requestId === expected.requestId);
  if (requests.length !== 1) return false;
  const created = requests[0]!;
  if (created.event.turnId !== expected.turnId || created.request.details.toolCallId !== expected.toolCallId) return false;
  const events = rows.map(record).map(row => ({ row, event: record(record(row.payload).prpEvent) }))
    .filter(({ row, event }) => row.runId === expected.runId && event.runId === expected.runId && event.turnId === expected.turnId
      && row.eventType === event.eventType && row.protocolSchemaVersion === 1 && event.schemaVersion === 1
      && event.schema === "paperclip.prp.event.v1" && event.sourceKind === "runner" && Number.isSafeInteger(row.seq) && row.seq >= 1);
  const resolutions = events.filter(({ event }) => ["runtime_request.resolved", "runtime_request.expired", "runtime_request.cancelled"].includes(event.eventType) && event.payload?.requestId === expected.requestId);
  if (resolutions.length !== 1 || resolutions[0]!.event.eventType !== "runtime_request.resolved" || resolutions[0]!.event.payload.action !== "decline"
    || resolutions[0]!.event.payload.turnId !== expected.turnId || resolutions[0]!.row.seq <= created.row.seq) return false;
  const completed = events.filter(({ event }) => event.eventType === "tool.execution.completed" && event.payload?.transport === "builtin" && event.payload?.operation === "edit");
  return completed.length === 1 && completed.every(({ row, event }) => row.seq > created.row.seq && event.payload.schema === "paperclip.tool.execution.v1"
    && event.payload.executionId === expected.toolCallId && event.payload.name === "write" && event.payload.status === "failed"
    && event.payload.target === expected.target && typeof event.payload.output === "string" && event.payload.output.includes("Pi operation was denied or cancelled"));
}

/** The shared remote observer supplies these facts directly from the bound
 * sandbox. Missing watcher/process coverage is never treated as an absent file. */
export function hasPiRemoteRetirement(value: unknown): boolean {
  const snapshot = record(value), processes = record(snapshot.processes), root = record(processes.root);
  return snapshot.complete === true && record(snapshot.watcher).complete === true && Number.isFinite(snapshot.observedAtMs)
    && processes.captured === true && Number.isSafeInteger(root.pid) && root.pid > 1
    && typeof root.startTicks === "string" && root.startTicks.length > 0 && typeof root.bootId === "string" && root.bootId.length > 0
    && Array.isArray(processes.journal) && processes.journal.length > 0
    && processes.journal.some((entry: Row) => entry.pid === root.pid && entry.startTicks === root.startTicks && entry.bootId === root.bootId)
    && Array.isArray(processes.live) && processes.live.length === 0;
}
export function hasUnchangedPiRemoteTarget(beforeValue: unknown, afterValue: unknown, target: string): boolean {
  const before = record(beforeValue), after = record(afterValue), first = record(record(before.targets)[target]), last = record(record(after.targets)[target]);
  return before.complete === true && hasPiRemoteRetirement(after) && before.observedAtMs <= after.observedAtMs
    && first.complete === true && last.complete === true && record(after.watcher).complete === true
    && first.mutationCount === 0 && last.mutationCount === 0
    && typeof first.absent === "boolean" && first.absent === last.absent && first.sha256 === last.sha256
    && (first.absent ? first.sha256 === null : typeof first.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(first.sha256))
    && record(first.parent).dev !== undefined && record(first.parent).ino !== undefined
    && first.parent.dev === record(last.parent).dev && first.parent.ino === record(last.parent).ino;
}
