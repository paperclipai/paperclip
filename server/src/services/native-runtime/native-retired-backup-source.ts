import { createHash } from "node:crypto";
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { retiredReusableLeasePredecessors } from "../environment-lease-handoff.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { readNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";

/** Durable run events that prove a provider session did work in a run. */
export const NATIVE_PROVIDER_DURABLE_EVENT_TYPES = new Set([
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "turn.started",
  "provider.event",
  "provider.rpc_result",
]);

export function nativeHarnessBackupManifestSha256(manifestBytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
}

/**
 * A created sandbox normally refuses a per-turn backup that has no recorded
 * reusable lease, because the backup's source sandbox may still hold newer
 * provider state. That ambiguity is absent when Paperclip itself destroyed the
 * source sandbox: the provider confirmed the termination, the source lease's
 * stamp names exactly this backup, and no provider work for the session was
 * recorded after the backup completed. This is the same proof a confirmed
 * replacement relies on, reached through a lease that was retired first.
 */
export async function retiredSourceAuthorizesNativeBackupRestore(db: Db, input: {
  companyId: string;
  currentRunId: string;
  normalizedSessionId: string;
  manifest: { sourceProviderLeaseId: string; runnerInstanceId: string; normalizedSessionId: string };
  manifestSha256: string;
}): Promise<boolean> {
  if (!input.manifest.sourceProviderLeaseId || input.manifest.normalizedSessionId !== input.normalizedSessionId) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.providerLeaseId, input.manifest.sourceProviderLeaseId),
  ));
  const source = leases.filter(lease => lease.companyId === input.companyId
    && lease.providerLeaseId === input.manifest.sourceProviderLeaseId);
  const tips = source.filter(lease => !Object.hasOwn(lease.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return false;
  const lease = tips[0]!;
  if (!retiredReusableLeasePredecessors(lease, source.filter(row => row.id !== lease.id))) return false;
  const termination = lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined;
  // A released lease can still be selected for resume; only a retired one is final.
  if (!["expired", "failed"].includes(lease.status) || !hasRemoteTerminationReceipt(lease)
    || termination?.state !== "destroyed") return false;
  const stamp = readNativeHarnessBackupStamp(lease.metadata?.nativeHarnessBackup, lease.providerLeaseId!);
  if (!stamp || stamp.manifestSha256 !== input.manifestSha256
    || stamp.normalizedSessionId !== input.normalizedSessionId
    || stamp.runnerInstanceId !== input.manifest.runnerInstanceId) return false;
  // Provider work recorded after the checkpoint means the destroyed sandbox
  // held newer state than this backup. Restoring would silently rewind it.
  const later = await db.select({ runId: heartbeatRunEvents.runId }).from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
      ne(heartbeatRuns.id, input.currentRunId),
      inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]),
      gt(heartbeatRunEvents.createdAt, new Date(stamp.completedAt)),
    )).limit(1);
  return later.length === 0;
}
