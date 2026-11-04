import { accessApi } from "../api/access";
import { detachInflightGet } from "../api/client";
import { heartbeatsApi } from "../api/heartbeats";
import { clearPendingSend, pendingSendKeyFor, readPendingSend, writePendingSend, type PendingSend } from "./pending-send";
import { createUuid } from "./uuid";

type StopScope = { runId: string; companyId: string; actorUserId: string | null };
const memoryRequests = new Map<string, PendingSend<StopScope>>();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function stopFailedNativeRun(runId: string, companyId: string) {
  detachInflightGet(`/heartbeat-runs/${runId}`);
  detachInflightGet("/cli-auth/me");
  const [run, access] = await Promise.all([heartbeatsApi.get(runId), accessApi.getCurrentBoardAccess()]);
  if (run.id !== runId || run.companyId !== companyId) throw new Error("Stop was not accepted because the run changed.");
  const actorUserId = access.source === "local_implicit" ? null : access.userId;
  if (actorUserId !== null && !actorUserId) throw new Error("Stop was not accepted because your session changed.");
  const key = pendingSendKeyFor(`paperclip:native-run-stop:${companyId}:${runId}`, actorUserId ?? "local-board");
  const matchesScope = (value: unknown): value is StopScope => {
    const scope = record(value);
    return scope.runId === runId && scope.companyId === companyId && scope.actorUserId === actorUserId;
  };
  const startup = record(run.resultJson?.startupCancellation);
  const canonicalId = startup.cancellationRequestId;
  if (canonicalId !== undefined) {
    const actor = record(startup.requestedBy);
    if (actor.type !== "board" || actor.userId !== actorUserId) throw new Error("This Stop request belongs to another operator.");
    if (typeof canonicalId !== "string" || !uuid.test(canonicalId)) throw new Error("Stop was not accepted because the run changed.");
  }
  const saved = readPendingSend(key, matchesScope, "session") ?? memoryRequests.get(key);
  const id = typeof canonicalId === "string" ? canonicalId
    : saved && matchesScope(saved.payload) && uuid.test(saved.idempotencyKey) ? saved.idempotencyKey : createUuid();
  const pending = { idempotencyKey: id, payload: { runId, companyId, actorUserId }, createdAt: saved?.createdAt ?? Date.now() };
  memoryRequests.set(key, pending);
  writePendingSend(key, pending, "session");
  const result = await heartbeatsApi.cancel(runId, { cancellationRequestId: id });
  clearPendingSend(key, id, "session");
  if (memoryRequests.get(key)?.idempotencyKey === id) memoryRequests.delete(key);
  return result;
}
