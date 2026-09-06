import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  completionContracts,
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
import { finalizeNativeRun, recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import {
  commitNativeStatusDecision,
  dispatchPendingNativeStatusEffects,
  NativeStatusRaceError,
} from "./status-decision-committer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueService } from "../issues.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";
import {
  cleanupNativeWorkspaceSync,
  readNativeWorkspaceSyncReference,
} from "./native-workspace-sync.js";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";

export type NativeReconciliationFacts = {
  equivalentAttentionFamily?: boolean;
  canonicalReplay?: boolean;
  callerMaterialConflict?: boolean;
  workspaceOperationPending?: boolean;
  undeliveredEffectCount?: number;
  authoritativeStatusChanged?: boolean;
  newEvidenceSatisfiesContract?: boolean;
  dependencyResolved?: boolean;
  authorizedResume?: boolean;
  policyVersionChanged?: boolean;
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
  if (input.facts.policyVersionChanged) {
    if (["done", "cancelled"].includes(input.priorIssueStatus)) {
      return preserve("prior_status_terminal_preserved", [{ kind: "append_superseding_assessment" }]);
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "completion_review_required",
      unblockDescriptor: null,
      effects: [
        { kind: "bind_reviewer", prompt: "Review the superseding native policy assessment.", ownerUserId: null },
        { kind: "append_superseding_assessment" },
      ],
    };
  }
  if (input.facts.statusVersionAdvanced) {
    return preserve("arbitration_conflict_reloaded", [
      { kind: "increment_status_version" },
      { kind: "schedule_reconciliation" },
    ]);
  }
  if (input.facts.newEvidenceSatisfiesContract) {
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
  const candidates = await input.db.select({ runId: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNull(heartbeatRuns.processPid),
      isNull(heartbeatRuns.processGroupId),
      isNull(nativeRunFinalizations.resultId),
      eq(nativeRunFinalizations.phase, "retryable_failure"),
      or(isNull(nativeRunFinalizations.nextAttemptAt), lte(nativeRunFinalizations.nextAttemptAt, now)),
      or(
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.leaseExpiresAt),
        lte(nativeRunFinalizations.leaseExpiresAt, now),
      ),
      ...(input.runIds?.length ? [inArray(heartbeatRuns.id, input.runIds)] : []),
    ))
    .limit(input.limit ?? 25);

  const claims: NativeSessionResumeClaim[] = [];
  for (const candidate of candidates) {
    const leaseOwner = `${input.runnerInstanceId}:resume:${randomUUID()}`;
    let terminalRunToEmit: typeof heartbeatRuns.$inferSelect | null = null;
    const claimed = await input.db.transaction(async (tx) => {
      const row = await tx.select({
        run: heartbeatRuns,
        coordinator: nativeRunFinalizations,
      }).from(heartbeatRuns)
        .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
        .where(eq(heartbeatRuns.id, candidate.runId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) return false;
      if (
        row.run.runtimeMode !== "native"
        || row.run.processPid !== null
        || row.run.processGroupId !== null
        || row.coordinator.resultId
        || row.coordinator.phase !== "retryable_failure"
        || (row.coordinator.nextAttemptAt && row.coordinator.nextAttemptAt > now)
        || (
          row.coordinator.leaseOwner
          && row.coordinator.leaseExpiresAt
          && row.coordinator.leaseExpiresAt > now
        )
        || !["running", "failed"].includes(row.run.status)
      ) return false;

      const profile = row.run.runnerProfileJson ?? {};
      const persistedInput = profile.nativeExecutionInput;
      const checkpoint = profile.sessionCheckpoint;
      const failureDetail = record(row.coordinator.failureDetail);
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
        terminalRunToEmit = updatedRun ?? null;
        await issueService(tx as unknown as Db).update(
          row.coordinator.issueId,
          { status: "in_review" },
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
      return true;
    });
    // Telemetry is best-effort background work; it must not delay claiming
    // the remaining candidates in this loop, so fire it and do not await it.
    if (terminalRunToEmit) {
      void emitAgentTaskRun(input.db, terminalRunToEmit);
    }
    if (claimed) claims.push({ runId: candidate.runId, leaseOwner });
  }
  return claims;
}

/** Recovery is keyed only by persisted mode/coordinator state, never the live flag. */
export async function reconcileNativeFinalizations(
  db: Db,
  runIds?: string[],
  options: {
    environmentRuntime?: EnvironmentRuntimeService;
    onWorkspaceSettled?: (input: {
      runId: string;
      companyId: string;
      agentId: string;
      succeeded: boolean;
    }) => Promise<void>;
  } = {},
) {
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
      assessmentId: nativeRunFinalizations.assessmentId,
      decisionId: nativeRunFinalizations.decisionId,
      runnerProfileJson: heartbeatRuns.runnerProfileJson,
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
    ));
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
      const policyVersionChanged = assessment?.policyVersion !== NATIVE_STATUS_ARBITER_POLICY_VERSION;
      const currentDecision = row.decisionId
        ? await db.select({
            assessmentId: statusDecisions.assessmentId,
            decisionVersion: statusDecisions.decisionVersion,
            toStatus: statusDecisions.toStatus,
            decisionJson: statusDecisions.decisionJson,
          }).from(statusDecisions).where(and(
            eq(statusDecisions.id, row.decisionId),
            eq(statusDecisions.companyId, row.companyId),
            eq(statusDecisions.issueId, row.issueId),
          )).limit(1).then((entries) => entries[0] ?? null)
        : null;
      const currentDecisionJson = record(currentDecision?.decisionJson);
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
      let reassessment = null;
      let resultRow = null;
      let contractRow = null;
      if (assessment && (policyVersionChanged || authoritativeStatusChanged || changedEvidence)) {
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
        : policyVersionChanged
          ? { policyVersionChanged: true }
          : newEvidenceSatisfiesContract
            ? { newEvidenceSatisfiesContract: true }
            : {};
      if (Object.keys(facts).length > 0) {
        if (!assessment || !reassessment || !resultRow || !contractRow) {
          throw new Error("native_reconciliation_reassessment_missing");
        }
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
        const decision = resolveNativeReconciliationStatus({
          facts,
          priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus,
          agentId: row.agentId,
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
      });
      const workspaceFinalizeStatus =
        operation.status === "succeeded" ? "succeeded" : "failed";
      if (workspaceFinalizeStatus === "failed") {
        const unrecoverable = operation.stderrExcerpt?.includes(
          "workspace_sync_out_unrecoverable",
        );
        const failure = await recordNativeFinalizationFailure({
          db,
          runId: row.runId,
          error: new Error(
            unrecoverable
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
              record(row.runnerProfileJson).nativeWorkspaceSync,
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
            record(row.runnerProfileJson).nativeWorkspaceSync,
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
