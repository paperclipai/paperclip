import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeProviderLifecycle, type LifecycleRecord } from "./provider-lifecycle.js";

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
type Binding = { companyId: string; runId: string; agentId: string };
const TYPES = ["runtime_request.created", "runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired", "turn.completed"];

export class NativePermissionDeclinedError extends Error {
  constructor() {
    super("native_finalization_missing: session returned no semantic result; provider permission was declined; explicit direction is required");
    this.name = "NativePermissionDeclinedError";
  }
}

/** A committed user denial fences automatic disposition recovery. It does not
 * claim the provider received the response or prove absence of file effects. */
export function hasCompletedNativePermissionDecline(rows: readonly unknown[], binding: Binding, terminal: PrpEvent, provider: LifecycleRecord): boolean {
  const adapter = nativeProviderLifecycle(provider);
  if (!adapter) return false;
  if (terminal.eventType !== "turn.completed" || !terminal.turnId || !terminal.normalizedSessionId || !terminal.sourceInstanceId) return false;
  const selected = rows.map(record).map(row => ({ row, event: record(record(row.payload).prpEvent) })).filter(({ row, event }) =>
    row.companyId === binding.companyId && row.agentId === binding.agentId && row.runId === binding.runId
    && row.protocolSchemaVersion === 1 && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1
    && event.sourceKind === "runner" && event.runId === binding.runId && event.turnId === terminal.turnId
    && event.normalizedSessionId === terminal.normalizedSessionId && event.sourceInstanceId === terminal.sourceInstanceId
    && event.sourceEventId === row.sourceEventId && event.sourceInstanceId === row.sourceInstanceId && event.sourceSeq === row.sourceSeq
    && row.eventType === event.eventType && Number.isSafeInteger(row.seq) && Number.isSafeInteger(event.sourceSeq));
  const terminals = selected.filter(({ event }) => event.eventType === "turn.completed" && event.sourceEventId === terminal.sourceEventId);
  if (terminals.length !== 1) return false;
  const end = terminals[0]!;
  return selected.some(created => {
    if (created.event.eventType !== "runtime_request.created") return false;
    const request = record(record(created.event.payload).request);
    if (request.type !== "permission" || request.status !== "pending" || !request.requestId || request.turnId !== terminal.turnId
      || !adapter.isPermissionRequest(request)) return false;
    if (selected.filter(({ event }) => event.eventType === "runtime_request.created" && record(record(event.payload).request).requestId === request.requestId).length !== 1) return false;
    const outcomes = selected.filter(({ event }) => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.eventType)
      && record(event.payload).requestId === request.requestId);
    if (outcomes.length !== 1) return false;
    const resolved = outcomes[0]!, payload = record(resolved.event.payload);
    return resolved.event.eventType === "runtime_request.resolved" && payload.action === "decline"
      && payload.turnId === terminal.turnId && payload.requestKind === "permission_approval"
      && created.row.seq < resolved.row.seq && resolved.row.seq < end.row.seq
      && created.event.sourceSeq < resolved.event.sourceSeq && resolved.event.sourceSeq < end.event.sourceSeq;
  });
}

export async function readCompletedNativePermissionDecline(db: Db, binding: Binding, terminal: PrpEvent, provider: LifecycleRecord) {
  if (!nativeProviderLifecycle(provider)) return false;
  const rows = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, binding.companyId), eq(heartbeatRunEvents.runId, binding.runId), eq(heartbeatRunEvents.agentId, binding.agentId),
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' = ${terminal.turnId}`,
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'normalizedSessionId' = ${terminal.normalizedSessionId}`,
    eq(heartbeatRunEvents.sourceInstanceId, terminal.sourceInstanceId),
    inArray(heartbeatRunEvents.eventType, TYPES),
  )).orderBy(asc(heartbeatRunEvents.seq)).limit(1001);
  if (rows.length > 1000) throw new Error("native_event_replay_conflict: permission recovery proof exceeds control-event budget");
  return hasCompletedNativePermissionDecline(rows, binding, terminal, provider);
}
