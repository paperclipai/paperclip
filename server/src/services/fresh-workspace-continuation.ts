import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { persistActivity } from "./activity-log.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { readTaskRetryIntent } from "./task-retry.js";
import { z } from "zod";

export type ContinuationReadiness =
  | { mode: "resume_preserved_workspace"; preservationReceiptId: string }
  | { mode: "fresh_isolated_workspace"; retryIntentId: string; sourceRunId: string; retainedSourceIds: string[] };
const freshReadinessSchema = z.object({
  mode: z.literal("fresh_isolated_workspace"), retryIntentId: z.string().uuid(),
  sourceRunId: z.string().uuid(), retainedSourceIds: z.array(z.string().uuid()),
});

/** This chooses a strategy, never establishes termination or effect safety.
 * Admission verifies those independently before it can persist this receipt. */
export async function canSelectFreshWorkspace(input: {
  db: Db; companyId: string; issueId: string; agentId: string; actorId: string;
  sourceRunId: string; evidence: Record<string, unknown>; taskRetryRequestId?: string;
  queuedRequestId?: string;
}): Promise<string | null> {
  const system = readSystemRecovery(input.evidence);
  const requestId = input.taskRetryRequestId ?? input.queuedRequestId;
  if (!requestId || !system || system.sourceRunId !== input.sourceRunId || system.freshAttemptRunId) return null;
  if (system.providerCooldownAt !== null && system.providerCooldownAt > Date.now()) return null;
  const [wake] = await input.db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, requestId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
  ));
  if (!wake) return null;
  if (input.taskRetryRequestId) {
    const retry = readTaskRetryIntent(wake.payload);
    if (retry?.generationId !== wake.id || retry.sourceRunId !== input.sourceRunId ||
        retry.actorId !== input.actorId || wake.requestedByActorId !== input.actorId) return null;
    return wake.id;
  }
  const [source] = await input.db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId),
  ));
  const recoveryPolicy = source?.context?.automaticRecovery as Record<string, unknown> | undefined;
  if (recoveryPolicy?.allowFreshWorkspace === false) return null;
  // Saved input can use the automatic fallback only after maintenance settled.
  // A pending export keeps its current attempt; it cannot spawn another agent.
  return ["complete", "exhausted"].includes(system.state) ? wake.id : null;
}

/** Preparation trusts the committed admission receipt, not a raw wake payload. */
export async function readFreshWorkspaceReadiness(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "contextSnapshot">): Promise<ContinuationReadiness | null> {
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return null;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,runId}' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,mode}' = 'fresh_isolated_workspace'`,
    // Historical sibling holds also record the continuation, but only the
    // recovery generation owns its committed fresh attempt. Select that proof.
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,freshAttemptRunId}' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,sourceRunId}'`,
    sql`${issueRecoveryActions.evidence}->>'runId' = ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,readiness,sourceRunId}'`,
  )).limit(1);
  if (!action) {
    // Normal dispatch can admit a retry after a pre-provider failure without a
    // recovery hold. The committed wake is its authority. It still needs an
    // independent directory: falling back to the agent's configured cwd would
    // reopen the original source after a failed fresh attempt.
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.reason, "task_retry"),
      eq(agentWakeupRequests.status, "coalesced"), eq(agentWakeupRequests.requestedByActorType, "user"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).limit(1);
    const intent = readTaskRetryIntent(wake?.payload);
    if (!wake || !intent || intent.canonicalIntentId ||
        intent.generationId !== wake.id || intent.actorId !== wake.requestedByActorId ||
        run.contextSnapshot?.taskRetryRequestId !== wake.id ||
        !["evaluate", "continue", "fresh_isolated_workspace"].includes(intent.strategy)) return null;
    if (intent.chatActionId) {
      const [chatWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.id, intent.chatActionId), eq(agentWakeupRequests.runId, run.id),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
      if (!chatWake || (run.contextSnapshot?.chatFailedRunRetry as Record<string, unknown> | undefined)?.actionId !== chatWake.id)
        return null;
    }
    const [source] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
      eq(heartbeatRuns.id, intent.sourceRunId), sql`coalesce(${heartbeatRuns.nativeIssueId}::text,
        ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
    )).limit(1);
    if (!source) throw new Error("Fresh retry source changed");
    if (intent.strategy !== "fresh_isolated_workspace") {
      const preservationReceiptId = await verifiedWorkspaceRepairReceipt(db, source);
      if (preservationReceiptId) return { mode: "resume_preserved_workspace", preservationReceiptId };
    }
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, source.id),
    ));
    const readiness: ContinuationReadiness = { mode: "fresh_isolated_workspace",
      retryIntentId: wake.id, sourceRunId: source.id, retainedSourceIds: leases.map(lease => lease.id) };
    await db.transaction(async tx => {
      const changed = await tx.update(agentWakeupRequests).set({
        payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"fresh_isolated_workspace"'::jsonb)`,
      }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id),
        sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' in ('evaluate', 'continue')`)).returning({ id: agentWakeupRequests.id });
      if (changed.length) await persistActivity(tx as unknown as Db, { companyId: run.companyId,
        actorType: "system", actorId: "task-recovery", action: "issue.fresh_workspace_selected",
        entityType: "issue", entityId: issueId, runId: run.id, details: { ...readiness } });
    });
    return readiness;
  }
  const authorization = action?.evidence.explicitUserContinuation as Record<string, unknown> | undefined;
  const parsed = freshReadinessSchema.safeParse(authorization?.readiness);
  if (!parsed.success) return null;
  const readiness = parsed.data;
  const recovery = readSystemRecovery(action.evidence);
  if (action.evidence.runId !== readiness.sourceRunId || recovery?.sourceRunId !== readiness.sourceRunId ||
      recovery.freshAttemptRunId !== run.id) return null;
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, readiness.retryIntentId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )).limit(1);
  if (!wake) throw new Error("Fresh workspace admission lost its input receipt");
  return readiness;
}
