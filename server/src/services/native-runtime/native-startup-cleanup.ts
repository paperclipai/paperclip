import { and, eq, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";

export const NATIVE_STARTUP_CLEANUP_PENDING = "native_startup_cleanup_pending";

export class NativeStartupCleanupPendingError extends Error {
  constructor(readonly contextId: string, readonly deadlineAtMs: number, readonly leaseOwner: string,
    readonly requiresPreparationStop: boolean, readonly leaseId?: string) {
    super(NATIVE_STARTUP_CLEANUP_PENDING);
    this.name = "NativeStartupCleanupPendingError";
  }
}

type Run = typeof heartbeatRuns.$inferSelect;
export interface NativeStartupCleanup {
  schema: "paperclip.native-startup-cleanup.v1";
  companyId: string; agentId: string; runId: string;
  contextId: string; deadlineAtMs: number; leaseOwner: string;
  controllerGeneration: number; attempt: number; leaseId: string; taskId: string;
  requiresPreparationStop: boolean; state: "pending" | "complete"; auditId: string;
}

export function readNativeStartupCleanup(run: Pick<Run, "id" | "companyId" | "agentId" | "resultJson">): NativeStartupCleanup | null {
  const marker = run.resultJson?.nativeStartupCleanup as NativeStartupCleanup | undefined;
  return marker?.schema === "paperclip.native-startup-cleanup.v1" && marker.companyId === run.companyId &&
    marker.runId === run.id && marker.agentId === run.agentId && ["contextId", "leaseOwner", "leaseId", "taskId", "auditId"].every(key =>
      typeof marker[key as keyof NativeStartupCleanup] === "string" && String(marker[key as keyof NativeStartupCleanup]).length > 0) &&
    Number.isSafeInteger(marker.deadlineAtMs) && Number.isSafeInteger(marker.controllerGeneration) && marker.controllerGeneration > 0 &&
    Number.isSafeInteger(marker.attempt) && marker.attempt > 0 && typeof marker.requiresPreparationStop === "boolean" &&
    ["pending", "complete"].includes(marker.state) ? marker : null;
}

export async function requestNativeStartupCleanup(db: Db, input: {
  companyId: string; agentId: string; runId: string; contextId: string; deadlineAtMs: number; leaseOwner: string;
  requiresPreparationStop: boolean;
  leaseId?: string;
}, options: { publish?: boolean } = {}): Promise<boolean> {
  let publication: Parameters<typeof publishActivity>[0] | null = null;
  const [binding] = await db.select({ issueId: nativeRunFinalizations.issueId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId)));
  if (!binding) return false;
  const requested = await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, binding.issueId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, input.agentId))).for("update");
    if (!run || !coordinator || run.runtimeMode !== "native" || run.status !== "running" || run.sessionIdAfter || coordinator.resultId ||
        isNativeRunnerOwnershipHeld(run)) return false;
    const existing = readNativeStartupCleanup(run);
    if (existing) return existing.contextId === input.contextId;
    if (coordinator.leaseOwner !== input.leaseOwner) return false;
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), input.leaseId ? eq(environmentLeases.id, input.leaseId) : undefined,
      sql`${environmentLeases.metadata}->>'runnerTaskLease' = 'true'`));
    if (leases.length !== 1 || !leases[0]!.providerLeaseId) throw new Error("Native startup cleanup lease unavailable");
    const lease = leases[0]!;
    const activity = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system",
      actorId: "native-startup-cleanup", action: "native.startup_cleanup_requested", entityType: "heartbeat_run", entityId: run.id,
      agentId: run.agentId, runId: run.id, issueId: run.nativeIssueId ?? undefined,
      details: { contextId: input.contextId, deadlineAtMs: input.deadlineAtMs, leaseId: lease.id,
        controllerGeneration: coordinator.controllerGeneration, reason: "startup_worker_unsettled" } });
    if (!activity.activity?.id) throw new Error("Native startup cleanup audit unavailable");
    publication = activity.publication;
    const marker: NativeStartupCleanup = { schema: "paperclip.native-startup-cleanup.v1", companyId: run.companyId, agentId: run.agentId,
      runId: run.id, contextId: input.contextId, deadlineAtMs: input.deadlineAtMs, leaseOwner: input.leaseOwner,
      controllerGeneration: coordinator.controllerGeneration, attempt: coordinator.attempt, leaseId: lease.id,
      taskId: lease.providerLeaseId!, requiresPreparationStop: input.requiresPreparationStop, state: "pending", auditId: activity.activity.id };
    await tx.update(heartbeatRuns).set({ errorCode: NATIVE_STARTUP_CLEANUP_PENDING,
      error: "Native startup timed out. Cancellation and verified cleanup are pending.",
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ nativeStartupCleanup: marker,
        startupCancellation: { ...run.resultJson?.startupCancellation as object, requestedAt: new Date().toISOString() } })}::jsonb`,
      updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: NATIVE_STARTUP_CLEANUP_PENDING,
      nextAttemptAt: null, controlDeadlineAt: new Date(), recoveryState: "blocked", updatedAt: new Date() })
      .where(eq(nativeRunFinalizations.runId, run.id));
    await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
      runnerTaskRetiring: true, runnerTaskStartupCleanup: { contextId: marker.contextId, requiresPreparationStop: marker.requiresPreparationStop },
    })}::jsonb`, updatedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionFinalization);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.environmentCleanup);
    return true;
  });
  if (publication && options.publish !== false) publishActivity(publication);
  return requested;
}

export async function verifyNativeStartupCleanup(db: Db, run: Run, release: () => Promise<unknown>): Promise<void> {
  const marker = readNativeStartupCleanup(run);
  if (!marker || isNativeRunnerOwnershipHeld(run) || !["running", "cancelled"].includes(run.status)) throw conflict("Native startup cleanup intent unavailable");
  const read = async () => {
    const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, marker.leaseId)));
    if (!lease || lease.heartbeatRunId !== run.id || lease.providerLeaseId !== marker.taskId) throw conflict("Native startup cleanup target changed");
    return lease;
  };
  const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
  if (!owner || owner.controllerGeneration !== marker.controllerGeneration || owner.attempt !== marker.attempt ||
      owner.leaseOwner !== marker.leaseOwner || owner.resultId) throw conflict("Native startup cleanup ownership changed");
  let lease = await read();
  const stopped = (value: typeof lease) => hasRemoteTerminationReceipt(value) && value.cleanupStatus === "success" &&
    (!marker.requiresPreparationStop || value.metadata?.runnerTaskPreparationStopped === true);
  if (!stopped(lease)) { await release(); lease = await read(); }
  if (!stopped(lease)) throw conflict("Task cleanup is still pending", { code: NATIVE_STARTUP_CLEANUP_PENDING });
  await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.nativeIssueId!))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).for("update");
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
    const observed = current && readNativeStartupCleanup(current);
    const [receipt] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, marker.leaseId)).for("update");
    if (!coordinator || !current || isNativeRunnerOwnershipHeld(current) || coordinator.resultId || coordinator.controllerGeneration !== marker.controllerGeneration ||
        coordinator.attempt !== marker.attempt || coordinator.leaseOwner !== marker.leaseOwner || observed?.contextId !== marker.contextId ||
        !receipt || receipt.providerLeaseId !== marker.taskId || receipt.heartbeatRunId !== run.id || !stopped(receipt)) {
      throw conflict("Native startup cleanup ownership changed");
    }
    await tx.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeStartupCleanup,state}', '"complete"'::jsonb)`, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
  });
}

export async function acknowledgeNativeStartupCleanup(db: Db, input: { companyId: string; runId: string }): Promise<void> {
  const [binding] = await db.select({ issueId: nativeRunFinalizations.issueId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId)));
  if (!binding) return;
  await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, binding.issueId))).for("update");
    const [owner] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId)).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
    const marker = run && readNativeStartupCleanup(run);
    if (!owner || !run || run.status !== "cancelled" || !marker || marker.state !== "complete" || owner.resultId ||
        owner.failureCode !== NATIVE_STARTUP_CLEANUP_PENDING || owner.controllerGeneration !== marker.controllerGeneration ||
        owner.attempt !== marker.attempt || owner.leaseOwner !== marker.leaseOwner) return;
    const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, marker.leaseId)).for("update");
    if (!lease || lease.heartbeatRunId !== run.id || lease.providerLeaseId !== marker.taskId || !hasRemoteTerminationReceipt(lease) ||
        (marker.requiresPreparationStop && lease.metadata?.runnerTaskPreparationStopped !== true)) return;
    await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null, recoveryState: null,
      failureCode: "native_retry_cancelled", updatedAt: new Date() }).where(and(eq(nativeRunFinalizations.runId, input.runId), isNull(nativeRunFinalizations.resultId)));
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.environmentCleanup);
  });
}
