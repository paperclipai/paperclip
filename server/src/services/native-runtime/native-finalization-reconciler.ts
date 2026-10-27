import type { WorkspaceWorkers } from "../plugin-workspaces.js";
import { recoverLegacyUnsafeWorkspaceExports } from "./native-workspace-export-recovery.js";
import { hasPendingNativeChildCompletion } from "./native-child-completion-delivery.js";
import { dismissAutomaticCompletionReviews, decisionHasRetiredAutomaticReview } from "./automatic-completion-reviews.js";
import { logger } from "../../middleware/logger.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  completionContracts,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import {
  finalizeNativeRun,
  pendingNativeGovernance,
  resolveNativeFinalizerStatus,
  recordNativeFinalizationFailure,
  repairCommittedNativeReviewResponse,
  repairCommittedNativeChatResponse,
} from "./native-run-finalizer.js";
import {
  commitNativeStatusDecision,
  dispatchPendingNativeStatusEffects,
  NativeStatusRaceError,
} from "./status-decision-committer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueService } from "../issues.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";
import { isNewTerminalRunFailure, reportRunFailure } from "../run-failure-report.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";
import { dismissObsoleteNativePolicyReviews } from "./obsolete-policy-reviews.js";
import {
  cleanupNativeWorkspaceSync,
  readNativeWorkspaceSyncReference,
} from "./native-workspace-sync.js";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { createNativeReconciliationPassTiming } from "./native-reconciliation-timing.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import {
  isNativeRunnerOwnershipHeld,
  nativeRunnerOwnershipNotHeldCondition,
} from "./native-runner-ownership.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";

import { getNativeReviewAssignment } from "./native-review-participant.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../recovery/pause-hold-guard.js";
import { readRunCancellation } from "../run-cancellation.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

export type NativeReconciliationFacts = {
  equivalentAttentionFamily?: boolean;
  canonicalReplay?: boolean;
  callerMaterialConflict?: boolean;
  workspaceOperationPending?: boolean;
  undeliveredEffectCount?: number;
  authoritativeStatusChanged?: boolean;
  newEvidenceSatisfiesContract?: boolean;
  hasPendingChildCompletion?: boolean;
  dependencyResolved?: boolean;
  authorizedResume?: boolean;
  statusVersionAdvanced?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Append-only recovery/reconciliation re-arbitration from durable facts. */
export function resolveNativeReconciliationStatus(input: {
  facts: NativeReconciliationFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  const continuation = (reasonCode: string, effects: NativeStatusDecision["effects"] = []): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: "same_agent",
      summary: `Continue native reconciliation after ${reasonCode}.`,
      idempotencyKey: `native-reconciliation:${reasonCode}`,
      agentId: input.agentId,
    }, ...effects],
  });

  if (input.facts.equivalentAttentionFamily) {
    return preserve("attention_duplicate_suppressed", [{ kind: "link_canonical_request" }]);
  }

  if (input.facts.callerMaterialConflict) {
    return preserve("structured_result_replay_conflict", [{
      kind: "record_finalization_error",
      cause: "structured_result_replay_conflict",
      nextAction: "Use a fresh canonical result identity.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.authoritativeStatusChanged) {
    return preserve("prior_status_terminal_preserved", [{ kind: "append_superseding_assessment" }]);
  }
  if (input.facts.statusVersionAdvanced) {
    return preserve("arbitration_conflict_reloaded", [
      { kind: "increment_status_version" },
      { kind: "schedule_reconciliation" },
    ]);
  }
  if (input.facts.newEvidenceSatisfiesContract) {
    if (input.facts.hasPendingChildCompletion) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "in_progress",
        toStatus: "in_progress",
        reasonCode: "native_child_completion_pending",
        unblockDescriptor: null,
        // The existing child-result wake owns the continuation.
        effects: [{ kind: "release_checkout" }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "decision_superseded_by_new_evidence",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (input.facts.dependencyResolved) return continuation("dependency_resolved");
  if (input.facts.authorizedResume) return continuation("authorized_resume");
  if ((input.facts.undeliveredEffectCount ?? 0) > 0) {
    return continuation("live_continuation_registered", [{ kind: "dispatch_pending_effect" }]);
  }
  if (input.facts.workspaceOperationPending) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "resume_workspace_operation" }, { kind: "release_checkout" }],
    };
  }
  if (input.facts.canonicalReplay) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  throw new Error("native_reconciliation_facts_invalid");
}

export type NativeSessionResumeClaim = { runId: string; leaseOwner: string };

type NativeCleanupOutcome = {
  runId: string;
  status: "settled" | "not_eligible" | "operator_required";
};
type NativeCleanupSweep = {
  cursor: string | null;
  pending: Promise<NativeCleanupOutcome[]> | null;
};
const nativeCleanupSweeps = new WeakMap<Db, NativeCleanupSweep>();

/** Candidate discovery is not cleanup authority. The exact-state operation
 * claims its own durable lease and rechecks every physical owner. Keep this
 * lane joined and bounded, and advance even past ineligible candidates so one
 * damaged checkpoint cannot starve another company's recoverable session. */
export function reconcileRetainedNativeSessionCleanups(
  db: Db,
  options: {
    cleanup: (input: {
      companyId: string;
      runId: string;
    }) => Promise<NativeCleanupOutcome>;
    onError?: (error: unknown, runId: string) => void;
    limit?: number;
  },
): Promise<NativeCleanupOutcome[]> {
  let sweep = nativeCleanupSweeps.get(db);
  if (!sweep) {
    sweep = { cursor: null, pending: null };
    nativeCleanupSweeps.set(db, sweep);
  }
  if (sweep.pending) return sweep.pending;
  const owned = sweep;
  const limit = Number.isInteger(options.limit)
    ? Math.max(1, Math.min(5, options.limit!))
    : 1;
  const operation = async () => {
    const selectCandidates = (cursor: string | null) =>
      db
        .select({
          runId: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
        })
        .from(heartbeatRuns)
        .innerJoin(
          nativeRunFinalizations,
          and(
            eq(nativeRunFinalizations.runId, heartbeatRuns.id),
            eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
            eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
          ),
        )
        .innerJoin(
          nativeRunResults,
          and(
            eq(nativeRunResults.id, nativeRunFinalizations.resultId),
            eq(nativeRunResults.runId, heartbeatRuns.id),
            eq(nativeRunResults.companyId, heartbeatRuns.companyId),
            eq(nativeRunResults.issueId, heartbeatRuns.nativeIssueId),
          ),
        )
        .where(
          and(
            eq(heartbeatRuns.runtimeMode, "native"),
            inArray(heartbeatRuns.status, ["succeeded", "failed"]),
            isNotNull(heartbeatRuns.finishedAt),
            nativeRunnerOwnershipNotHeldCondition(),
            eq(nativeRunFinalizations.phase, "committed"),
            eq(nativeRunResults.schemaStatus, "accepted"),
            isNotNull(nativeRunFinalizations.assessmentId),
            isNotNull(nativeRunFinalizations.decisionId),
            isNull(nativeRunFinalizations.nextAttemptAt),
            or(
              isNull(nativeRunFinalizations.leaseOwner),
              isNull(nativeRunFinalizations.leaseExpiresAt),
              lte(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
            ),
            // The accepted-result projector preserves a recovered close failure
            // privately after clearing the visible successful run's stale error.
            sql`coalesce(${heartbeatRuns.errorCode}, ${heartbeatRuns.resultJson}->'recoveredExecutionFailure'->>'errorCode') in ('adapter_failed', 'provider_transport_failed')`,
            sql`coalesce(${heartbeatRuns.error}, ${heartbeatRuns.resultJson}->'recoveredExecutionFailure'->>'error') = 'provider_transport_failed: runner did not durably suspend before checkpoint'`,
            sql`not (${nativeRunFinalizations.recoveryHistory} @> '[{"kind":"native_cleanup_runner_epoch"}]'::jsonb)`,
            sql`not (${nativeRunFinalizations.recoveryHistory} @> '[{"kind":"native_cleanup_source_archive","phase":"operator_required"}]'::jsonb)`,
            // One legacy pre-ownership attempt may be inspected by the closed,
            // artifact-pinned no-launch verifier. Discovery grants no authority
            // to reuse its directory or start a provider. New recorded epochs,
            // staged attempts and ambiguous histories never enter this lane.
            sql`(
              select coalesce(
                jsonb_array_length(history.entries) = 0 or (
                  jsonb_array_length(history.entries) = 2
                  and history.entries->0->>'version' = '1'
                  and history.entries->1->>'version' = '1'
                  and history.entries->0->>'phase' = 'started'
                  and history.entries->1->>'phase' = 'operator_required'
                  and history.entries->1->>'code' = 'native_cleanup_maintenance_unproven'
                  and history.entries->0->>'requestId' like 'native-cleanup:%'
                  and history.entries->0->>'requestId' = history.entries->1->>'requestId'
                  and history.entries->0->>'sourceFingerprint' ~ '^[a-f0-9]{64}$'
                ), false
              )
              from (
                select coalesce(jsonb_agg(entry.value order by entry.ordinal), '[]'::jsonb) as entries
                from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory})
                  with ordinality as entry(value, ordinal)
                where entry.value->>'kind' = 'native_cleanup_maintenance'
              ) history
            )`,
            ...(cursor ? [gt(heartbeatRuns.id, cursor)] : []),
          ),
        )
        .orderBy(asc(heartbeatRuns.id))
        .limit(limit);
    let candidates = await selectCandidates(owned.cursor);
    if (candidates.length === 0 && owned.cursor !== null) {
      owned.cursor = null;
      candidates = await selectCandidates(null);
    }
    const outcomes: NativeCleanupOutcome[] = [];
    for (const candidate of candidates) {
      owned.cursor = candidate.runId;
      try {
        outcomes.push(await options.cleanup(candidate));
      } catch (error) {
        options.onError?.(error, candidate.runId);
      }
    }
    return outcomes;
  };
  // Deferring the query one microtask installs the joined owner before any
  // asynchronous work begins. Cleanup never creates a heartbeat or wake.
  const pending = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (owned.pending === pending) owned.pending = null;
    });
  owned.pending = pending;
  return pending;
}

export async function dispatchNativeSessionResumptions(input: {
  db: Db;
  runnerInstanceId: string;
  runIds?: string[];
  now?: Date;
  limit?: number;
  dispatch: (claim: NativeSessionResumeClaim) => void;
}) {
  const claims = await claimNativeSessionResumptions(input);
  for (const claim of claims) input.dispatch(claim);
  return claims;
}

/**
 * Claims explicit, result-less retryable failures for same-run recovery.
 * Merely expired `observed` ownership stays blocked because lease expiry alone
 * does not prove that the original provider owner stopped. Eligibility remains
 * independent of the live feature flag and legacy scheduler.
 */
export async function claimNativeSessionResumptions(input: {
  db: Db;
  runnerInstanceId: string;
  runIds?: string[];
  now?: Date;
  limit?: number;
}): Promise<NativeSessionResumeClaim[]> {
  const now = input.now ?? new Date();
  const candidates = await input.db
    .select({ runId: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: nativeRunFinalizations.issueId })
    .from(heartbeatRuns)
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(
        eq(heartbeatRuns.runtimeMode, "native"),
        nativeRunnerOwnershipNotHeldCondition(),
        isNull(heartbeatRuns.processPid),
        isNull(heartbeatRuns.processGroupId),
        isNull(nativeRunFinalizations.resultId),
        eq(nativeRunFinalizations.phase, "retryable_failure"),
        or(
          isNull(nativeRunFinalizations.nextAttemptAt),
          lte(nativeRunFinalizations.nextAttemptAt, now),
        ),
        or(
          isNull(nativeRunFinalizations.leaseOwner),
          isNull(nativeRunFinalizations.leaseExpiresAt),
          lte(nativeRunFinalizations.leaseExpiresAt, now),
        ),
        ...(input.runIds?.length
          ? [inArray(heartbeatRuns.id, input.runIds)]
          : []),
      ),
    )
    .orderBy(sql`${nativeRunFinalizations.nextAttemptAt} asc nulls first`, asc(nativeRunFinalizations.runId))
    .limit(input.limit ?? 25);

  const claims: NativeSessionResumeClaim[] = [];
  for (const candidate of candidates) {
    const leaseOwner = `${input.runnerInstanceId}:resume:${randomUUID()}`;
    let terminalRunToEmit: typeof heartbeatRuns.$inferSelect | null = null;
    const claimed = await input.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '2000', true)`);
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId),
      )).for("update").limit(1);
      if (!issue || !["todo", "in_progress", "in_review"].includes(issue.status)) return false;
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, candidate.runId),
        eq(nativeRunFinalizations.issueId, issue.id),
      )).for("update").limit(1);
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, candidate.runId),
        eq(heartbeatRuns.nativeIssueId, issue.id),
      )).for("update").limit(1);
      if (!run || !coordinator) return false;
      const row = { run, coordinator };
      if (
        row.run.runtimeMode !== "native" ||
        isNativeRunnerOwnershipHeld(row.run) ||
        row.run.processPid !== null ||
        row.run.processGroupId !== null ||
        row.coordinator.resultId ||
        row.coordinator.phase !== "retryable_failure" ||
        (row.coordinator.nextAttemptAt &&
          row.coordinator.nextAttemptAt > now) ||
        (row.coordinator.leaseOwner &&
          row.coordinator.leaseExpiresAt &&
          row.coordinator.leaseExpiresAt > now) ||
        !["running", "failed"].includes(row.run.status)
      )
        return false;

      if ((issue.executionRunId && issue.executionRunId !== run.id) ||
          (issue.checkoutRunId && issue.checkoutRunId !== run.id)) return false;
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.companyId, candidate.companyId), eq(agents.id, run.agentId),
      )).limit(1);
      if (!agent || !(await evaluateAgentInvokabilityFromDb(tx as unknown as Db, agent)).invokable) return false;
      if (issue.assigneeAgentId !== run.agentId && !await getNativeReviewAssignment(tx as unknown as Db, {
        companyId: run.companyId, issueId: issue.id, agentId: run.agentId,
        contextSnapshot: run.contextSnapshot,
      })) return false;
      if (await isAutomaticRecoverySuppressedByPauseHold(tx as unknown as Db, run.companyId, issue.id)) return false;
      if (!(await issueService(tx as unknown as Db).getDependencyReadiness(issue.id, tx)).isDependencyReady) return false;
      const [competing] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
        inArray(heartbeatRuns.status, issue.executionRunId === run.id
          ? ["running", "scheduled_retry"] : ["queued", "running", "scheduled_retry"]),
        or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
      )).limit(1);
      if (competing) return false;

      const profile = row.run.runnerProfileJson ?? {};
      const persistedInput = profile.nativeExecutionInput;
      const checkpoint = profile.sessionCheckpoint;
      const failureDetail = record(row.coordinator.failureDetail);
      const cancellation = readRunCancellation(run.resultJson);
      const nativeCancellation = record(record(run.resultJson).nativeCancellation);
      if ((cancellation?.source === "operator" && cancellation.expected) ||
          (["run", "issue"].includes(String(nativeCancellation.scope)) &&
            ["pending", "acknowledged"].includes(String(nativeCancellation.dispatchState))) ||
          typeof failureDetail.successorRunId === "string") return false;
      const originalFailureCode =
        typeof failureDetail.originalFailureCode === "string"
          ? failureDetail.originalFailureCode
          : row.run.errorCode ?? row.coordinator.failureCode
            ?? "native_session_interrupted";
      const providerEvent = await tx
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, row.run.id),
            inArray(heartbeatRunEvents.eventType, [
              "harness.ready",
              "session.started",
              "session.resumed",
              "session.updated",
              "turn.started",
              "provider.event",
              "provider.rpc_result",
            ]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const checkpointRecord = record(checkpoint);
      const checkpointHasProviderIdentity =
        (typeof checkpointRecord.providerSessionId === "string"
          && checkpointRecord.providerSessionId.length > 0)
        || Object.keys(record(checkpointRecord.providerIdentity)).length > 0;
      const bootstrapRetry =
        !!persistedInput
        && !checkpoint
        && !providerEvent
        && failureDetail.recoveryMode === "bootstrap_retry"
        && failureDetail.providerSessionEstablished === false;
      if (
        !persistedInput
        || (!checkpoint && !bootstrapRetry)
        || (!!checkpoint && !checkpointHasProviderIdentity)
      ) {
        const failureCode = originalFailureCode;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, row.run.companyId);
        await tx.update(nativeRunFinalizations).set({
          phase: "terminal_failure",
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode,
          failureDetail: {
            ...failureDetail,
            originalFailureCode,
            recoveryMode: "ambiguous_state",
            providerSessionEstablished:
              checkpointHasProviderIdentity || providerEvent !== null,
            recoveryOwner: { kind: "board" },
            nextAction: "Inspect the original provider failure; durable state is missing or ambiguous and opening a replacement provider session is forbidden.",
          },
          nextAttemptAt: null,
          updatedAt: now,
        }).where(eq(nativeRunFinalizations.runId, row.run.id));
        const [updatedRun] = await tx.update(heartbeatRuns).set({
          status: "failed",
          finishedAt: now,
          nativePhase: "terminal_failure",
          nativePhaseUpdatedAt: now,
          errorCode: failureCode,
          error: typeof failureDetail.message === "string"
            ? failureDetail.message
            : "Persisted native session state is ambiguous and cannot be resumed safely",
          updatedAt: now,
        }).where(eq(heartbeatRuns.id, row.run.id)).returning();
        // Only a genuine transition into "failed" is a new terminal failure.
        // A candidate that is already "failed" (the filter above admits
        // both "running" and "failed") must not send a second Sentry event,
        // unless that earlier write was an unreported pending retry.
        terminalRunToEmit =
          updatedRun && isNewTerminalRunFailure(row.run, updatedRun) ? updatedRun : null;
        await issueService(tx as unknown as Db).update(
          row.coordinator.issueId,
          { status: "blocked" },
          tx,
        );
        await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
          companyId: row.run.companyId,
          sourceIssueId: row.coordinator.issueId,
          kind: "active_run_watchdog",
          ownerType: "board",
          ownerAgentId: null,
          returnOwnerAgentId: row.run.agentId,
          cause: failureCode,
          fingerprint: createHash("sha256").update(`${row.run.id}:${failureCode}`).digest("hex"),
          evidence: {
            runId: row.run.id,
            hasEnvelope: !!persistedInput,
            hasCheckpoint: !!checkpoint,
            providerEventsExist: providerEvent !== null,
            originalFailureCode,
          },
          nextAction: "Inspect the original provider failure and explicitly resolve recovery; do not open a duplicate provider session.",
          wakePolicy: null,
          maxAttempts: 3,
          supersedeOnIdentityChange: true,
        });
        return false;
      }

      const leaseExpiresAt = new Date(now.getTime() + 20 * 60_000);
      const updated = await tx.update(nativeRunFinalizations).set({
        phase: "observed",
        leaseOwner,
        leaseExpiresAt,
        failureCode: null,
        failureDetail: null,
        nextAttemptAt: null,
        updatedAt: now,
      }).where(and(
        eq(nativeRunFinalizations.runId, row.run.id),
        eq(nativeRunFinalizations.phase, row.coordinator.phase),
      )).returning({ runId: nativeRunFinalizations.runId }).then((rows) => rows[0] ?? null);
      if (!updated) return false;
      await tx.update(heartbeatRuns).set({
        status: "running",
        finishedAt: null,
        error: null,
        errorCode: null,
        nativePhase: "observed",
        nativePhaseUpdatedAt: now,
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, row.run.id));
      await tx.update(issues).set({
        executionRunId: run.id,
        executionAgentNameKey: agent.name.trim().toLowerCase() || null,
        executionLockedAt: now,
        updatedAt: now,
      }).where(and(eq(issues.id, issue.id), eq(issues.companyId, run.companyId)));
      if (issue.executionRunId !== run.id) await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: run.companyId, runId: run.id, agentId: run.agentId,
        eventType: "native.recovery.execution_reclaimed", stream: "system", level: "info",
        message: "Reclaimed the original task execution for native session recovery.",
        payload: { issueId: issue.id },
      });
      return true;
    }).catch((error: unknown) => {
      terminalRunToEmit = null;
      logger.warn({ err: error, companyId: candidate.companyId, runId: candidate.runId },
        "failed to claim native session recovery candidate");
      return false;
    });
    // Telemetry is best-effort background work; it must not delay claiming
    // the remaining candidates in this loop, so fire it and do not await it.
    if (terminalRunToEmit) {
      void emitAgentTaskRun(input.db, terminalRunToEmit);
      void reportRunFailure(input.db, terminalRunToEmit);
    }
    if (claimed) claims.push({ runId: candidate.runId, leaseOwner });
    else await input.db.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '2000', true)`);
      await tx.update(nativeRunFinalizations).set({
        nextAttemptAt: new Date(now.getTime() + 30_000),
        updatedAt: now,
      }).where(and(
        eq(nativeRunFinalizations.companyId, candidate.companyId),
        eq(nativeRunFinalizations.issueId, candidate.issueId),
        eq(nativeRunFinalizations.runId, candidate.runId),
        eq(nativeRunFinalizations.phase, "retryable_failure"),
        isNull(nativeRunFinalizations.resultId),
        or(isNull(nativeRunFinalizations.nextAttemptAt), lte(nativeRunFinalizations.nextAttemptAt, now)),
        or(isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.leaseExpiresAt), lte(nativeRunFinalizations.leaseExpiresAt, now)),
      ));
    }).catch((error: unknown) => {
      logger.warn({ err: error, companyId: candidate.companyId, runId: candidate.runId },
        "failed to defer native session recovery candidate");
    });
  }
  return claims;
}

type NativeReconciliationOptions = {
  pluginWorkerManager?: WorkspaceWorkers;
  environmentRuntime?: EnvironmentRuntimeService;
  onWorkspaceSettled?: (input: {
    runId: string;
    companyId: string;
    agentId: string;
    succeeded: boolean;
  }) => Promise<void>;
};

type NativeReconciliationPassTiming = ReturnType<typeof createNativeReconciliationPassTiming>;

export const NATIVE_SETTLED_COMMITTED_GRACE_MS = 60 * 60 * 1000;
export const NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS = 10;
const NATIVE_SETTLED_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];
let settledCommittedUpkeepCursor: string | null = null;

export function resetSettledCommittedUpkeepForTests() {
  settledCommittedUpkeepCursor = null;
}

function settledCommittedFinalization(now: Date): SQL {
  return and(
    eq(nativeRunFinalizations.phase, "committed"),
    inArray(heartbeatRuns.status, NATIVE_SETTLED_RUN_STATUSES),
    isNotNull(heartbeatRuns.finishedAt),
    lt(heartbeatRuns.finishedAt, new Date(now.getTime() - NATIVE_SETTLED_COMMITTED_GRACE_MS)),
    sql<boolean>`not exists (
      select 1 from ${statusDecisionEffects} effect
      where effect.company_id = ${nativeRunFinalizations.companyId}
        and effect.issue_id = ${nativeRunFinalizations.issueId}
        and effect.decision_id = ${nativeRunFinalizations.decisionId}
        and effect.delivery_state in ('pending', 'failed')
    )`,
  )!;
}

async function nextSettledCommittedUpkeep(db: Db, now: Date): Promise<string[]> {
  const page = (after: string | null) => db
    .select({ runId: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNotNull(nativeRunFinalizations.resultId),
      settledCommittedFinalization(now),
      ...(after ? [gt(heartbeatRuns.id, after)] : []),
    ))
    .orderBy(asc(heartbeatRuns.id))
    .limit(NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS);
  let rows = await page(settledCommittedUpkeepCursor);
  if (rows.length === 0 && settledCommittedUpkeepCursor !== null) rows = await page(null);
  settledCommittedUpkeepCursor = rows.length === NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS
    ? rows[rows.length - 1]!.runId
    : null;
  return rows.map((row) => row.runId);
}

/** Recovery is keyed only by persisted mode/coordinator state, never the live flag. */
export async function reconcileNativeFinalizations(
  db: Db,
  runIds?: string[],
  options: NativeReconciliationOptions = {},
) {
  const timing = createNativeReconciliationPassTiming();
  let outcome: "ok" | "failed" = "ok";
  try {
    return await reconcileNativeFinalizationsPass(db, runIds, options, timing);
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    timing.finish({ outcome, scoped: Boolean(runIds?.length) });
  }
}

async function reconcileNativeFinalizationsPass(
  db: Db,
  runIds: string[] | undefined,
  options: NativeReconciliationOptions,
  timing: NativeReconciliationPassTiming,
) {
  timing.phase("legacy_workspace_exports");
  await recoverLegacyUnsafeWorkspaceExports(db, runIds).catch((err) => {
    logger.warn({ err }, "Historical unsafe export recovery remains pending");
  });
  timing.phase("obsolete_policy_reviews");
  await dismissObsoleteNativePolicyReviews(db, runIds).catch((err) => {
    logger.warn({ err }, "Obsolete native policy review lookup failed; continuing native reconciliation");
  });
  timing.phase("automatic_completion_reviews");
  if (runIds?.length) {
    const scopes = await db.select({ issueId: nativeRunFinalizations.issueId }).from(nativeRunFinalizations)
      .where(inArray(nativeRunFinalizations.runId, runIds));
    for (const scope of scopes) await dismissAutomaticCompletionReviews(db, scope.issueId);
  } else {
    await dismissAutomaticCompletionReviews(db);
  }
  timing.phase("candidate_scan");
  const now = new Date();
  const unscoped = !(runIds && runIds.length > 0);
  const upkeepRunIds = unscoped ? await nextSettledCommittedUpkeep(db, now) : [];
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      issueId: nativeRunFinalizations.issueId,
      issueStatus: issues.status,
      issueStatusVersion: issues.statusVersion,
      issueDecisionId: issues.lastStatusDecisionId,
      coordinatorPhase: nativeRunFinalizations.phase,
      resultId: nativeRunFinalizations.resultId,
      assessmentId: nativeRunFinalizations.assessmentId,
      decisionId: nativeRunFinalizations.decisionId,
      nativeWorkspaceSync: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`,
      nativeStatusWakeIntentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'nativeStatusWakeIntentId'`,
    })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .innerJoin(issues, and(
      eq(issues.id, nativeRunFinalizations.issueId),
      eq(issues.companyId, heartbeatRuns.companyId),
    ))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNotNull(nativeRunFinalizations.resultId),
      notInArray(nativeRunFinalizations.phase, ["terminal_failure"]),
      or(
        isNull(nativeRunFinalizations.nextAttemptAt),
        lte(nativeRunFinalizations.nextAttemptAt, new Date()),
      ),
      or(
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.leaseExpiresAt),
        lte(nativeRunFinalizations.leaseExpiresAt, new Date()),
      ),
      ...(runIds && runIds.length > 0 ? [inArray(heartbeatRuns.id, runIds)] : []),
      ...(unscoped
        ? [upkeepRunIds.length > 0
          ? or(not(settledCommittedFinalization(now)), inArray(heartbeatRuns.id, upkeepRunIds))!
          : not(settledCommittedFinalization(now))]
        : []),
    ));
  timing.candidates(rows.length);
  timing.phase("candidates");
  const results = [];
  for (const row of rows) {
    const pendingEffects = row.decisionId
      ? await db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(and(
          eq(statusDecisionEffects.companyId, row.companyId),
          eq(statusDecisionEffects.issueId, row.issueId),
          eq(statusDecisionEffects.decisionId, row.decisionId),
          inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]),
        ))
      : [];
    if (row.decisionId && pendingEffects.length > 0) {
      const decision = resolveNativeReconciliationStatus({
        facts: { undeliveredEffectCount: pendingEffects.length },
        priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus,
        agentId: row.agentId,
      });
      if (!decision.effects.some((effect) => effect.kind === "dispatch_pending_effect")) {
        throw new Error("native_reconciliation_pending_effect_policy_missing");
      }
      const deliveredEffectIds = await dispatchPendingNativeStatusEffects({
        db,
        companyId: row.companyId,
        issueId: row.issueId,
        decisionId: row.decisionId,
        runId: row.runId,
      });
      results.push({ runId: row.runId, phase: "committed", deliveredEffectIds });
      continue;
    }
    if (row.assessmentId) {
      const assessment = await db.select({
        id: workAssessments.id,
        contractId: workAssessments.contractId,
        resultId: workAssessments.resultId,
        policyVersion: workAssessments.policyVersion,
        priorIssueStatus: workAssessments.priorIssueStatus,
        priorStatusVersion: workAssessments.priorStatusVersion,
        priorDecisionId: workAssessments.priorDecisionId,
        assessmentJson: workAssessments.assessmentJson,
        createdAt: workAssessments.createdAt,
      }).from(workAssessments).where(and(
        eq(workAssessments.id, row.assessmentId),
        eq(workAssessments.companyId, row.companyId),
        eq(workAssessments.issueId, row.issueId),
      )).limit(1).then((entries) => entries[0] ?? null);
      const changedEvidence = assessment
        ? await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
            eq(issueWorkProducts.companyId, row.companyId),
            eq(issueWorkProducts.issueId, row.issueId),
            or(
              gt(issueWorkProducts.createdAt, assessment.createdAt),
              gt(issueWorkProducts.updatedAt, assessment.createdAt),
            ),
          )).limit(1).then((entries) => entries[0] ?? null)
        : null;
      const currentDecision = row.decisionId
        ? await db.select().from(statusDecisions).where(and(
            eq(statusDecisions.id, row.decisionId),
            eq(statusDecisions.companyId, row.companyId),
            eq(statusDecisions.issueId, row.issueId),
          )).limit(1).then((entries) => entries[0] ?? null)
        : null;
      const currentDecisionJson = record(currentDecision?.decisionJson);
      if (row.coordinatorPhase === "committed") {
        // A later decision can supersede this run's task status, but cannot
        // erase its accepted, still-authorized response. Repair presentation
        // before the status-only early return below, without rerunning work.
        await repairCommittedNativeChatResponse(db, {
          companyId: row.companyId, issueId: row.issueId, runId: row.runId,
        });
      }
      if (
        row.coordinatorPhase === "committed" &&
        row.decisionId &&
        row.resultId &&
        row.assessmentId &&
        currentDecisionJson.externalChatReviewPresentation
      ) {
        // A later chat turn may retain the same pending review. Recover the
        // earlier response independently before status reconciliation skips
        // its superseded decision; this cannot change issue disposition.
        await repairCommittedNativeReviewResponse(db, {
          companyId: row.companyId,
          issueId: row.issueId,
          runId: row.runId,
          decisionId: row.decisionId,
          resultId: row.resultId,
          assessmentId: row.assessmentId,
        });
      }
      if (row.coordinatorPhase === "committed" && row.decisionId && !currentDecision) {
        throw new Error("native_committed_decision_missing");
      }
      const supersededCommittedDecision = row.coordinatorPhase === "committed"
        && row.decisionId !== null
        && row.issueDecisionId !== null
        && row.issueDecisionId !== row.decisionId
        && !(
          currentDecisionJson.statusAction === "preserve"
          && assessment?.priorDecisionId === row.issueDecisionId
        );
      if (supersededCommittedDecision) continue;
      const persistedProjectedVersion = Number(currentDecisionJson.projectedStatusVersion);
      const expectedProjectedVersion = currentDecision
        ? Number.isFinite(persistedProjectedVersion)
          ? persistedProjectedVersion
          : Number(currentDecision.decisionVersion) - (currentDecisionJson.statusAction === "preserve" ? 1 : 0)
        : null;
      const issueMatchesCurrentDecision = !!assessment
        && !!currentDecision
        && row.issueDecisionId === row.decisionId
        && currentDecision.assessmentId === assessment.id
        && currentDecision.toStatus === row.issueStatus
        && expectedProjectedVersion === Number(row.issueStatusVersion);
      const authoritativeStatusChanged = !!assessment && !issueMatchesCurrentDecision && (
        assessment.priorIssueStatus !== row.issueStatus
        || Number(assessment.priorStatusVersion) !== Number(row.issueStatusVersion)
      );
      const retiredAutomaticReview = issueMatchesCurrentDecision && currentDecision
        ? await decisionHasRetiredAutomaticReview(db, currentDecision) : false;
      let reassessment = null;
      let resultRow = null;
      let contractRow = null;
      if (assessment && (authoritativeStatusChanged || changedEvidence || retiredAutomaticReview)) {
        [resultRow, contractRow] = await Promise.all([
          db.select().from(nativeRunResults).where(and(
            eq(nativeRunResults.id, assessment.resultId),
            eq(nativeRunResults.companyId, row.companyId),
            eq(nativeRunResults.issueId, row.issueId),
            eq(nativeRunResults.runId, row.runId),
          )).limit(1).then((entries) => entries[0] ?? null),
          db.select().from(completionContracts).where(and(
            eq(completionContracts.id, assessment.contractId),
            eq(completionContracts.companyId, row.companyId),
            eq(completionContracts.issueId, row.issueId),
          )).limit(1).then((entries) => entries[0] ?? null),
        ]);
        if (!resultRow || !contractRow) throw new Error("native_reconciliation_evidence_binding_missing");
        reassessment = await classifyNativeEvidence({
          db,
          companyId: row.companyId,
          issueId: row.issueId,
          runId: row.runId,
          contract: record(contractRow.contractJson),
          result: record(record(resultRow.resultJson).result),
        });
      }
      const previousAssessment = record(assessment?.assessmentJson);
      const newEvidenceSatisfiesContract = !!changedEvidence
        && previousAssessment.allCriteriaSatisfied !== true
        && reassessment?.allCriteriaSatisfied === true
        && reassessment.verificationPassed === true;
      const facts: NativeReconciliationFacts = authoritativeStatusChanged
        ? { authoritativeStatusChanged: true }
        : newEvidenceSatisfiesContract
          ? { newEvidenceSatisfiesContract: true }
          : {};
      if (Object.keys(facts).length > 0 || retiredAutomaticReview) {
        if (!assessment || !reassessment || !resultRow || !contractRow) {
          throw new Error("native_reconciliation_reassessment_missing");
        }
        const currentIssue = retiredAutomaticReview
          ? await db.select().from(issues).where(and(eq(issues.id, row.issueId), eq(issues.companyId, row.companyId))).then((entries) => entries[0])
          : null;
        const readiness = retiredAutomaticReview ? await issueService(db).getDependencyReadiness(row.issueId, db) : null;
        const currentRun = retiredAutomaticReview ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.runId)).then((entries) => entries[0]) : null;
        // Never replay an old result over a new run or a later task contract.
        const latestContract = retiredAutomaticReview ? await db.select({ id: completionContracts.id }).from(completionContracts)
          .where(and(eq(completionContracts.companyId, row.companyId), eq(completionContracts.issueId, row.issueId)))
          .orderBy(desc(completionContracts.revision)).limit(1).then((entries) => entries[0]) : null;
        if (retiredAutomaticReview && (!currentIssue || currentRun?.status !== "succeeded"
          || latestContract?.id !== contractRow.id
          || (currentIssue.executionRunId && currentIssue.executionRunId !== row.runId))) continue;
        // A committed decision proves the original barrier passed. If a later
        // workspace operation exists, do not ignore a pending or failed retry.
        const reviewBarrier = retiredAutomaticReview ? await db.select({ status: workspaceOperations.status })
          .from(workspaceOperations).where(and(eq(workspaceOperations.companyId, row.companyId),
            eq(workspaceOperations.heartbeatRunId, row.runId), eq(workspaceOperations.phase, "workspace_finalize")))
          .orderBy(desc(workspaceOperations.createdAt)).limit(1).then((entries) => entries[0]) : null;
        if (reviewBarrier && reviewBarrier.status !== "succeeded") continue;
        const childCompletionRecipient = {
          companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, runId: row.runId,
          sourceIntentId: typeof row.nativeStatusWakeIntentId === "string" ? row.nativeStatusWakeIntentId : null,
        };
        const hasPendingChildCompletion = await hasPendingNativeChildCompletion(db, childCompletionRecipient);
        const reassessmentRow = await recordNativeWorkAssessment({
          db,
          companyId: row.companyId,
          issueId: row.issueId,
          runId: row.runId,
          turnId: resultRow.turnId,
          contractId: contractRow.id,
          contractCanonicalSha256: contractRow.canonicalSha256,
          resultId: resultRow.id,
          resultCanonicalSha256: resultRow.canonicalSha256,
          priorIssueStatus: row.issueStatus,
          priorStatusVersion: Number(row.issueStatusVersion),
          priorDecisionId: row.issueDecisionId,
          policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
          assessment: reassessment,
          supersedesAssessmentId: assessment.id,
        });
        const decision = retiredAutomaticReview && currentIssue
          ? resolveNativeFinalizerStatus({
              hasPendingChildCompletion,
              assessment: reassessment, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded",
              governanceGate: await pendingNativeGovernance({ db, companyId: row.companyId, issueId: row.issueId,
                runId: row.runId, executionState: record(currentIssue.executionState) }),
              completionClaimPolicyAccepted: contractRow.risk === "low" && contractRow.completionAuthority === "agent_claim_policy",
              hasUnresolvedIssueBlockers: (readiness?.unresolvedBlockerCount ?? 0) > 0,
              reviewOwnerUserId: currentIssue.responsibleUserId ?? currentIssue.createdByUserId,
              priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus, agentId: row.agentId,
            })
          : resolveNativeReconciliationStatus({
              facts: { ...facts, hasPendingChildCompletion },
              priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus, agentId: row.agentId,
            });
        let committed: Awaited<ReturnType<typeof commitNativeStatusDecision>>;
        try {
          committed = await commitNativeStatusDecision({
            db,
            companyId: row.companyId,
            issueId: row.issueId,
            runId: row.runId,
            assessmentId: reassessmentRow.id,
            priorStatus: row.issueStatus,
            priorStatusVersion: Number(row.issueStatusVersion),
            priorDecisionId: row.issueDecisionId,
            decision,
            requireNoPendingChildCompletion: decision.statusAction === "done" ? childCompletionRecipient : undefined,
            supersedesCommittedDecisionId: row.coordinatorPhase === "committed"
              ? row.decisionId ?? undefined
              : undefined,
          });
        } catch (error) {
          if (error instanceof NativeStatusRaceError) continue;
          throw error;
        }
        results.push({
          runId: row.runId,
          phase: "committed",
          reconciliationAction: decision.reasonCode,
          decisionId: committed.decision.id,
          reconciliationDecision: decision,
        });
        continue;
      }
    }
    const barrier = await db.select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.heartbeatRunId, row.runId),
        eq(workspaceOperations.phase, "workspace_finalize"),
      ))
      .orderBy(desc(workspaceOperations.createdAt))
      .limit(1)
      .then((entries) => entries[0] ?? null);
    if (!barrier || barrier.status !== "succeeded") {
      const recoveryDecision = resolveNativeReconciliationStatus({
        facts: { workspaceOperationPending: true },
        priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus,
        agentId: row.agentId,
      });
      if (!recoveryDecision.effects.some((effect) => effect.kind === "resume_workspace_operation")) {
        throw new Error("native_reconciliation_workspace_resume_policy_missing");
      }
      const operation = await resumeNativeWorkspaceFinalization({
        db,
        runId: row.runId,
        environmentRuntime: options.environmentRuntime,
        pluginWorkerManager: options.pluginWorkerManager,
      });
      // Busy is ownership, not another failed export or retry-budget debit.
      if (!operation) continue;
      const workspaceFinalizeStatus =
        operation.status === "succeeded" ? "succeeded" : "failed";
      if (workspaceFinalizeStatus === "failed") {
        const unrecoverable = operation.stderrExcerpt?.includes(
          "workspace_sync_out_unrecoverable",
        );
        const pluginFailure = operation.stderrExcerpt?.trim();
        const pluginRepair = pluginFailure === "plugin_workspace_branch_mismatch" || pluginFailure === "plugin_workspace_owner_mismatch";
        const failure = await recordNativeFinalizationFailure({
          db,
          runId: row.runId,
          error: new Error(
            pluginRepair ? `native_${pluginFailure}` : unrecoverable
              ? "native_workspace_sync_out_unrecoverable"
              : "native_workspace_sync_out_failed",
          ),
          projectRunStatus: true,
          failureScope: "workspace",
          permanent: unrecoverable,
        });
        results.push({
          ...failure,
          reconciliationAction: "resume_workspace_operation" as const,
          workspaceOperationId: operation.id,
          workspaceFinalizeStatus,
          reconciliationDecision: recoveryDecision,
        });
        if (failure.phase === "terminal_failure") {
          await options
            .onWorkspaceSettled?.({
              runId: row.runId,
              companyId: row.companyId,
              agentId: row.agentId,
              succeeded: false,
            })
            .catch(() => undefined);
        }
        continue;
      }
      try {
        const finalized = await finalizeNativeRun({
          db,
          runId: row.runId,
          workspaceFinalizeStatus,
          projectRunStatus: true,
          preserveProviderAttempt: Boolean(
            readNativeWorkspaceSyncReference(
              row.nativeWorkspaceSync,
            ),
          ),
        });
        results.push({
          ...finalized,
          reconciliationAction: "resume_workspace_operation" as const,
          workspaceOperationId: operation.id,
          workspaceFinalizeStatus,
          reconciliationDecision: recoveryDecision,
        });
        if (
          workspaceFinalizeStatus === "succeeded" &&
          finalized.phase === "committed"
        ) {
          await cleanupNativeWorkspaceSync(row.runId).catch(() => undefined);
          await options
            .onWorkspaceSettled?.({
              runId: row.runId,
              companyId: row.companyId,
              agentId: row.agentId,
              succeeded: true,
            })
            .catch(() => undefined);
        }
      } catch (error) {
        const failure = await recordNativeFinalizationFailure({
          db,
          runId: row.runId,
          error,
          projectRunStatus: true,
        });
        results.push({
          ...failure,
          reconciliationAction: "resume_workspace_operation" as const,
          workspaceOperationId: operation.id,
          workspaceFinalizeStatus,
          reconciliationDecision: recoveryDecision,
        });
      }
      continue;
    }
    const replayDecision = resolveNativeReconciliationStatus({
      facts: { canonicalReplay: true },
      priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus,
      agentId: row.agentId,
    });
    if (replayDecision.reasonCode !== "completion_contract_satisfied") {
      throw new Error("native_reconciliation_replay_policy_invalid");
    }
    try {
      const finalized = await finalizeNativeRun({
        db,
        runId: row.runId,
        workspaceFinalizeStatus: barrier.status as "succeeded" | "failed",
        projectRunStatus: true,
        preserveProviderAttempt: Boolean(
          readNativeWorkspaceSyncReference(
            row.nativeWorkspaceSync,
          ),
        ),
      });
      results.push(finalized);
      if (finalized.phase === "committed") {
        await cleanupNativeWorkspaceSync(row.runId).catch(() => undefined);
        await options
          .onWorkspaceSettled?.({
            runId: row.runId,
            companyId: row.companyId,
            agentId: row.agentId,
            succeeded: true,
          })
          .catch(() => undefined);
      }
    } catch (error) {
      results.push(await recordNativeFinalizationFailure({
        db,
        runId: row.runId,
        error,
        projectRunStatus: true,
      }));
    }
  }
  return results;
}
