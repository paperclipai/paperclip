import { notifyRetainedNativeSessionCleanup } from "./retained-native-session-cleanup-notifications.js";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { isBuiltinSandboxProvider } from "./sandbox-provider-runtime.js";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasNativeWorkspaceExportResume, readNativeWorkspaceExportResume, settleNativeWorkspaceExportResume } from "./native-runtime/native-workspace-export-resume.js";
import type { SandboxAbsenceProof } from "./sandbox-absence-proof.js";

type Lease = Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata">;
export const SANDBOX_STOP_AND_RETAIN_KEY = "sandboxStopAndRetain";
/** Top-level marker an ownership settle leaves on a lease whose sandbox it
 * stopped and kept. It outlives the stop intent, so the retained orphan can
 * be destroyed once nothing references it. */
export const ORPHANED_SANDBOX_RECOVERY_KEY = "orphanedRunLeaseRecovery";

/** A successful stop is not by itself proof that the allocation was retained.
 * Require the dedicated stop-only dispatch receipt and its independent stop
 * confirmation, both bound to the original lease. No provider work is allowed. */
export function hasConfirmedSandboxStopAndRetain(lease: typeof environmentLeases.$inferSelect): boolean {
  const acquiredAt = lease.acquiredAt.getTime();
  const releasedAt = lease.releasedAt?.getTime();
  const expiresAt = lease.expiresAt?.getTime();
  if (!Number.isFinite(acquiredAt) || releasedAt === undefined || !Number.isFinite(releasedAt)
    || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return false;
  const value = lease.metadata?.sandboxStopAndRetainReceipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const termination = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  if (lease.status !== "released" || !hasRemoteTerminationReceipt(lease)
    || termination?.state !== "stopped" || hasStopOnlyCleanup(lease)
    || lease.metadata?.pendingCleanupInFlight === true
    || receipt.schema !== "paperclip.sandbox-stop-and-retain-receipt.v1"
    || receipt.companyId !== lease.companyId || receipt.runId !== lease.heartbeatRunId
    || receipt.leaseId !== lease.id || receipt.provider !== lease.provider
    || receipt.providerLeaseId !== lease.providerLeaseId
    || typeof receipt.requestId !== "string" || !receipt.requestId.trim()
    || typeof receipt.confirmedAt !== "string" || receipt.confirmedAt !== termination.confirmedAt) return false;
  const confirmedAt = Date.parse(receipt.confirmedAt);
  if (!Number.isFinite(confirmedAt) || confirmedAt < acquiredAt || confirmedAt > releasedAt) return false;
  if (receipt.builtinProvider !== undefined) {
    return receipt.builtinProvider === lease.provider && isBuiltinSandboxProvider(lease.provider!)
      && receipt.method === "builtin.stopLease" && receipt.pluginId === undefined
      && lease.metadata?.pluginId == null && !lease.metadata?.sandboxProviderPlugin;
  }
  return receipt.method === "environmentStopLease" && typeof receipt.pluginId === "string"
    && !!receipt.pluginId.trim() && receipt.pluginId === lease.metadata?.pluginId;
}

export function hasStopOnlyCleanup(lease: Pick<Lease, "metadata">): boolean {
  return hasNativeWorkspaceExportResume(lease)
    || Object.prototype.hasOwnProperty.call(lease.metadata ?? {}, SANDBOX_STOP_AND_RETAIN_KEY);
}

export function stopOnlyCleanupKey(lease: Pick<Lease, "metadata">) {
  return hasNativeWorkspaceExportResume(lease) ? "nativeWorkspaceExportResume" : SANDBOX_STOP_AND_RETAIN_KEY;
}

export function readStopOnlyCleanup(lease: Lease) {
  if (hasNativeWorkspaceExportResume(lease)) return readNativeWorkspaceExportResume(lease);
  const value = lease.metadata?.[SANDBOX_STOP_AND_RETAIN_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  if (intent.schema !== "paperclip.sandbox-stop-and-retain.v1"
    || intent.companyId !== lease.companyId || intent.runId !== lease.heartbeatRunId || !lease.heartbeatRunId
    || intent.leaseId !== lease.id || intent.provider !== lease.provider || !lease.provider
    || intent.providerLeaseId !== lease.providerLeaseId || !lease.providerLeaseId
    || typeof intent.requestId !== "string" || !intent.requestId) return null;
  if (intent.builtinProvider !== undefined) {
    if (intent.builtinProvider !== lease.provider || !isBuiltinSandboxProvider(lease.provider)
      || intent.pluginId !== undefined || lease.metadata?.pluginId != null || lease.metadata?.sandboxProviderPlugin) return null;
    return { ...intent, requestId: intent.requestId, pluginId: null, builtinProvider: lease.provider };
  }
  if (typeof intent.pluginId !== "string" || !intent.pluginId || intent.pluginId !== lease.metadata?.pluginId) return null;
  return { ...intent, requestId: intent.requestId, pluginId: intent.pluginId, builtinProvider: null };
}

/** Persist before provider dispatch so an older worker or a restart cannot turn
 * an explicit stop into ordinary destructive release. Invalid pins stay pending.
 * `recovery` marks an ownership settle on the intent and on the lease
 * (`ORPHANED_SANDBOX_RECOVERY_KEY`); the pending-cleanup sweep dispatches such
 * a stop's first attempt without its retry backoff. */
export async function prepareSandboxStopAndRetain(db: Db, lease: Lease, recovery?: Record<string, unknown>) {
  return prepareStopAndRetain(db, lease, "active", recovery);
}

/** Historical release rows can lack a stop receipt. Re-inspect the exact
 * recorded allocation using stop-only dispatch; never infer that it stopped.
 * The preservation owner verifies source eligibility and exclusive allocation
 * ownership before calling. Lease reuse policy does not authorize destruction. */
export async function prepareHistoricalSandboxStopVerification(db: Db, lease: typeof environmentLeases.$inferSelect) {
  if (lease.status !== "released" || !lease.heartbeatRunId || !lease.providerLeaseId ||
      lease.metadata?.pendingCleanupInFlight === true)
    return null;
  return prepareStopAndRetain(db, lease, "released");
}

/** A repair-only resume invalidates the old stop receipt atomically. This is
 * separate from ordinary release; a released timestamp alone cannot grant it.
 * Source eligibility belongs to the preservation owner, including accepted
 * native exports whose original allocation policy is reusable. */
export async function prepareStoppedSandboxForRecovery(db: Db, lease: typeof environmentLeases.$inferSelect) {
  if (!hasRemoteTerminationReceipt(lease) || lease.status !== "released"
    || (lease.metadata?.remoteExecutionTermination as { state?: string })?.state !== "stopped") return null;
  const { remoteExecutionTermination, sandboxStopAndRetainReceipt } = lease.metadata!;
  return prepareStopAndRetain(db, lease, "released", { priorStop: { remoteExecutionTermination,
    ...(sandboxStopAndRetainReceipt === undefined ? {} : { sandboxStopAndRetainReceipt }) } });
}

export async function confirmSandboxRecoveryRestart(db: Db, lease: typeof environmentLeases.$inferSelect, options: { attemptId: string }) {
  if (!suspendedSandboxStop(lease)) return lease;
  const [updated] = await db.update(environmentLeases).set({ updatedAt: new Date(),
    metadata: sql`jsonb_set(${environmentLeases.metadata}, '{sandboxStopAndRetain}', (${environmentLeases.metadata}->'sandboxStopAndRetain') - 'priorStop')`,
  }).where(stopOnlyAttempt(lease, options.attemptId)).returning();
  return updated ?? null;
}

export async function restoreSandboxStopAfterFailedRestart(db: Db, lease: typeof environmentLeases.$inferSelect, options: { attemptId: string }) {
  const prior = suspendedSandboxStop(lease);
  if (!prior) return null;
  const restored = { remoteExecutionTermination: prior.remoteExecutionTermination,
    ...(prior.sandboxStopAndRetainReceipt === undefined ? {} : { sandboxStopAndRetainReceipt: prior.sandboxStopAndRetainReceipt }) };
  if ((restored.remoteExecutionTermination as { state?: unknown } | undefined)?.state !== "stopped"
    || !hasRemoteTerminationReceipt({ ...lease, status: "released", cleanupStatus: "success", metadata: { ...lease.metadata, ...restored } })) return null;
  const now = new Date();
  const [updated] = await writeEnvironmentCleanup(db, async tx => {
    await notifyRetainedNativeSessionCleanup(tx, { companyId: lease.companyId, runId: lease.heartbeatRunId! });
    return tx.update(environmentLeases).set({
      status: "released", cleanupStatus: "success", failureReason: null, updatedAt: now,
      metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination' - 'sandboxStopAndRetain' - 'sandboxStopAndRetainReceipt') || ${JSON.stringify({
        ...restored, pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      })}::jsonb`,
    }).where(stopOnlyAttempt(lease, options.attemptId)).returning();
  }, { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined });
  return updated ?? null;
}

function suspendedSandboxStop(lease: typeof environmentLeases.$inferSelect) {
  if (hasNativeWorkspaceExportResume(lease) || !readStopOnlyCleanup(lease)) return null;
  const prior = (lease.metadata![SANDBOX_STOP_AND_RETAIN_KEY] as Record<string, unknown>).priorStop;
  return prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : null;
}

function stopOnlyAttempt(lease: Lease, attemptId: string) {
  return and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.provider, lease.provider!),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), eq(environmentLeases.status, "pending_cleanup"),
    sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${attemptId}`,
    sql`${environmentLeases.metadata}->'sandboxStopAndRetain' = ${JSON.stringify(lease.metadata?.[SANDBOX_STOP_AND_RETAIN_KEY])}::jsonb`,
    sql`${environmentLeases.metadata}->>'pluginId' is not distinct from ${readStopOnlyCleanup(lease)?.pluginId ?? null}`);
}

/** A warm sandbox kept running for reuse whose task moved to another workspace:
 * stop it through the stop-only contract so the provider confirms the stop
 * before anything destroys it. The ownership settle verifies the move. */
export async function prepareSupersededWarmSandboxStop(db: Db, lease: typeof environmentLeases.$inferSelect, recovery: Record<string, unknown>) {
  if (lease.status !== "retained" || lease.leasePolicy !== "reuse_by_environment" || !lease.heartbeatRunId
    || !lease.providerLeaseId || lease.metadata?.pendingCleanupInFlight === true) return null;
  return prepareStopAndRetain(db, lease, "retained", recovery);
}

async function prepareStopAndRetain(db: Db, lease: Lease, fromStatus: "active" | "released" | "retained", recovery: Record<string, unknown> = {}) {
  const requestId = randomUUID(), now = new Date();
  const intent = { schema: "paperclip.sandbox-stop-and-retain.v1", requestId,
    companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId,
    ...(lease.provider && isBuiltinSandboxProvider(lease.provider) && !lease.metadata?.sandboxProviderPlugin && lease.metadata?.pluginId == null
      ? { builtinProvider: lease.provider } : { pluginId: lease.metadata?.pluginId }), ...recovery };
  const [updated] = await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
    status: "pending_cleanup", cleanupStatus: "failed", failureReason: "sandbox_stop_pending", releasedAt: now, updatedAt: now,
    metadata: sql`(coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'remoteExecutionTermination' - 'sandboxStopAndRetainReceipt') || ${JSON.stringify({
      [SANDBOX_STOP_AND_RETAIN_KEY]: intent, pendingCleanupAttemptId: requestId,
      ...(fromStatus === "active" && Object.keys(recovery).length
        ? { [ORPHANED_SANDBOX_RECOVERY_KEY]: { ...recovery, runId: lease.heartbeatRunId, recoveredAt: now.toISOString() } } : {}),
      pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0, pendingCleanupRetryCapWarned: false,
    })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.status, fromStatus),
    sql`${environmentLeases.provider} is not distinct from ${lease.provider}`,
    sql`${environmentLeases.providerLeaseId} is not distinct from ${lease.providerLeaseId}`,
    sql`${environmentLeases.metadata} is not distinct from ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`,
  )).returning(), { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined });
  return updated ?? null;
}

export async function settleStopOnlyCleanup(db: Db, lease: Lease, options: { attemptId: string; receipt?: unknown }) {
  if (hasNativeWorkspaceExportResume(lease)) return settleNativeWorkspaceExportResume(db, lease, options);
  const intent = readStopOnlyCleanup(lease);
  if (!intent) return null;
  const receipt = remoteTerminationReceipt(lease, options.receipt), stopped = receipt?.state === "stopped";
  const now = new Date();
  const removeIntent: SQL = stopped ? sql`- 'sandboxStopAndRetain'` : sql``;
  const recordedIntent = lease.metadata?.[SANDBOX_STOP_AND_RETAIN_KEY] as Record<string, unknown> | undefined;
  const legacyOrphan = stopped && recordedIntent?.recoveredOrphanedRunLease === true && !lease.metadata?.[ORPHANED_SANDBOX_RECOVERY_KEY]
    ? { [ORPHANED_SANDBOX_RECOVERY_KEY]: { recoveredOrphanedRunLease: true, ownerProof: recordedIntent.ownerProof ?? null,
      runId: lease.heartbeatRunId, recoveredAt: now.toISOString(), fromStopIntent: true } } : {};
  const [updated] = await writeEnvironmentCleanup(db, async tx => {
    if (stopped) {
      await notifyRetainedNativeSessionCleanup(tx, { companyId: lease.companyId, runId: lease.heartbeatRunId! });
      // A stop receipt is new evidence for a save hold waiting on it.
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    }
    return tx.update(environmentLeases).set({
      status: stopped ? "released" : "pending_cleanup", cleanupStatus: stopped ? "success" : "failed",
      failureReason: stopped ? null : "sandbox_stop_pending",
      releasedAt: now, lastUsedAt: now, updatedAt: now,
      metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination' ${removeIntent}) || ${JSON.stringify({
        ...(stopped ? { remoteExecutionTermination: receipt, sandboxStopAndRetainReceipt: {
          schema: "paperclip.sandbox-stop-and-retain-receipt.v1", requestId: intent.requestId,
          companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
          provider: lease.provider, providerLeaseId: lease.providerLeaseId,
          ...(intent.pluginId ? { pluginId: intent.pluginId, method: "environmentStopLease" }
            : { builtinProvider: lease.provider, method: "builtin.stopLease" }),
          confirmedAt: receipt.confirmedAt,
        } } : {}),
        ...legacyOrphan,
        pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      })}::jsonb`,
    }).where(stopOnlyAttempt(lease, options.attemptId)).returning();
  }, { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined });
  return updated ?? null;
}

export async function settleAbsentSandbox(db: Db, lease: typeof environmentLeases.$inferSelect,
  evidence: { proof: SandboxAbsenceProof; receipt: string }) {
  const { proof } = evidence;
  if (proof.companyId !== lease.companyId || proof.runId !== lease.heartbeatRunId || proof.issueId !== lease.issueId
    || proof.leaseId !== lease.id || proof.provider !== lease.provider || proof.providerLeaseId !== lease.providerLeaseId) return false;
  const termination = remoteTerminationReceipt(lease, { providerLeaseId: proof.providerLeaseId, state: "destroyed" });
  if (!termination) return false;
  const now = new Date();
  const changed = await db.transaction(async tx => {
    await notifyRetainedNativeSessionCleanup(tx, { companyId: lease.companyId, runId: lease.heartbeatRunId! });
    return tx.update(environmentLeases).set({
      status: "released", cleanupStatus: "success", failureReason: "workspace_source_unavailable", releasedAt: now, updatedAt: now,
      metadata: sql`(${environmentLeases.metadata} - 'sandboxStopAndRetain' - 'nativeWorkspaceExportResume' - 'sandboxStopAndRetainReceipt') || ${JSON.stringify({
        remoteExecutionTermination: termination, sandboxAbsence: evidence,
        pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      })}::jsonb`,
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.providerLeaseId, proof.providerLeaseId),
      eq(environmentLeases.status, lease.status),
      sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = ${lease.heartbeatRunId}
        and ${heartbeatRuns.companyId} = ${lease.companyId}
        and ${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceFinalizationOwner,token}' = ${proof.ownerToken})`,
      sql`${environmentLeases.metadata} is not distinct from ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`,
    )).returning({ id: environmentLeases.id });
  });
  return changed.length === 1;
}
