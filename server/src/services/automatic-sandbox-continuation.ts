import { and, eq, gt, ne, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { CONVERSATION_CONTINUATION_POLICY, isConversationAdapter, recordedRunAdapter } from "./conversation-continuation.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { persistActivity } from "./activity-log.js";

export const SANDBOX_INFRASTRUCTURE_ERRORS = [
  "process_lost", "server_shutdown_interrupted", "execution_context_lost",
];

export async function runHasUnconfirmedRemoteExecution(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  return leases.some(lease => lease.provider && lease.provider !== "local" && !hasRemoteTerminationReceipt(lease));
}

export async function hasLaterSandboxExecution(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const [successor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId),
      sql`(${heartbeatRuns.retryOfRunId} = ${run.id} or
        (coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}::text
          and ${heartbeatRuns.createdAt} > ${run.createdAt.toISOString()}
          and (${heartbeatRuns.startedAt} is not null or ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry', 'succeeded'))))`,
    )).limit(1);
  return Boolean(successor);
}

/** Repair execution ownership independently of whether task admission is open.
 * A fresh conversation can inspect unknown prior effects; a stopped sandbox is
 * the prerequisite, not a user accepting responsibility for those effects. */
export async function prepareAutomaticSandboxContinuation(db: Db, source: typeof heartbeatRuns.$inferSelect) {
  const issueId = source.nativeIssueId ?? source.contextSnapshot?.issueId;
  if (source.runtimeMode !== "legacy" || typeof issueId !== "string" ||
      !["failed", "interrupted"].includes(source.status) ||
      !SANDBOX_INFRASTRUCTURE_ERRORS.includes(source.errorCode ?? "")) return null;
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, source.companyId), sql`${issues.id}::text = ${issueId}`,
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, source.companyId),
    )).for("update");
    if (!issue || !run || run.runtimeMode !== "legacy" || run.status !== source.status || run.errorCode !== source.errorCode ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issue.id) return null;
    const [agent] = await tx.select().from(agents).where(and(
      eq(agents.companyId, run.companyId), eq(agents.id, run.agentId),
    ));
    if (!agent || !isConversationAdapter(agent.adapterType)) return null;
    const recorded = await recordedRunAdapter(tx as unknown as Db, run);
    if (recorded && !isConversationAdapter(recorded)) return null;
    // A later execution owns current task work. Never revive an older request.
    if (await hasLaterSandboxExecution(tx as unknown as Db, run, issue.id)) return null;
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ));
    if (!leases.length || leases.some(lease => !lease.provider || lease.provider === "local" || !lease.providerLeaseId)) return null;
    if (!leases.every(hasRemoteTerminationReceipt)) {
      for (const lease of leases) {
        if (hasRemoteTerminationReceipt(lease) || lease.status === "pending_cleanup") continue;
        // Released reusable resources can already be in a concurrent resume,
        // before its new lease is persisted. Only their normal release path
        // can authorize teardown; an old run cannot reclaim them retroactively.
        if (lease.leasePolicy === "reuse_by_environment" && lease.status !== "active") continue;
        // A historic reusable sandbox may since have been assigned elsewhere.
        // Its old run grants no authority over a later lease of that resource.
        const [newerLease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
          eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.provider, lease.provider!),
          eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), ne(environmentLeases.id, lease.id),
          gt(environmentLeases.acquiredAt, lease.acquiredAt),
        )).limit(1);
        if (newerLease) continue;
        await tx.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
          failureReason: "controller_lost_termination_unconfirmed", updatedAt: new Date(),
        }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId),
          eq(environmentLeases.status, lease.status)));
      }
      return null;
    }
    // Remote process numbers belong to the remote namespace, not this host.
    const [ready] = await tx.update(heartbeatRuns).set({
      processPid: null, processGroupId: null, processStartedAt: null,
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        conversationContinuation: CONVERSATION_CONTINUATION_POLICY,
        automaticSandboxRecovery: { state: "provider_terminated", actionOutcomes: "unknown" },
      })}::jsonb`,
    }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).returning();
    const retired = await tx.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      nextAction: "Sandbox termination confirmed; automatic conversation continuation can proceed.",
      resolutionNote: "Provider termination permits a new turn; prior external action outcomes remain unknown.",
      wakePolicy: null, monitorPolicy: null,
      evidence: sql`${issueRecoveryActions.evidence} || jsonb_build_object('automaticRecovery',
        coalesce(${issueRecoveryActions.evidence}->'automaticRecovery', '{}'::jsonb) || '{"replay":"conversation_continuation"}'::jsonb)`,
    }).where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`coalesce(${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay', '') != 'conversation_continuation'`,
    )).returning({ id: issueRecoveryActions.id });
    if (retired.length) await persistActivity(tx as unknown as Db, {
      companyId: run.companyId, actorType: "system", actorId: "execution-recovery",
      action: "issue.execution_recovery_settled", entityType: "issue", entityId: issue.id,
      details: { runId: run.id, recoveryActionIds: retired.map(action => action.id), proof: "provider_termination_receipt" },
    });
    return { run: ready, agent };
  });
}
