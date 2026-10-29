import { notifyExternalAgentSettlement } from "../../modules/external-agents/index.js";
import { pendingNativeRunProjectionCondition } from "./native-run-projection.js";
import { nativeStatusReassessmentSourceIsSuperseded, reassessNativeStatusFromSource } from "./native-status-reassessment.js";
import { resolveNativeReconciliationStatus } from "./native-reconciliation-status.js";
export { resolveNativeReconciliationStatus, type NativeReconciliationFacts } from "./native-reconciliation-status.js";
import { pendingNativeStatusEffectsCondition } from "./native-pending-effect-work.js";
import { notifyUnsafeWorkspaceExportRunChange } from "../unsafe-workspace-export-notifications.js";
import { notifyCancelledWorkspacePreservation } from "../cancelled-workspace-preservation-notifications.js";
import { notifyInstructionCollection } from "../instruction-collection-notifications.js";
import type { WorkspaceWorkers } from "../plugin-workspaces.js";
import { recoverLegacyUnsafeWorkspaceExports } from "./native-workspace-export-recovery.js";
import { dismissAutomaticCompletionReviews } from "./automatic-completion-reviews.js";
import { logger } from "../../middleware/logger.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workspaceOperations,
} from "@paperclipai/db";
import {
  finalizeNativeRun,
  recordNativeFinalizationFailure,
  repairCommittedNativeReviewResponse,
  repairCommittedNativeChatResponse,
} from "./native-run-finalizer.js";
import {
  dispatchPendingNativeStatusEffects,
} from "./status-decision-committer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueService } from "../issues.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";
import { isNewTerminalRunFailure, reportRunFailure } from "../run-failure-report.js";
import { resumeNativeWorkspaceFinalization, recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";
import { dismissObsoleteNativePolicyReviews } from "./obsolete-policy-reviews.js";
import {
  cleanupNativeWorkspaceSync,
  readNativeWorkspaceSyncReference,
} from "./native-workspace-sync.js";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { createNativeReconciliationPassTiming } from "./native-reconciliation-timing.js";
import {
  isNativeRunnerOwnershipHeld,
  nativeRunnerOwnershipNotHeldCondition,
} from "./native-runner-ownership.js";
import {
  type NativeAuthoritativeIssueStatus,
} from "./status-arbiter.js";

import { getNativeReviewAssignment } from "./native-review-participant.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../recovery/pause-hold-guard.js";
import { readRunCancellation } from "../run-cancellation.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { retireSupersededNativeRetry } from "./native-superseded-retry.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type NativeSessionResumeClaim = { runId: string; leaseOwner: string };

export { reconcileRetainedNativeSessionCleanups } from "./retained-native-session-cleanup.js";

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
      if (!issue) return false;
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, candidate.runId),
        eq(nativeRunFinalizations.issueId, issue.id),
      )).for("update").limit(1);
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, candidate.runId),
        eq(heartbeatRuns.nativeIssueId, issue.id),
      )).for("update").limit(1);
      if (!run || !coordinator) return false;
      if (await retireSupersededNativeRetry(tx as unknown as Db, {
        run, coordinator, issueExecutionRunId: issue.executionRunId, now,
      })) return false;
      if (!["todo", "in_progress", "in_review"].includes(issue.status)) return false;
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
        await notifyExternalAgentSettlement(tx, { companyId: row.run.companyId, runId: row.run.id });
        await notifyInstructionCollection(tx, { companyId: row.run.companyId, runId: row.run.id });
        await notifyCancelledWorkspacePreservation(tx, { companyId: row.run.companyId, runId: row.run.id });
        await notifyUnsafeWorkspaceExportRunChange(tx, row.run);
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
  skipObsoletePolicyReviews?: boolean;
  skipAutomaticCompletionReviews?: boolean;
  skipUnsafeWorkspaceExports?: boolean;
  skipNativePendingEffects?: boolean;
  skipNativeResponsePresentation?: boolean;
  skipNativeReviewResponse?: boolean;
  skipNativeStatusReassessment?: boolean;
  skipNativeWorkspaceFinalization?: boolean;
  skipNativeResultCommit?: boolean;
  skipNativeRunProjection?: boolean;
  skipExternalConversationSettlement?: boolean;
  skipExternalAgentSettlement?: boolean;
  skipNativeRecoveryNotices?: boolean;
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
  if (!options.skipUnsafeWorkspaceExports) {
    timing.phase("legacy_workspace_exports");
    await recoverLegacyUnsafeWorkspaceExports(db, runIds).catch((err) => {
      logger.warn({ err }, "Historical unsafe export recovery remains pending");
    });
  }
  if (!options.skipObsoletePolicyReviews) {
    timing.phase("obsolete_policy_reviews");
    await dismissObsoleteNativePolicyReviews(db, runIds).catch((err) => {
      logger.warn({ err }, "Obsolete native policy review lookup failed; continuing native reconciliation");
    });
  }
  if (!options.skipAutomaticCompletionReviews) {
    timing.phase("automatic_completion_reviews");
    if (runIds?.length) {
      const scopes = await db.select({ issueId: nativeRunFinalizations.issueId }).from(nativeRunFinalizations)
        .where(inArray(nativeRunFinalizations.runId, runIds));
      for (const scope of scopes) await dismissAutomaticCompletionReviews(db, scope.issueId);
    } else {
      await dismissAutomaticCompletionReviews(db);
    }
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
      runProjectionPending: options.skipNativeRunProjection ? pendingNativeRunProjectionCondition(db) : sql<boolean>`false`,
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
      options.skipNativePendingEffects ? not(pendingNativeStatusEffectsCondition(db)) : undefined,
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
      if (options.skipNativePendingEffects) continue;
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
      const currentDecision = !options.skipNativeReviewResponse && row.coordinatorPhase === "committed" && row.decisionId
        ? await db.select().from(statusDecisions).where(and(
            eq(statusDecisions.id, row.decisionId), eq(statusDecisions.companyId, row.companyId),
            eq(statusDecisions.issueId, row.issueId),
          )).limit(1).then(entries => entries[0] ?? null)
        : null;
      if (row.coordinatorPhase === "committed" && !options.skipNativeResponsePresentation) {
        // A later decision can supersede this run's task status, but cannot
        // erase its accepted, still-authorized response. Repair presentation
        // before the status-only early return below, without rerunning work.
        await repairCommittedNativeChatResponse(db, {
          companyId: row.companyId, issueId: row.issueId, runId: row.runId,
        });
      }
      if (
        !options.skipNativeReviewResponse &&
        row.coordinatorPhase === "committed" &&
        row.decisionId &&
        row.resultId &&
        row.assessmentId &&
        record(currentDecision?.decisionJson).externalChatReviewPresentation
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
      const source = { ...row, assessmentId: row.assessmentId };
      if (options.skipNativeStatusReassessment) {
        if (await nativeStatusReassessmentSourceIsSuperseded(db, source)) continue;
      } else {
        const reassessed = await reassessNativeStatusFromSource(db, source);
        if (reassessed.kind !== "unchanged") {
          if (reassessed.kind === "committed") results.push(reassessed.result);
          continue;
        }
      }
    }


    if (options.skipNativeRunProjection && row.coordinatorPhase === "committed" && row.runProjectionPending) continue;
    const barrier = await db.select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.companyId, row.companyId),
        eq(workspaceOperations.issueId, row.issueId),
        eq(workspaceOperations.heartbeatRunId, row.runId),
        eq(workspaceOperations.phase, "workspace_finalize"),
      ))


      .orderBy(desc(sql`${workspaceOperations.status} = 'succeeded'`), desc(workspaceOperations.createdAt))
      .limit(1)
      .then((entries) => entries[0] ?? null);
    if (!barrier || barrier.status !== "succeeded") {
      if (options.skipNativeWorkspaceFinalization) continue;
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
        const failure = await recordNativeWorkspaceFinalizationFailure(db, row.runId, operation);
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
      if (options.skipNativeResultCommit && row.coordinatorPhase !== "committed") continue;
      try {
        const finalized = await finalizeNativeRun({
          db,
          runId: row.runId,
          workspaceFinalizeStatus,
          projectRunStatus: true,
          skipNativeResponsePresentation: options.skipNativeResponsePresentation,
          skipNativeReviewResponse: options.skipNativeReviewResponse,
        skipCommittedRunProjection: options.skipNativeRunProjection,
        skipExternalConversationSettlement: options.skipExternalConversationSettlement,
        skipExternalAgentSettlement: options.skipExternalAgentSettlement,
        skipNativeRecoveryNotices: options.skipNativeRecoveryNotices,
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
    if (options.skipNativeResultCommit && row.coordinatorPhase !== "committed") continue;
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
        skipNativeResponsePresentation: options.skipNativeResponsePresentation,
        skipNativeReviewResponse: options.skipNativeReviewResponse,
        skipCommittedRunProjection: options.skipNativeRunProjection,
        skipExternalConversationSettlement: options.skipExternalConversationSettlement,
        skipExternalAgentSettlement: options.skipExternalAgentSettlement,
        skipNativeRecoveryNotices: options.skipNativeRecoveryNotices,
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
