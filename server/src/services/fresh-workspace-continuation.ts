import { and, asc, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { persistActivity } from "./activity-log.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { readTaskRetryIntent } from "./task-retry.js";
import { z } from "zod";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { toExecutionWorkspace } from "./execution-workspaces.js";
import { isBoundIsolatedTaskDirectory } from "./isolated-task-directory.js";

export type ContinuationReadiness =
  | { mode: "resume_preserved_workspace"; preservationReceiptId: string }
  | { mode: "reuse_current_workspace"; retryIntentId: string; sourceRunId: string; workspaceId: string; cwd: string }
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

async function reusableDirectoryAfterPreparationFailure(db: Db, source: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const validation = source.resultJson?.workspaceValidation as Record<string, unknown> | undefined;
  const recovery = source.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (source.status !== "failed" || !source.finishedAt || source.runtimeMode !== "legacy" ||
      source.errorCode !== "workspace_validation_failed" || source.executionStage !== "preparing" ||
      validation?.reason !== "git_worktree_base_not_git_checkout" || validation.issueId !== issueId ||
      validation.resolvedWorkspaceSource !== "task_session" || validation.requestedExecutionWorkspaceMode !== "isolated_workspace" ||
      validation.issueExecutionWorkspacePreference !== "reuse_existing" || recovery?.kind !== "bootstrap" ||
      recovery.providerWorkStarted !== false || Object.keys(recovery).some(key => !["kind", "providerWorkStarted"].includes(key)) ||
      source.resultJson?.stopReason !== "adapter_failed" ||
      adapterExecutionControls.has(source.id) || (source.controllerLeaseExpiresAt && source.controllerLeaseExpiresAt > new Date()) ||
      [source.runtimeModeResolvedAt, source.runtimeModeResolverVersion, source.runtimeModeReason, source.runnerInstanceId,
        source.nativeIssueId, source.nativePhase, source.nativeSessionId, source.driverKind, source.driverVersion,
        source.completionContractId, source.completionContractSha256, source.sessionIdAfter, source.externalRunId,
        source.processPid, source.processGroupId, source.processStartedAt, source.logStore, source.logRef,
        source.logBytes, source.logSha256, source.stdoutExcerpt, source.stderrExcerpt, source.lastOutputAt,
        source.lastOutputStream, source.lastOutputBytes, source.exitCode, source.signal].some(value => value !== null) ||
      source.lastOutputSeq !== 0 || source.logCompressed ||
      Object.keys(source.usageJson ?? {}).some(key => key !== "ledgerScope") ||
      Object.keys(source.runnerProfileJson ?? {}).some(key => !["adapterDispatch", "chatControlRecoveryAdmission", "aiConnectionNonAssigneeCommentWake"].includes(key)) ||
      Object.keys(source.resultJson ?? {}).some(key => !["effectiveTimeoutSec", "executionRecovery", "stopReason", "timeoutConfigured", "timeoutFired", "timeoutSource", "workspaceValidation"].includes(key))) return null;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, source.companyId), eq(heartbeatRunEvents.runId, source.id),
  )).orderBy(asc(heartbeatRunEvents.seq)).limit(4);
  let offset = 0;
  const warning = events[0];
  if (warning?.eventType === "agent_observability.unavailable") {
    if (warning.seq !== 1 || warning.level !== "warn" ||
        warning.message !== "Company observability was not applied: this harness is not supported." ||
        warning.payload?.reason !== "unsupported_harness" || !z.string().uuid().safeParse(warning.payload.revision).success ||
        Object.keys(warning.payload).some(key => !["reason", "revision"].includes(key))) return null;
    offset = 1;
  }
  const diagnostic = events[offset], measured = events[offset + 1];
  if (events.length !== 2 + offset || !diagnostic || diagnostic.seq !== 1 + offset ||
      diagnostic.eventType !== "error" || diagnostic.level !== "error" || diagnostic.message !== source.error ||
      diagnostic.payload !== null || !measured || measured.seq !== 2 + offset ||
      measured.eventType !== "lifecycle" || measured.level !== "info" || measured.message !== "task.run.measured" ||
      measured.payload?.phase !== "task.run.measured" || measured.payload?.outcome !== "failed" ||
      measured.payload?.durableSettlement !== true || typeof measured.payload.durationMs !== "number" ||
      !Number.isFinite(measured.payload.durationMs) || measured.payload.durationMs < 0 ||
      Object.keys(measured.payload).some(key => !["phase", "outcome", "durableSettlement", "durationMs"].includes(key)) ||
      events.some(event => event.stream !== "system" || event.agentId !== source.agentId ||
        event.sourceInstanceId !== null || event.sourceEventId !== null || event.sourceSeq !== null ||
        event.sourcePayloadSha256 !== null || event.protocolSchemaVersion !== null)) return null;
  const [executionEvidence] = await db.execute<{ present: boolean }>(sql`select
    exists(select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${source.companyId} and ${environmentLeases.heartbeatRunId} = ${source.id})
    or exists(select 1 from ${nativeRunResults} where ${nativeRunResults.companyId} = ${source.companyId} and ${nativeRunResults.runId} = ${source.id})
    or exists(select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.companyId} = ${source.companyId} and ${nativeRunFinalizations.runId} = ${source.id}) as present`);
  if (executionEvidence?.present !== false) return null;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, source.companyId), eq(issues.id, issueId)));
  if (!task || task.assigneeAgentId !== source.agentId || task.executionWorkspacePreference !== "reuse_existing" ||
      task.executionWorkspaceId !== validation.issueExecutionWorkspaceId || task.projectId !== validation.issueProjectId ||
      task.projectWorkspaceId !== validation.issueProjectWorkspaceId) return null;
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, source.companyId), eq(executionWorkspaces.id, task.executionWorkspaceId!),
  ));
  if (!workspace || workspace.cwd !== validation.resolvedWorkspaceCwd || !await isBoundIsolatedTaskDirectory({
    companyId: source.companyId, issueId, workspaceId: task.executionWorkspaceId, workspace: toExecutionWorkspace(workspace) })) return null;
  const prior = await db.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, source.companyId), eq(environmentLeases.executionWorkspaceId, workspace.id),
  ));
  for (const { runId } of prior) if (runId && await hasPendingRunCleanup(db, source.companyId, runId)) return null;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, source.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.status, "running"),
  )).limit(1);
  return operation ? null : workspace;
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
      const workspace = run.contextSnapshot?.previousRunId === source.id
        ? await reusableDirectoryAfterPreparationFailure(db, source, issueId) : null;
      if (workspace?.cwd) {
        const readiness: ContinuationReadiness = { mode: "reuse_current_workspace", retryIntentId: wake.id,
          sourceRunId: source.id, workspaceId: workspace.id, cwd: workspace.cwd };
        await db.transaction(async tx => {
          const changed = await tx.update(agentWakeupRequests).set({
            payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"continue"'::jsonb)`,
          }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id),
            sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' = 'evaluate'`)).returning({ id: agentWakeupRequests.id });
          if (changed.length) await persistActivity(tx as unknown as Db, { companyId: run.companyId,
            actorType: "system", actorId: "task-recovery", action: "issue.retry_workspace_reused",
            entityType: "issue", entityId: issueId, runId: run.id, details: readiness });
        });
        return readiness;
      }
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
