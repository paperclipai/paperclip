import os from "node:os";
import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { resumeWorkspaceFinalizationSchema } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { evaluateNativeControllerTakeover } from "./native-restart-recovery.js";

const OWNER_KEY = "nativeWorkspaceFinalizationOwner";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const changed = () => conflict("The recorded workspace owner is no longer current. Refresh the task and inspect its run.", { code: "workspace_owner_recovery_stale" });

/** Board-only admission after deployment-platform verification. A missing DB
 * lock or an expired lease alone never proves physical copyback has stopped. */
export async function resumeNativeWorkspaceAfterOwnerStop(input: {
  db: Db; companyId: string; issueId: string; actionId: string; runId: string;
  ownerToken: string; controllerAndCopybackStopped: true; stopEvidence: string; actorId: string;
}) {
  const confirmation = resumeWorkspaceFinalizationSchema.parse({
    actionId: input.actionId, runId: input.runId, ownerToken: input.ownerToken,
    controllerAndCopybackStopped: input.controllerAndCopybackStopped, stopEvidence: input.stopEvidence,
  });
  const admitted = await input.db.transaction(async tx => {
    // Share the physical copyback lock. Do not wait behind an active exporter
    // and then apply a confirmation that described an earlier owner.
    const locks = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`native-workspace-finalization:${input.companyId}:${input.runId}`}, 0)) as acquired`);
    if (locks[0]?.acquired !== true) throw conflict("Workspace copyback is still active. Wait for it to stop before confirming recovery.");
    // Match the status arbiter's issue -> coordinator -> run lock order.
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.runId, input.runId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
    if (!issue || !run || !coordinator || !action || action.evidence?.runId !== run.id
      || action.cause !== "native_workspace_finalization_owner_unverified" || action.ownerType !== "board"
      || action.kind !== "active_run_watchdog" || !["active", "escalated"].includes(action.status)
      || run.runtimeMode !== "native" || run.status !== "running" || coordinator.phase !== "workspace_finalizing"
      || coordinator.leaseOwner || !coordinator.resultId || ["done", "cancelled"].includes(issue.status)
      || issue.assigneeAgentId !== run.agentId || issue.executionRunId !== run.id
      || (issue.checkoutRunId && issue.checkoutRunId !== run.id)) throw changed();
    const [result] = await tx.select().from(nativeRunResults).where(and(
      eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.companyId, input.companyId),
      eq(nativeRunResults.issueId, input.issueId), eq(nativeRunResults.runId, input.runId), eq(nativeRunResults.schemaStatus, "accepted"),
    ));
    if (!result || result.completionContractId !== run.completionContractId) throw changed();
    const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id),
      or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
      or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])),
    )).limit(1);
    if (newer) throw changed();
    const prior = record(run.runnerProfileJson?.[OWNER_KEY]);
    const recordedOwner = record(action.evidence?.owner);
    const stop = record(action.evidence?.workspaceOwnerStop);
    const receipt = { runId: run.id, resultId: result.id, status: "queued" as const };
    if (run.runnerProfileJson?.[OWNER_KEY] == null && record(stop.owner).token === input.ownerToken
      && stop.resultId === result.id) return { receipt, publication: null };
    if (typeof prior.hostname !== "string" || !prior.hostname
      || !Number.isInteger(prior.pid) || Number(prior.pid) <= 0
      || typeof prior.processStartedAt !== "string" || !Number.isFinite(Date.parse(prior.processStartedAt))
      || prior.token !== input.ownerToken || recordedOwner.token !== input.ownerToken
      || prior.hostname !== recordedOwner.hostname || prior.pid !== recordedOwner.pid
      || prior.processStartedAt !== recordedOwner.processStartedAt
      || prior.controllerBootId !== recordedOwner.controllerBootId) throw changed();
    // Reject a confirmation contradicted by a locally observable live owner,
    // even if that owner's advisory connection has already disconnected.
    if (prior.hostname === os.hostname()) {
      const takeover = await evaluateNativeControllerTakeover({ owner: {
        leaseOwner: input.ownerToken, leaseExpiresAt: new Date(0),
        controllerPid: typeof prior.pid === "number" ? prior.pid : null,
        controllerProcessStartedAt: typeof prior.processStartedAt === "string" ? new Date(prior.processStartedAt) : null,
      }, now: new Date() });
      if (!takeover.allowed) throw conflict("The previous workspace controller is still active or its stop cannot be verified.");
    }
    const now = new Date();
    const proof = { owner: prior, resultId: result.id, actorId: input.actorId,
      stopEvidence: confirmation.stopEvidence, confirmedAt: now.toISOString() };
    await tx.update(heartbeatRuns).set({
      runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - ${OWNER_KEY}`, updatedAt: now,
    }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, run.id),
      sql`${heartbeatRuns.runnerProfileJson}->${OWNER_KEY}->>'token' = ${input.ownerToken}`));
    await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, workspaceOwnerStop: proof },
      nextAction: "Workspace finalization is queued for the saved result. The agent will not repeat its work.",
      wakePolicy: null, monitorPolicy: null, updatedAt: now,
    }).where(eq(issueRecoveryActions.id, action.id));
    const publication = await persistActivity(tx as unknown as Db, { companyId: input.companyId,
      actorType: "user", actorId: input.actorId, action: "issue.workspace_owner_stop_confirmed",
      entityType: "issue", entityId: input.issueId, runId: input.runId,
      details: { recoveryActionId: input.actionId, ...proof },
    });
    // Leave the result, coordinator, source lease, task status and wait paths
    // untouched. The normal reconciler resumes copyback and arbitrates it.
    return { receipt, publication };
  });
  if (admitted.publication) publishActivity(admitted.publication.publication);
  return admitted.receipt;
}
