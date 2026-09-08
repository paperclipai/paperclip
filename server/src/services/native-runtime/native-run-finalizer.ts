import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  completionContracts,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import type { PrpIgnoredAttentionRequest } from "@paperclipai/paperclip-runner";
import {
  arbitrateNativeStatus,
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeGovernanceGate,
} from "./status-arbiter.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import {
  commitNativeStatusDecision,
  NativeStatusRaceError,
  type NativeStatusCommitFailpoint,
} from "./status-decision-committer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueService } from "../issues.js";
import { nativeSha256 } from "./canonical.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function authoritativeStatus(value: string): NativeAuthoritativeIssueStatus {
  if (!["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"].includes(value)) {
    throw new Error("native_issue_status_invalid");
  }
  return value as NativeAuthoritativeIssueStatus;
}

function isCommittedAuditOnlyRouting(value: unknown) {
  const receipts = record(value).nativeAttentionRouting;
  return Array.isArray(receipts) && receipts.length > 0 && receipts.every((candidate) => {
    const receipt = record(candidate);
    const targets = receipt.materializedTargets;
    return receipt.decisionId === null
      && receipt.reasonCode === "attention_duplicate_suppressed"
      && Array.isArray(targets)
      && targets.length > 0;
  });
}

/** Server-owned terminal conversion used by live finalization and read models. */
export function projectNativeTerminalRunStatus(
  terminalState: "succeeded" | "failed" | "cancelled" | "active",
) {
  return terminalState === "active" ? "running" as const : terminalState;
}

/** Fact-based arbitration at the production finalization authority seam. */
export function resolveNativeFinalizerStatus(input: Parameters<typeof arbitrateNativeStatus>[0]) {
  return arbitrateNativeStatus(input);
}

async function pendingNativeGovernance(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  executionState: Record<string, unknown> | null;
}): Promise<NativeGovernanceGate | null> {
  // Execution policy is issue-owned state and takes priority over the two
  // durable review surfaces. Completion must mediate all three authorities.
  if (record(input.executionState).status === "pending") {
    return { kind: "execution_stage", id: input.runId };
  }
  const [pendingInteraction, pendingApproval] = await Promise.all([
    input.db.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.db.select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        eq(approvals.companyId, input.companyId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (pendingInteraction) return { kind: "interaction", id: pendingInteraction.id };
  if (pendingApproval) return { kind: "approval", id: pendingApproval.id };
  return null;
}

async function acceptedInteractionFromRun(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
}) {
  return input.db.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.sourceRunId, input.runId),
      eq(issueThreadInteractions.status, "accepted"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function claimCoordinator(input: {
  db: Db;
  runId: string;
  preserveProviderAttempt?: boolean;
}) {
  const leaseOwner = `native-finalizer:${randomUUID()}`;
  const now = new Date();
  const claimed = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, input.runId)).for("update").limit(1)
      .then((rows) => rows[0] ?? null);
    if (!coordinator?.resultId) throw new Error("native_finalization_missing");
    if (coordinator.phase === "committed") {
      if (!coordinator.decisionId) {
        const run = await tx.select({ resultJson: heartbeatRuns.resultJson })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, coordinator.runId),
            eq(heartbeatRuns.companyId, coordinator.companyId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!run || !isCommittedAuditOnlyRouting(run.resultJson)) {
          throw new Error("native_finalization_committed_outcome_missing");
        }
      }
      return { coordinator, leaseOwner: null };
    }
    if (coordinator.phase === "terminal_failure") throw new Error("native_finalization_terminal_failure");
    if (
      coordinator.leaseOwner &&
      coordinator.leaseExpiresAt &&
      coordinator.leaseExpiresAt > now &&
      coordinator.leaseOwner !== leaseOwner
    )
      throw new Error("native_finalization_lease_busy");
    const [updated] = await tx
      .update(nativeRunFinalizations)
      .set({
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
        attempt: input.preserveProviderAttempt
          ? coordinator.attempt
          : coordinator.attempt + 1,
        phase:
          coordinator.phase === "retryable_failure"
            ? coordinator.assessmentId
              ? "arbitrating"
              : "workspace_finalizing"
            : coordinator.phase,
        failureCode: null,
        failureDetail: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(nativeRunFinalizations.runId, input.runId))
      .returning();
    if (!updated) throw new Error("native_finalization_claim_failed");
    return { coordinator: updated, leaseOwner };
  });
  return claimed;
}

async function recordRetryableFailure(input: {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
  failureCode: string;
  message: string;
  nextAction: string;
  projectRunStatus?: boolean;
  failureScope?: "provider" | "workspace";
  permanent?: boolean;
}) {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + 30_000);
  const acceptedRunTerminalState = record(input.run.resultJson).prpRunTerminalState;
  const exhaustedRunStatus = acceptedRunTerminalState === "succeeded"
    ? "succeeded" as const
    : acceptedRunTerminalState === "cancelled"
      ? "cancelled" as const
      : "failed" as const;
  let terminalRunToEmit: typeof heartbeatRuns.$inferSelect | null = null;
  const outcome = await input.db.transaction(async (tx) => {
    const issue = await tx.select({
      lastStatusDecisionId: issues.lastStatusDecisionId,
    }).from(issues).where(and(
      eq(issues.id, input.coordinator.issueId),
      eq(issues.companyId, input.run.companyId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    const latestDecision = issue?.lastStatusDecisionId
      ? await tx.select({
          runId: workAssessments.runId,
        }).from(statusDecisions)
          .innerJoin(workAssessments, eq(statusDecisions.assessmentId, workAssessments.id))
          .where(and(
            eq(statusDecisions.id, issue.lastStatusDecisionId),
            eq(statusDecisions.companyId, input.run.companyId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const latestDecisionRun = latestDecision?.runId && latestDecision.runId !== input.run.id
      ? await tx.select({ createdAt: heartbeatRuns.createdAt })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, latestDecision.runId),
            eq(heartbeatRuns.companyId, input.run.companyId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    // A finalizer belongs to one immutable run result. If a later run already
    // committed the issue's authoritative decision, this older coordinator is
    // audit-only: retrying or escalating it must never reopen the newer result.
    const supersededByNewerRun = Boolean(
      latestDecisionRun && latestDecisionRun.createdAt > input.run.createdAt,
    );
    const priorFailureDetail = record(input.coordinator.failureDetail);
    const workspaceFinalizeAttempt =
      input.failureScope === "workspace"
        ? (typeof priorFailureDetail.workspaceFinalizeAttempt === "number" &&
          Number.isInteger(priorFailureDetail.workspaceFinalizeAttempt) &&
          priorFailureDetail.workspaceFinalizeAttempt >= 0
            ? priorFailureDetail.workspaceFinalizeAttempt
            : 0) + 1
        : null;
    const exhausted =
      input.permanent === true ||
      (workspaceFinalizeAttempt !== null
        ? workspaceFinalizeAttempt >= 3
        : input.coordinator.attempt >= 3);
    const phase =
      supersededByNewerRun || exhausted
        ? ("terminal_failure" as const)
        : ("retryable_failure" as const);
    const failureCode = supersededByNewerRun
      ? "native_finalization_superseded"
      : input.permanent
        ? input.failureCode
        : exhausted
          ? input.failureScope === "workspace"
            ? "native_workspace_sync_out_retry_exhausted"
            : "native_finalization_retry_exhausted"
          : input.failureCode;
    await tx
      .update(nativeRunFinalizations)
      .set({
        phase,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode,
        failureDetail: {
          message: input.message.slice(0, 2_000),
          originalFailureCode: input.failureCode,
          ...(workspaceFinalizeAttempt === null
            ? {}
            : { workspaceFinalizeAttempt }),
          recoveryOwner: supersededByNewerRun
            ? { kind: "none", reason: "newer_native_decision" }
            : exhausted
              ? { kind: "board" }
              : { kind: "agent", agentId: input.run.agentId },
          nextAction: input.nextAction,
        },
        nextAttemptAt: supersededByNewerRun || exhausted ? null : nextAttemptAt,
        updatedAt: now,
      })
      .where(eq(nativeRunFinalizations.runId, input.run.id));
    const projectsTerminalStatus =
      exhausted && !supersededByNewerRun && input.projectRunStatus;
    const [updatedRun] = await tx
      .update(heartbeatRuns)
      .set({
        ...(projectsTerminalStatus
          ? {
              status:
                input.failureScope === "workspace"
                  ? "failed"
                  : exhaustedRunStatus,
              finishedAt: input.run.finishedAt ?? now,
            }
          : {}),
        nativePhase: phase,
        nativePhaseUpdatedAt: now,
        resultJson: {
          ...record(input.run.resultJson),
          finalizationPhase: phase,
          failureCode,
          originalFailureCode: input.failureCode,
          nextAttemptAt:
            supersededByNewerRun || exhausted
              ? null
              : nextAttemptAt.toISOString(),
        },
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, input.run.id))
      .returning();
    if (projectsTerminalStatus) terminalRunToEmit = updatedRun ?? null;
    if (supersededByNewerRun) {
      await issueRecoveryActionService(tx as unknown as Db).resolveActiveForIssue({
        companyId: input.run.companyId,
        sourceIssueId: input.coordinator.issueId,
        cause: input.failureCode,
        fingerprint: nativeSha256({ runId: input.run.id, failureCode: input.failureCode }),
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "A newer native run already committed the authoritative issue decision; the stale finalizer was retired without changing issue state.",
      }, tx);
    } else if (exhausted) {
      await issueService(tx as unknown as Db).update(
        input.coordinator.issueId,
        {
          status:
            input.permanent && input.failureScope === "workspace"
              ? "blocked"
              : "in_review",
        },
        tx,
      );
    }
    if (!supersededByNewerRun) {
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: input.run.companyId,
        sourceIssueId: input.coordinator.issueId,
        kind: "active_run_watchdog",
        ownerType: exhausted ? "board" : "agent",
        ownerAgentId: exhausted ? null : input.run.agentId,
        returnOwnerAgentId: input.run.agentId,
        cause: failureCode,
        fingerprint: nativeSha256({ runId: input.run.id, failureCode }),
        evidence: {
          runId: input.run.id,
          coordinatorAttempt: input.coordinator.attempt,
          ...(workspaceFinalizeAttempt === null
            ? {}
            : { workspaceFinalizeAttempt }),
          originalFailureCode: input.failureCode,
        },
        nextAction: exhausted
          ? input.permanent
            ? input.nextAction
            : `Finalization retry budget exhausted. ${input.nextAction}`
          : input.nextAction,
        wakePolicy: exhausted
          ? null
          : { kind: "resume_native_run", runId: input.run.id, notBefore: nextAttemptAt.toISOString() },
        maxAttempts: 3,
        supersedeOnIdentityChange: true,
      });
    }
    return { phase, failureCode, nextAttemptAt: supersededByNewerRun || exhausted ? null : nextAttemptAt };
  });
  if (terminalRunToEmit) await emitAgentTaskRun(input.db, terminalRunToEmit);
  return {
    ...input.coordinator,
    ...outcome,
  };
}

/** Converts malformed or incomplete persisted finalization state into named recovery. */
export async function recordNativeFinalizationFailure(input: {
  db: Db;
  runId: string;
  error: unknown;
  projectRunStatus?: boolean;
  failureScope?: "provider" | "workspace";
  permanent?: boolean;
}) {
  const [run, coordinator] = await Promise.all([
    input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId))
      .limit(1).then((rows) => rows[0] ?? null),
    input.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId))
      .limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!run || run.runtimeMode !== "native" || !coordinator) throw input.error;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const failureCode = message.startsWith("native_") ? message : "native_finalization_invalid";
  return recordRetryableFailure({
    db: input.db,
    run,
    coordinator,
    failureCode,
    message,
    nextAction:
      input.failureScope === "workspace"
        ? input.permanent
          ? "Restore the exact sandbox containing the unexported workspace changes, or resolve the task manually from durable evidence."
          : "Retry workspace export and merge from the retained sandbox; do not submit another provider turn."
        : "Repair the persisted native result or contract discriminator, then resume finalization from the coordinator.",
    projectRunStatus: input.projectRunStatus,
    failureScope: input.failureScope,
    permanent: input.permanent,
  });
}

async function projectCommittedRun(input: {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
}) {
  if (!input.coordinator.resultId) return;
  const resultRow = await input.db.select({ resultJson: nativeRunResults.resultJson })
    .from(nativeRunResults).where(and(
      eq(nativeRunResults.id, input.coordinator.resultId),
      eq(nativeRunResults.runId, input.run.id),
      eq(nativeRunResults.companyId, input.run.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
  const terminalState = record(record(resultRow?.resultJson).terminal).runTerminalState;
  if (!["succeeded", "failed", "cancelled"].includes(String(terminalState))) {
    throw new Error("native_finalization_invalid");
  }
  const now = new Date();
  const [updatedRun] = await input.db.update(heartbeatRuns).set({
    status: projectNativeTerminalRunStatus(terminalState as "succeeded" | "failed" | "cancelled"),
    finishedAt: input.run.finishedAt ?? now,
    nativePhase: "committed",
    nativePhaseUpdatedAt: now,
    updatedAt: now,
  }).where(and(
    eq(heartbeatRuns.id, input.run.id),
    eq(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, ["queued", "running", "failed"]),
  )).returning();
  // The WHERE clause above allows "failed" as a source status, so a run that
  // failed before its coordinator committed can still pick up the committed
  // terminal state. A later reconciliation replay can enter this same path
  // and match that clause again even when the committed state is still
  // "failed" — the write changes nothing. Emit only when the status
  // genuinely changed, so a reconciliation replay never emits twice for one
  // committed terminal result.
  if (updatedRun && updatedRun.status !== input.run.status) {
    await emitAgentTaskRun(input.db, updatedRun);
  }
}

export async function finalizeNativeRun(input: {
  db: Db;
  runId: string;
  workspaceFinalizeStatus: "succeeded" | "failed";
  /** Reconciliation owns terminal run projection; the live heartbeat does it afterward. */
  projectRunStatus?: boolean;
  /** Workspace-only replay must not consume the provider recovery budget. */
  preserveProviderAttempt?: boolean;
  failpoint?: NativeStatusCommitFailpoint;
}) {
  const run = await input.db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run || run.runtimeMode !== "native")
    throw new Error("native_finalization_run_missing");
  const claim = await claimCoordinator({
    db: input.db,
    runId: input.runId,
    preserveProviderAttempt: input.preserveProviderAttempt,
  });
  const coordinator = claim.coordinator;
  if (!claim.leaseOwner && coordinator.phase === "committed") {
    if (input.projectRunStatus) await projectCommittedRun({ db: input.db, run, coordinator });
    return coordinator;
  }
  const [resultRow, contractRow] = await Promise.all([
    input.db.select().from(nativeRunResults)
      .where(and(
        eq(nativeRunResults.id, coordinator.resultId!),
        eq(nativeRunResults.companyId, run.companyId),
      )).limit(1).then((rows) => rows[0] ?? null),
    input.db.select().from(completionContracts)
      .where(and(
        eq(completionContracts.id, run.completionContractId!),
        eq(completionContracts.companyId, run.companyId),
        eq(completionContracts.issueId, coordinator.issueId),
      )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!resultRow) throw new Error("native_result_missing");
  if (!contractRow) throw new Error("native_completion_contract_missing");
  const envelope = record(resultRow.resultJson);
  const result = record(envelope.result);
  const terminal = record(envelope.terminal);
  const terminalState = terminal.runTerminalState;
  if (!["succeeded", "failed", "cancelled"].includes(String(terminalState))) {
    throw new Error("native_finalization_invalid");
  }

  await input.db.update(nativeRunFinalizations).set({ phase: "ready_for_assessment", updatedAt: new Date() })
    .where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.leaseOwner, claim.leaseOwner!),
    ));
  const classifiedAssessment = await classifyNativeEvidence({
    db: input.db,
    companyId: run.companyId,
    issueId: coordinator.issueId,
    runId: run.id,
    contract: record(contractRow.contractJson),
    result,
  });
  const persistedIgnoredAttention = record(envelope.normalizationDiagnostics).ignoredAttentionRequests;
  const assessment = {
    ...classifiedAssessment,
    ignoredAttentionRequests: [
      ...(Array.isArray(persistedIgnoredAttention)
        ? persistedIgnoredAttention as PrpIgnoredAttentionRequest[]
        : []),
      ...classifiedAssessment.ignoredAttentionRequests,
    ],
  };

  let supersedesAssessmentId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authoritativeIssue = await input.db.select().from(issues).where(and(
      eq(issues.id, coordinator.issueId),
      eq(issues.companyId, run.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!authoritativeIssue) throw new Error("native_finalization_issue_missing");
    const governanceGate = await pendingNativeGovernance({
      db: input.db,
      companyId: run.companyId,
      issueId: authoritativeIssue.id,
      runId: run.id,
      executionState: record(authoritativeIssue.executionState),
    });
    const [dependencyReadiness, resolvedInteraction] = await Promise.all([
      issueService(input.db).getDependencyReadiness(authoritativeIssue.id, input.db),
      acceptedInteractionFromRun({
        db: input.db,
        companyId: run.companyId,
        issueId: authoritativeIssue.id,
        runId: run.id,
      }),
    ]);
    const decision = resolveNativeFinalizerStatus({
      assessment,
      terminalState: terminalState as "succeeded" | "failed" | "cancelled",
      workspaceFinalizeStatus: input.workspaceFinalizeStatus,
      governanceGate,
      completionClaimPolicyAccepted:
        contractRow.risk === "low" && contractRow.completionAuthority === "agent_claim_policy",
      hasUnresolvedIssueBlockers: dependencyReadiness.unresolvedBlockerCount > 0,
      governanceResolvedForRun: resolvedInteraction !== null,
      reviewOwnerUserId: authoritativeIssue.responsibleUserId ?? authoritativeIssue.createdByUserId ?? null,
      agentId: run.agentId,
      priorIssueStatus: authoritativeStatus(authoritativeIssue.status),
    });
    const assessmentRow = await recordNativeWorkAssessment({
      db: input.db,
      companyId: run.companyId,
      issueId: authoritativeIssue.id,
      runId: run.id,
      turnId: resultRow.turnId,
      contractId: resultRow.completionContractId,
      contractCanonicalSha256: contractRow.canonicalSha256,
      resultId: resultRow.id,
      resultCanonicalSha256: resultRow.canonicalSha256,
      priorIssueStatus: authoritativeIssue.status,
      priorStatusVersion: Number(authoritativeIssue.statusVersion),
      priorDecisionId: authoritativeIssue.lastStatusDecisionId,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessment,
      supersedesAssessmentId,
    });
    await input.db.update(nativeRunFinalizations).set({
      phase: "arbitrating",
      assessmentId: assessmentRow.id,
      updatedAt: new Date(),
    }).where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.leaseOwner, claim.leaseOwner!),
    ));
    try {
      const committed = await commitNativeStatusDecision({
        db: input.db,
        companyId: run.companyId,
        issueId: authoritativeIssue.id,
        runId: run.id,
        assessmentId: assessmentRow.id,
        priorStatus: authoritativeIssue.status,
        priorStatusVersion: Number(authoritativeIssue.statusVersion),
        priorDecisionId: authoritativeIssue.lastStatusDecisionId,
        decision,
        failpoint: input.failpoint,
      });
      const now = new Date();
      const finalizationFailed = decision.effects.some((effect) => effect.kind === "record_finalization_error");
      const finalizationPhase = finalizationFailed ? "retryable_failure" : "committed";
      // commitNativeStatusDecision() already committed its own transaction above.
      // Its "cancel_continuations" effect (status-decision-committer.ts) writes a
      // terminal status to this same run and emits for it. Skip the emit here in
      // that case so one run reaching a terminal state emits exactly one event.
      const alreadyEmittedByCommittedDecision = decision.effects.some(
        (effect) => effect.kind === "cancel_continuations",
      );
      const [updatedRun] = await input.db.update(heartbeatRuns).set({
        ...(input.projectRunStatus ? {
          status: terminalState === "succeeded" ? "succeeded" : terminalState === "cancelled" ? "cancelled" : "failed",
          finishedAt: now,
        } : {}),
        nativePhase: finalizationPhase,
        nativePhaseUpdatedAt: now,
        resultJson: {
          ...record(run.resultJson),
          finalizationPhase,
          assessmentId: assessmentRow.id,
          decisionId: committed.decision.id,
          authoritativeDecision: decision.toStatus,
          finalizationPolicyVersion: decision.policyVersion,
          finalizationReasonCode: decision.reasonCode,
          verificationCaveats: assessment.verificationCaveats,
          ignoredAttentionRequests: assessment.ignoredAttentionRequests,
          issueStatusBefore: authoritativeIssue.status,
          issueStatusAfter: committed.issue.status,
          statusVersionBefore: Number(authoritativeIssue.statusVersion),
          statusVersionAfter: Number(committed.issue.statusVersion),
          workspaceFinalizeStatus: input.workspaceFinalizeStatus,
        },
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, run.id)).returning();
      if (input.projectRunStatus && !alreadyEmittedByCommittedDecision && updatedRun) {
        await emitAgentTaskRun(input.db, updatedRun);
      }
      return { ...coordinator, phase: finalizationPhase, assessmentId: assessmentRow.id, decisionId: committed.decision.id };
    } catch (error) {
      if (error instanceof NativeStatusRaceError && attempt < 2) {
        supersedesAssessmentId = assessmentRow.id;
        continue;
      }
      return recordRetryableFailure({
        db: input.db,
        run,
        coordinator,
        failureCode: error instanceof NativeStatusRaceError ? "status_cas_exhausted" : "side_effect_planning_failed",
        message: error instanceof Error ? error.message : String(error),
        nextAction: error instanceof NativeStatusRaceError
          ? "Reassess against the latest authoritative issue status version."
          : "Retry atomic status and liveness materialization from the persisted assessment.",
        projectRunStatus: input.projectRunStatus,
      });
    }
  }
  throw new Error("native_finalization_status_race");
}
