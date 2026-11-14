import { createHash } from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { retiredReusableLeasePredecessors } from "../environment-lease-handoff.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain } from "../sandbox-stop-and-retain.js";
import { LEGACY_WORKSPACE_RECOVERY_KEY, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "../workspace-restore-recovery-state.js";
import { readNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { nativeWorkspaceExportPendingForLease, nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";

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
 *
 * A settled workspace-restore hold is the other retired source. The hold
 * changed the lease to `retain_on_failure`, which reuse never selects, and
 * stopped the sandbox under a stop-only receipt that permits no provider work.
 * Releases before the hold settlement restored warm reuse left such rows
 * stranded, so this also unsticks state saved by those releases.
 *
 * An idle warm source is the third. Its own run is terminal, no run holds the
 * lease, and no workspace export is pending on the sandbox, so nothing can do
 * provider work there. Reuse skips such a lease while the previous run's
 * workspace export is still in flight, and the next run then gets a new lease.
 * With no provider work after the backup, the idle sandbox holds exactly the
 * checkpointed state, so restoring the backup continues the same session. The
 * source is claimed as superseded first, so it is never resumed with that
 * older state after the restored lease moves on.
 */
export async function retiredSourceAuthorizesNativeBackupRestore(db: Db, input: {
  companyId: string;
  currentRunId: string;
  normalizedSessionId: string;
  manifest: { sourceProviderLeaseId: string; runnerInstanceId: string; normalizedSessionId: string };
  manifestSha256: string;
  /** The allocation the backup restores into. Its own missing state never proves a retired source. */
  targetProviderLeaseId?: string | null;
}): Promise<boolean> {
  if (!input.manifest.sourceProviderLeaseId || input.manifest.normalizedSessionId !== input.normalizedSessionId
    || input.manifest.sourceProviderLeaseId === input.targetProviderLeaseId) return false;
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
  const destroyed = ["expired", "failed"].includes(lease.status) && hasRemoteTerminationReceipt(lease)
    && termination?.state === "destroyed";
  const stamp = readNativeHarnessBackupStamp(lease.metadata?.nativeHarnessBackup, lease.providerLeaseId!);
  if (!stamp || stamp.manifestSha256 !== input.manifestSha256
    || stamp.normalizedSessionId !== input.normalizedSessionId
    || stamp.runnerInstanceId !== input.manifest.runnerInstanceId) return false;
  // A released lease can still be selected for resume; only a retired one is final.
  const idleSource = !destroyed && !await settledRestoreHoldRetiresSource(db, lease);
  if (idleSource && !await idleWarmSourceRetiresBackup(db, lease, input.currentRunId)) return false;
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
  if (later.length) return false;
  return !idleSource || await supersedeIdleWarmSource(db, lease, input);
}

export const SUPERSEDED_REUSABLE_SANDBOX_KEY = "reusableSandboxLeaseSuperseded";

/**
 * Claims an idle warm source before its backup is restored elsewhere. The
 * source still holds the checkpointed session, and the restored lease will
 * move past it, so the source must never be resumed again. Removing its reuse
 * scope makes the next acquisition for this workspace treat it as obsolete and
 * clean it up through the existing obsolete-lease path. The write is a
 * compare-and-swap on the checked row: a run that resumed or changed the lease
 * in the meantime wins, and the restore does not happen.
 */
async function supersedeIdleWarmSource(db: Db, lease: typeof environmentLeases.$inferSelect, input: {
  companyId: string; currentRunId: string; manifestSha256: string; targetProviderLeaseId?: string | null;
}) {
  const { reusableSandboxLease: scope, ...metadata } = lease.metadata ?? {};
  const [claimed] = await db.update(environmentLeases).set({
    metadata: { ...metadata, [SUPERSEDED_REUSABLE_SANDBOX_KEY]: {
      schema: "paperclip.reusable-sandbox-lease-superseded.v1", reason: "harness_backup_restored_elsewhere",
      supersededByRunId: input.currentRunId, supersededByProviderLeaseId: input.targetProviderLeaseId ?? null,
      manifestSha256: input.manifestSha256, reusableSandboxLease: scope ?? null, supersededAt: new Date().toISOString(),
    } },
    updatedAt: new Date(),
  }).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, lease.id),
    eq(environmentLeases.status, lease.status), eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!),
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
  )).returning({ id: environmentLeases.id });
  return Boolean(claimed);
}

const TERMINAL_SOURCE_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/**
 * A warm reusable lease whose run has ended and that no run holds. Its sandbox
 * may still be running, but only a run does provider work there, and the
 * caller's later-work check proves none did after the backup. A pending
 * workspace export or cleanup on the allocation keeps it ambiguous.
 */
async function idleWarmSourceRetiresBackup(db: Db, lease: typeof environmentLeases.$inferSelect, currentRunId: string) {
  if (lease.leasePolicy !== "reuse_by_environment" || !["released", "retained"].includes(lease.status)
    || !lease.heartbeatRunId || lease.heartbeatRunId === currentRunId
    || lease.metadata?.pendingCleanupInFlight === true
    // A restore hold or a pending shutdown settlement still protects the files; reuse skips these too.
    || Object.hasOwn(lease.metadata ?? {}, LEGACY_WORKSPACE_RECOVERY_KEY)
    || (lease.metadata?.legacyShutdownWorkspaceSettlement as { state?: unknown } | undefined)?.state === "pending") return false;
  const [run] = await db.select({ sourceRunStatus: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId))).limit(1);
  if (!run || !TERMINAL_SOURCE_RUN_STATUSES.has(run.sourceRunStatus)) return false;
  return !await nativeWorkspaceExportPendingForResource(db, lease, currentRunId);
}

/**
 * A stopped, released lease is retired only when it is a workspace-restore hold
 * that nothing can select for resume: `retain_on_failure` with the hold's own
 * marker, a confirmed stop-and-retain receipt whose state is `stopped`, and no
 * unsaved writer or pending native workspace export bound to the allocation.
 * A stopped `reuse_by_environment` lease stays ambiguous and fails closed.
 */
async function settledRestoreHoldRetiresSource(db: Db, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  const marker = lease.metadata?.workspaceRestoreRecovery as { schema?: unknown; runId?: unknown } | undefined;
  if (lease.leasePolicy !== "retain_on_failure" || lease.status !== "released" || !lease.heartbeatRunId
    || marker?.schema !== LEGACY_WORKSPACE_RECOVERY_SCHEMA || marker.runId !== lease.heartbeatRunId) return false;
  // Provider expiry cannot revive the allocation; it only makes the source
  // more final. Every other stop-and-retain receipt check stays strict.
  if (!hasConfirmedSandboxStopAndRetain({ ...lease, expiresAt: null })) return false;
  // Includes the dirty remote writer source (`preparedRemoteWorkspaceSource`).
  return !await nativeWorkspaceExportPendingForLease(db, lease);
}
