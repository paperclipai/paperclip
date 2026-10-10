import { hasRequiredWorkspaceRecovery, preserveWorkspaceRestoreRecoveryMetadata, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";
import { hasUnrestoredRemoteWorkspace, preserveLegacyWorkspaceRestoreSources, type LegacyWorkspaceRestoreSource } from "./legacy-workspace-restore-recovery.js";
import { isPreDispatchReviewWaitVerified } from "./pre-dispatch-review-wait.js";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { claimedAdapterType, hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { logActivity } from "./activity-log.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { issueService } from "./issues.js";

type Run = typeof heartbeatRuns.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh model turn cannot repair or verify unrestored files.
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) return true;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && (run.errorCode === "ai_connection_busy" || run.errorCode === "ai_connection_pool_exhausted") &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** Review-wait receipts are only exempt after retained execution evidence agrees.
 * The synchronous classifier stays conservative for callers without a DB proof. */
export async function legacyExecutionNeedsReconciliationWithEvidence(db: Db, run: Run): Promise<boolean> {
  return await hasUnrestoredRemoteWorkspace(db, run) ||
    (legacyExecutionNeedsReconciliation(run) && !(await isPreDispatchReviewWaitVerified(db, run)));
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
  reconcileIfNeeded?: boolean;
  writeConditions?: SQL[];
  /** Adapter settlement records a copy-back failure before host finalization. */
  recordRestoreFailureOnly?: boolean;
  workspaceRestoreSource?: LegacyWorkspaceRestoreSource;
}) {
  const { db, run, status } = input;
  let patch = input.patch;
  const issueId =
    run.nativeIssueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    )).for("update");
    if (!current || current.runtimeMode !== "legacy" ||
        (!input.recordRestoreFailureOnly && !(input.fromStatuses ?? [run.status]).includes(current.status))) return null;
    if (patch?.resultJson !== undefined) patch = { ...patch,
      resultJson: preserveWorkspaceRestoreRecoveryMetadata(current.resultJson,
        input.recordRestoreFailureOnly ? { ...current.resultJson, ...patch.resultJson } : patch.resultJson),
    };
    let [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status: input.recordRestoreFailureOnly ? current.status : status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.status, current.status),
          ...(input.writeConditions ?? []),
        ),
      )
      .returning();
    if (!updated) return null;
    const retainedLeaseIds = await preserveLegacyWorkspaceRestoreSources(tx as unknown as Db,
      input.recordRestoreFailureOnly ? { ...updated, status: "failed" } : updated, input.workspaceRestoreSource);
    if (retainedLeaseIds.length) {
      [updated] = await tx.update(heartbeatRuns).set({ resultJson: {
        ...updated.resultJson,
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: retainedLeaseIds },
      } }).where(and(eq(heartbeatRuns.id, updated.id), eq(heartbeatRuns.companyId, updated.companyId))).returning();
    }
    const needsRecovery = input.recordRestoreFailureOnly
      ? retainedLeaseIds.length > 0 || hasRequiredWorkspaceRecovery(updated.resultJson)
      : !input.reconcileIfNeeded || await legacyExecutionNeedsReconciliationWithEvidence(tx as unknown as Db, updated);
    if (!needsRecovery) return updated;
    if (!input.recordRestoreFailureOnly && task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (!input.recordRestoreFailureOnly && task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    if (task && hasRequiredWorkspaceRecovery(updated.resultJson)) {
      // File recovery belongs to this exact source, even if cancellation let a
      // newer owner or conversation generation start before copy-back settled.
      // A resolved no-replay hold can coexist with another active incident; the
      // one-active-action index must never make us supersede either obligation.
      const [existing] = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
        eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
      )).orderBy(desc(issueRecoveryActions.createdAt)).limit(1).for("update");
      const decision = existing?.evidence.executionReconciliation as Record<string, unknown> | undefined;
      if (hasRequiredWorkspaceRecovery(existing?.evidence) && decision?.runId === run.id) return updated;
      const now = new Date();
      const evidence = {
        ...existing?.evidence,
        runId: run.id,
        originalFailureCode: updated.errorCode,
        workspaceRestoreFailure: updated.resultJson!.workspaceRestoreFailure,
        workspaceRestoreRecovery: updated.resultJson!.workspaceRestoreRecovery,
        executionReconciliation: undefined,
        continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: run.id, replay: "blocked",
          actionOutcome: "unknown", recordedAt: now.toISOString() },
      };
      const values = { status: "resolved", outcome: "blocked", ownerType: "board", ownerAgentId: null,
        ownerUserId: null, returnOwnerAgentId: null, evidence, resolvedAt: now, updatedAt: now,
        wakePolicy: null, monitorPolicy: null,
        nextAction: "The original sandbox is retained for workspace repair. Verify its exact stop receipt, recover the missing files, and record workspaceRepairEvidence without changing the current task. Repair does not replay the stopped run. Explicitly remove the retained allocation after recovery.",
      };
      if (existing) await tx.update(issueRecoveryActions).set(values).where(eq(issueRecoveryActions.id, existing.id));
      else await tx.insert(issueRecoveryActions).values({ ...values, companyId: run.companyId,
        sourceIssueId: task.id, kind: "active_run_watchdog", cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`, attemptCount: 1 });
      return updated;
    }
    const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
    const isCurrentReviewer = review?.status === "pending" &&
      review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
    if (
      task &&
      !isSupersededConversationRun(task, updated) &&
      (task.assigneeAgentId === run.agentId || isCurrentReviewer) &&
      (!["done", "cancelled"].includes(task.status) || retainedLeaseIds.length > 0)
    ) {
      // Periodic stranded-work checks may revisit this terminal run before its
      // reconciled continuation is dispatched. Preserve the recorded decision
      // and an existing unsafe-workspace hold instead of creating another one.
      const [reconciled] = await tx.select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          ...(hasRequiredWorkspaceRecovery(updated.resultJson) ? [
            sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
          ] : []),
          or(
            sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
            and(
              sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
              or(sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
                sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`),
              sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
            ),
          ),
        )).limit(1);
      if (reconciled) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          ...(hasWorkspaceRestoreFailure(updated.resultJson) ? { workspaceRestoreFailure: updated.resultJson!.workspaceRestoreFailure } : {}),
          ...(hasRequiredWorkspaceRecovery(updated.resultJson) ? { workspaceRestoreRecovery: updated.resultJson!.workspaceRestoreRecovery } : {}),
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction: hasRequiredWorkspaceRecovery(updated.resultJson)
          ? "The original sandbox is retained for workspace repair. Verify that it has stopped, recover the missing files, record workspaceRepairEvidence, and explicitly remove the retained allocation when recovery is complete. A new agent turn cannot prove file recovery."
          : hasWorkspaceRestoreFailure(updated.resultJson)
          ? "Verify safe workspace staging or repair, then reconcile the stopped run before continuing. Saved work and approval decisions remain in force."
          : "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}

/** Called only by the exact executor's finally block after preparation/cleanup
 * settles. A shutdown can win the terminal-status race before the setup catch
 * records that no provider started. Retire only that mistaken recovery hold. */
export async function settleInterruptedNativeBootstrap(
  db: Db, input: { run: Run; providerDispatchStarted: boolean },
): Promise<Run | null> {
  if (input.providerDispatchStarted) return null;
  const issueId = input.run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return null;
  return db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.run.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId))).for("update");
    if (!task || !run || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt ||
        run.contextSnapshot?.issueId !== task.id ||
        run.status !== "interrupted" || run.errorCode !== "server_shutdown_interrupted" ||
        claimedAdapterType(run) !== "paperclip_runner" || run.processPid || run.processGroupId ||
        hasWorkspaceRestoreFailure(run.resultJson) || executionFailureRetryCount(run) >= 2) return null;
    const [native] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).limit(1);
    const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      or(isNull(environmentLeases.releasedAt), eq(environmentLeases.status, "pending_cleanup"), eq(environmentLeases.cleanupStatus, "failed")),
    )).limit(1);
    if (native || lease) return null;
    const holds = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
      eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE), eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
      sql`coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'`,
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]), and(
        eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'`,
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      )),
    )).for("update");
    const ownedBlock = holds.map(hold => hold.evidence.nativeBootstrapFailureBlock as Record<string, unknown> | undefined)
      .find(receipt => receipt?.runId === run.id && receipt.statusVersion === task.statusVersion &&
        ["todo", "in_progress", "in_review"].includes(String(receipt.previousStatus)));
    if (task.status === "blocked" && ownedBlock && task.assigneeAgentId === run.agentId &&
        !isSupersededConversationRun(task, run) && !task.executionRunId && !task.checkoutRunId) {
      // Restore only the unchanged projection made by this exact incident.
      // The issue service still enforces dependency/assignee readiness. Human
      // reblocks, reassignment and conversation resets invalidate this receipt.
      await issueService(tx as unknown as Db).update(task.id, { status: String(ownedBlock.previousStatus) }, tx);
    }
    const now = new Date();
    const [settled] = await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false, preparationSettledAt: now.toISOString() },
    }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id)).returning();
    const resolved = holds.length ? await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive",
      resolutionNote: "The interrupted executor finished preparation and cleanup without starting a provider.",
      resolvedAt: now, updatedAt: now,
      // An automatic disposition may already have resolved the incident but
      // left replay blocked. Preserve its history while correcting that verdict.
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"allowed"'::jsonb, false) ||
        ${JSON.stringify({ bootstrapPreparationSettledAt: now.toISOString() })}::jsonb`,
    }).where(inArray(issueRecoveryActions.id, holds.map(hold => hold.id))).returning({ id: issueRecoveryActions.id }) : [];
    if (resolved.length) await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "system",
      action: "issue.recovery_action_resolved", entityType: "issue", entityId: task.id, agentId: run.agentId, runId: run.id,
      details: { reason: "native_bootstrap_stopped_before_provider", recoveryActionIds: resolved.map(r => r.id) },
    });
    return settled;
  });
}

/** Capture the required-file obligation before unrelated host writes. Keeps
 * execution ownership while the adapter's host finalization is still running. */
export async function recordLegacyWorkspaceRestoreFailure(db: Db, run: Run, evidence: Record<string, unknown>, source?: LegacyWorkspaceRestoreSource) {
  if (run.runtimeMode !== "legacy" || !hasWorkspaceRestoreFailure(evidence)) return;
  await terminalizeLegacyExecution({ db, run, status: run.status,
    recordRestoreFailureOnly: true, patch: { resultJson: evidence }, workspaceRestoreSource: source,
  });
}
