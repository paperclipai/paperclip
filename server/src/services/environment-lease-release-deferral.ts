import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { ProviderResourceDisposition } from "./environment-runtime.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";

export const LEASE_RELEASE_DEFERRAL_KEY = "releaseDeferral";
const LEASE_RELEASE_RETRY_BASE_MS = 30_000;
const LEASE_RELEASE_RETRY_MAX_MS = 15 * 60_000;
export const LEASE_RELEASE_MAX_ATTEMPTS = 10;

export type LeaseReleaseDeferral = {
  reason: string;
  attempts: number;
  retryAt: string;
  exhaustedAt?: string;
  providerResourceDisposition: ProviderResourceDisposition | null;
};

export function readLeaseReleaseDeferral(metadata: Record<string, unknown> | null | undefined): LeaseReleaseDeferral | null {
  const value = metadata?.[LEASE_RELEASE_DEFERRAL_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deferral = value as Record<string, unknown>;
  if (typeof deferral.reason !== "string" || typeof deferral.retryAt !== "string" || typeof deferral.attempts !== "number") return null;
  return deferral as LeaseReleaseDeferral;
}

export function leaseReleaseRetryDelayMs(attempts: number) {
  return Math.min(LEASE_RELEASE_RETRY_MAX_MS, LEASE_RELEASE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
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
