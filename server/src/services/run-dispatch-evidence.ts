import { and, count, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

export const LEGACY_ADAPTER_ENTERED = "legacy.adapter_entered";
export const LEGACY_ADAPTER_ENTRY_ABANDONED = "legacy.adapter_entry_abandoned";

export const PROVIDER_DISPATCH_EVENT_TYPES = [
  "adapter.invoke", LEGACY_ADAPTER_ENTERED, PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
  "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
  "provider.event", "provider.rpc_result", "tool.execution.started",
];

const DISPATCH_EVENT_TYPES_PAST_ADAPTER_ENTRY =
  PROVIDER_DISPATCH_EVENT_TYPES.filter(eventType => eventType !== LEGACY_ADAPTER_ENTERED);

export async function hasProviderDispatchEvidence(db: Db, run: Run): Promise<boolean> {
  const scope = and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id));
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    scope,
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, DISPATCH_EVENT_TYPES_PAST_ADAPTER_ENTRY)),
  )).limit(1);
  if (execution) return true;
  const entries = await db.select({ eventType: heartbeatRunEvents.eventType, recorded: count() })
    .from(heartbeatRunEvents)
    .where(and(scope, inArray(heartbeatRunEvents.eventType, [LEGACY_ADAPTER_ENTERED, LEGACY_ADAPTER_ENTRY_ABANDONED])))
    .groupBy(heartbeatRunEvents.eventType);
  const tally = (eventType: string) => Number(entries.find(row => row.eventType === eventType)?.recorded ?? 0);
  return tally(LEGACY_ADAPTER_ENTERED) > tally(LEGACY_ADAPTER_ENTRY_ABANDONED);
}

export function readRunEnvironmentLeases(db: Db, run: Run) {
  return db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
}

export function leaseRetainsResources(lease: typeof environmentLeases.$inferSelect): boolean {
  return lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease);
}
