import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ProviderResourceDisposition } from "./environment-runtime.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";

export const LEASE_RELEASE_DEFERRAL_KEY = "releaseDeferral";
const LEASE_RELEASE_RETRY_BASE_MS = 30_000;
const LEASE_RELEASE_RETRY_MAX_MS = 15 * 60_000;
export const LEASE_RELEASE_FAST_ATTEMPTS = 6;
export const LEASE_RELEASE_SLOW_RETRY_MS = 60 * 60_000;

export type LeaseReleaseDeferral = {
  reason: string;
  attempts: number;
  retryAt: string;
  failingSince: string;
  trigger?: string;
  providerResourceDisposition: ProviderResourceDisposition | null;
};

const retriedThisProcess = new Set<string>();

export function leaseReleaseRetriedThisProcess(leaseId: string) {
  return retriedThisProcess.has(leaseId);
}

export function markLeaseReleaseRetriedThisProcess(leaseId: string) {
  retriedThisProcess.add(leaseId);
}

export function readLeaseReleaseDeferral(metadata: Record<string, unknown> | null | undefined): LeaseReleaseDeferral | null {
  const value = metadata?.[LEASE_RELEASE_DEFERRAL_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deferral = value as Record<string, unknown>;
  if (typeof deferral.reason !== "string" || typeof deferral.retryAt !== "string" || typeof deferral.attempts !== "number") return null;
  return deferral as LeaseReleaseDeferral;
}

export function leaseReleaseRetryDelayMs(attempts: number) {
  if (attempts > LEASE_RELEASE_FAST_ATTEMPTS) return LEASE_RELEASE_SLOW_RETRY_MS;
  return Math.min(LEASE_RELEASE_RETRY_MAX_MS, LEASE_RELEASE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export async function wakeStoppingAgentLifecycle(tx: Pick<Db, "update">, agentId: string) {
  const woken = await tx.update(agents).set({ lifecycleOperation: sql`(${agents.lifecycleOperation} - 'retryAt')
    || case when ${agents.lifecycleOperation} ? 'leaseOwner' then '{"recheckRequested":true}'::jsonb else '{}'::jsonb end` })
    .where(and(eq(agents.id, agentId), inArray(agents.lifecycleState, ["pausing", "terminating", "cleaning_up"]),
      sql`(${agents.lifecycleOperation} ? 'retryAt' or ${agents.lifecycleOperation} ? 'leaseOwner')`))
    .returning({ id: agents.id });
  if (woken.length > 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
  return woken.length > 0;
}

export async function settleUnchangedNativeWorkspace(db: Db, runId: string, companyId: string): Promise<boolean> {
  const settled = await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`(${heartbeatRuns.runnerProfileJson} - 'nativeWorkspaceSync')
      || jsonb_build_object('nativeWorkspaceSyncReleasedUnchanged', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync')`,
  }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "cancelled"),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
    sql`coalesce(${heartbeatRuns.runnerProfileJson}->'remoteWorkspace', 'null'::jsonb) = 'null'::jsonb`,
    sql`not exists (select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${companyId}
      and ${environmentLeases.heartbeatRunId} = ${runId} and (${environmentLeases.status} in ('active', 'pending_cleanup', 'retained')
        or coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? 'sandboxStopAndRetainReceipt'))`))
    .returning({ id: heartbeatRuns.id });
  return settled.length > 0;
}

export async function nativeRunNeverLaunchedRunner(db: Db, runId: string, companyId: string): Promise<boolean> {
  const [run] = await db.select({ processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  if (!run || run.processPid || run.processGroupId) return false;
  const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), executionStartedEventPredicate(),
  )).limit(1);
  return !started;
}
