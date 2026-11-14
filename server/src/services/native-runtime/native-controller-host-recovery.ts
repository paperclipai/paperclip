import { readNativeRemoteExecutionOwnership } from "./native-runner-ownership.js";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { confirmNativeControllerStoppedSchema } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { surfaceNativeControllerNamespaceAttention } from "./native-restart-recovery.js";
import { readPendingNativeRunStop } from "./native-cancellation-request.js";

export const NATIVE_CONTROLLER_HOST_UNVERIFIED = "native_controller_host_unverified";
/** controller_host_hash value written once the board confirms the stop. */
export const OPERATOR_ATTESTED_CONTROLLER_HOST = "operator_attested";

const fingerprint = (runId: string) => `native-controller-host:${runId}`;
const changed = () => conflict("The recorded controller is no longer current. Refresh the task and inspect its run.",
  { code: "native_controller_host_recovery_stale" });

type Coordinator = Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "controllerBootId" | "controllerPid" | "controllerProcessStartedAt" | "controllerHostHash">;

/** Idempotent. Another active recovery action on the task keeps precedence. */
export async function requestNativeControllerStopConfirmation(tx: Db, coordinator: Coordinator) {
  await tx.insert(issueRecoveryActions).values({
    companyId: coordinator.companyId, sourceIssueId: coordinator.issueId, kind: "active_run_watchdog",
    status: "active", ownerType: "board", cause: NATIVE_CONTROLLER_HOST_UNVERIFIED,
    fingerprint: fingerprint(coordinator.runId), attemptCount: 1,
    evidence: { runId: coordinator.runId, controller: { bootId: coordinator.controllerBootId, pid: coordinator.controllerPid,
      hostHash: coordinator.controllerHostHash,
      processStartedAt: coordinator.controllerProcessStartedAt?.toISOString() ?? null } },
    // Optional faster path: without a confirmation, the run ends after a
    // bounded wait and the task continues in a fresh, isolated run.
    nextAction: "The server running this task restarted. Paperclip continues the task in a fresh run shortly. "
      + "Confirming that the previous server stopped is optional and only makes that faster.",
  }).onConflictDoNothing();
}

/** Board attestation. It marks only the exact recorded controller as stopped;
 * restart recovery then takes over through its normal path. */
export async function confirmNativeControllerStopped(input: {
  db: Db; companyId: string; issueId: string; actionId: string; runId: string; stopEvidence: string; actorId: string;
}) {
  const confirmation = confirmNativeControllerStoppedSchema.parse({
    actionId: input.actionId, runId: input.runId, stopEvidence: input.stopEvidence,
  });
  const committed = await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    // Match Native admission and containment lock order. This records only
    // the previous controller stop, not provider containment or a new turn.
    const [task] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
      eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId))).for("update");
    const recorded = (action?.evidence?.controller ?? {}) as Record<string, unknown>;
    if (!task || !coordinator || !action || !run || action.cause !== NATIVE_CONTROLLER_HOST_UNVERIFIED || action.ownerType !== "board"
      || !["active", "escalated"].includes(action.status) || action.evidence?.runId !== input.runId
      || coordinator.controllerHostHash !== (recorded.hostHash ?? null) || coordinator.controllerPid !== recorded.pid
      || coordinator.controllerBootId !== recorded.bootId
      || (coordinator.controllerProcessStartedAt?.toISOString() ?? null) !== recorded.processStartedAt
      || run.runtimeMode !== "native"
      || !(coordinator.resultId === null ? run.status === "running" : ["running", "cancelled"].includes(run.status))
      || (coordinator.resultId === null ? !["observed", "retryable_failure"].includes(coordinator.phase)
        : ["committed", "terminal_failure"].includes(coordinator.phase))
      || task.assigneeAgentId !== run.agentId || task.executionRunId !== run.id
      || (task.checkoutRunId !== null && task.checkoutRunId !== run.id)
      || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id
      || ["done", "cancelled"].includes(task.status)
      || !coordinator.leaseOwner || !coordinator.leaseExpiresAt
      || coordinator.leaseOwner.startsWith("native-finalizer:") || coordinator.leaseOwner.startsWith("native-cleanup:")
      || await readPendingNativeRunStop(tx, run)) throw changed();
    const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
      or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`,
        sql`exists (select 1 from ${nativeRunFinalizations} newer_owner
          where newer_owner.run_id = ${heartbeatRuns.id} and newer_owner.company_id = ${run.companyId}
            and newer_owner.issue_id = ${task.id})`),
      sql`${heartbeatRuns.createdAt} >= (select source.created_at from ${heartbeatRuns} source
        where source.id = ${run.id} and source.company_id = ${run.companyId})`,
    )).limit(1);
    if (newer) throw changed();
    // Use the DB's full precision, not a Date or session-dependent rendering.
    const [expiry] = await tx.select({ epoch: sql<string | null>`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text` })
      .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
    if (!expiry?.epoch) throw changed();
    // Work intent before the write it announces (sleep-aware background work).
    await notifyLiveRunRecovery(tx, { companyId: input.companyId, runId: input.runId, agentId: run.agentId });
    const now = new Date();
    const [updated] = await tx.update(nativeRunFinalizations).set({ controllerHostHash: OPERATOR_ATTESTED_CONTROLLER_HOST, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, input.runId), coordinator.controllerHostHash === null
        ? isNull(nativeRunFinalizations.controllerHostHash) : eq(nativeRunFinalizations.controllerHostHash, coordinator.controllerHostHash),
        eq(nativeRunFinalizations.controllerPid, coordinator.controllerPid!),
        eq(nativeRunFinalizations.controllerBootId, coordinator.controllerBootId!),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.attempt, coordinator.attempt),
        eq(nativeRunFinalizations.phase, coordinator.phase),
        coordinator.resultId === null ? isNull(nativeRunFinalizations.resultId)
          : eq(nativeRunFinalizations.resultId, coordinator.resultId),
        sql`extract(epoch from ${nativeRunFinalizations.leaseExpiresAt})::numeric::text = ${expiry.epoch}`))
      .returning();
    if (!updated) throw changed();
    const proof = { controller: recorded, actorId: input.actorId, stopEvidence: confirmation.stopEvidence, confirmedAt: now.toISOString() };
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      evidence: { ...action.evidence, controllerStop: proof },
      nextAction: "The previous server was confirmed stopped. Recovery will inspect the saved run. Separate provider containment may still be required.",
    }).where(eq(issueRecoveryActions.id, action.id));
    // The controller-only action is now resolved. Publish its responsible
    // next owner in this same transaction: an observed/no-checkpoint run is
    // not necessarily admitted by any deferred recovery scanner.
    if (coordinator.resultId === null) {
      const { remoteProcess } = await readNativeRemoteExecutionOwnership(tx, { run, issueId: task.id });
      await surfaceNativeControllerNamespaceAttention(tx, { run, coordinator: updated, expiryEpoch: expiry.epoch, remoteProcess });
    }
    const publication = await persistActivity(tx, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.native_controller_stop_confirmed", entityType: "issue", entityId: input.issueId, runId: input.runId,
      details: { recoveryActionId: input.actionId, ...proof } });
    return { publication };
  });
  publishActivity(committed.publication.publication);
  return { runId: input.runId, status: "queued" as const };
}
