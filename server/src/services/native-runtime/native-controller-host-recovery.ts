import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { confirmNativeControllerStoppedSchema } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";

/**
 * An ephemeral (multi-host) server cannot judge a native controller row saved
 * before controller_host_hash existed: its PID may name a process on another
 * host. Restart recovery leaves such a row waiting and asks the board, through
 * this recovery action, to confirm that the previous server stopped.
 */
export const NATIVE_CONTROLLER_HOST_UNVERIFIED = "native_controller_host_unverified";
/** controller_host_hash value written once the board confirms the stop. */
export const OPERATOR_ATTESTED_CONTROLLER_HOST = "operator_attested";

const fingerprint = (runId: string) => `native-controller-host:${runId}`;
const changed = () => conflict("The recorded controller is no longer current. Refresh the task and inspect its run.",
  { code: "native_controller_host_recovery_stale" });

type Coordinator = Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "controllerBootId" | "controllerPid" | "controllerProcessStartedAt">;

/** Idempotent. Another active recovery action on the task keeps precedence. */
export async function requestNativeControllerStopConfirmation(tx: Db, coordinator: Coordinator) {
  await tx.insert(issueRecoveryActions).values({
    companyId: coordinator.companyId, sourceIssueId: coordinator.issueId, kind: "active_run_watchdog",
    status: "active", ownerType: "board", cause: NATIVE_CONTROLLER_HOST_UNVERIFIED,
    fingerprint: fingerprint(coordinator.runId), attemptCount: 1,
    evidence: { runId: coordinator.runId, controller: { bootId: coordinator.controllerBootId, pid: coordinator.controllerPid,
      processStartedAt: coordinator.controllerProcessStartedAt?.toISOString() ?? null } },
    nextAction: "This run's previous server was recorded before Paperclip stored which host it ran on, so Paperclip "
      + "cannot verify that it stopped. Confirm that the previous server process has stopped (for example, its "
      + "container was replaced), then recovery checks the saved run. Controller confirmation does not confirm that its provider or tools stopped.",
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
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
      eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId))).for("update");
    const [run] = await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    const recorded = (action?.evidence?.controller ?? {}) as Record<string, unknown>;
    if (!coordinator || !action || !run || action.cause !== NATIVE_CONTROLLER_HOST_UNVERIFIED || action.ownerType !== "board"
      || !["active", "escalated"].includes(action.status) || action.evidence?.runId !== input.runId
      || coordinator.controllerHostHash !== null || coordinator.controllerPid !== recorded.pid
      || coordinator.controllerBootId !== recorded.bootId) throw changed();
    // Work intent before the write it announces (sleep-aware background work).
    await notifyLiveRunRecovery(tx, { companyId: input.companyId, runId: input.runId, agentId: run.agentId });
    const now = new Date();
    const updated = await tx.update(nativeRunFinalizations).set({ controllerHostHash: OPERATOR_ATTESTED_CONTROLLER_HOST, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, input.runId), isNull(nativeRunFinalizations.controllerHostHash),
        eq(nativeRunFinalizations.controllerPid, coordinator.controllerPid!),
        eq(nativeRunFinalizations.controllerBootId, coordinator.controllerBootId!)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!updated.length) throw changed();
    const proof = { controller: recorded, actorId: input.actorId, stopEvidence: confirmation.stopEvidence, confirmedAt: now.toISOString() };
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      evidence: { ...action.evidence, controllerStop: proof },
      nextAction: "The previous server was confirmed stopped. Recovery will inspect the saved run. Separate provider containment may still be required.",
    }).where(eq(issueRecoveryActions.id, action.id));
    const publication = await persistActivity(tx, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.native_controller_stop_confirmed", entityType: "issue", entityId: input.issueId, runId: input.runId,
      details: { recoveryActionId: input.actionId, ...proof } });
    return { publication };
  });
  publishActivity(committed.publication.publication);
  return { runId: input.runId, status: "queued" as const };
}
