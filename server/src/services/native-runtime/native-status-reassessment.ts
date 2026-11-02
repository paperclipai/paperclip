import { readRequiredQualityReview } from "../required-quality-review.js";
import { hasNativeWorkspaceFinalizationOwner } from "./native-workspace-finalization-recovery-state.js";
import { and, desc, eq, gt, or } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issueWorkProducts, issues, nativeRunResults,
  statusDecisions, workAssessments, workspaceOperations, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { decisionHasRetiredAutomaticReview } from "./automatic-completion-reviews.js";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { hasPendingNativeChildCompletion } from "./native-child-completion-delivery.js";
import { resolveNativeReconciliationStatus, type NativeReconciliationFacts } from "./native-reconciliation-status.js";
import { pendingNativeGovernance, resolveNativeFinalizerStatus } from "./native-run-finalizer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeAuthoritativeIssueStatus, type NativeStatusDecision } from "./status-arbiter.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";

export type NativeStatusReassessmentSource = {
  runId: string; companyId: string; agentId: string; issueId: string;
  issueStatus: string; issueStatusVersion: number; issueDecisionId: string | null;
  coordinatorPhase: string; assessmentId: string; decisionId: string | null;
  nativeStatusWakeIntentId: unknown;
};

type Outcome = { kind: "unchanged" | "superseded" } | { kind: "deferred"; retry?: boolean } | {
  kind: "committed";
  result: { runId: string; phase: "committed"; reconciliationAction: string | null;
    decisionId: string; reconciliationDecision: NativeStatusDecision };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSupersededSource(
  row: NativeStatusReassessmentSource,
  decision: Record<string, unknown>,
  priorDecisionId: string | null | undefined,
): boolean {
  return row.coordinatorPhase === "committed"
    && row.decisionId !== null
    && row.issueDecisionId !== null
    && row.issueDecisionId !== row.decisionId
    && !(
      decision.statusAction === "preserve"
      && priorDecisionId === row.issueDecisionId
    );
}



export async function nativeStatusReassessmentSourceIsSuperseded(
  db: Db,
  row: NativeStatusReassessmentSource,
): Promise<boolean> {
  if (row.coordinatorPhase !== "committed" || row.decisionId === null
    || row.issueDecisionId === null || row.issueDecisionId === row.decisionId) return false;
  const [decision] = await db.select({ decisionJson: statusDecisions.decisionJson })
    .from(statusDecisions).where(and(eq(statusDecisions.id, row.decisionId),
      eq(statusDecisions.companyId, row.companyId), eq(statusDecisions.issueId, row.issueId))).limit(1);
  if (!decision) throw new Error("native_committed_decision_missing");
  const [assessment] = await db.select({ priorDecisionId: workAssessments.priorDecisionId })
    .from(workAssessments).where(and(eq(workAssessments.id, row.assessmentId),
      eq(workAssessments.companyId, row.companyId), eq(workAssessments.issueId, row.issueId))).limit(1);
  return isSupersededSource(row, record(decision.decisionJson), assessment?.priorDecisionId);
}

export async function reassessNativeStatusFromSource(
  db: Db,
  row: NativeStatusReassessmentSource,
  options: { onlyWhenDue?: boolean } = {},
): Promise<Outcome> {
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
  if (row.coordinatorPhase === "committed" && row.decisionId && !currentDecision) {
    throw new Error("native_committed_decision_missing");
  }
  if (isSupersededSource(row, currentDecisionJson, assessment?.priorDecisionId)) return { kind: "superseded" };
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
    const currentIssue = await db.select().from(issues)
      .where(and(eq(issues.id, row.issueId), eq(issues.companyId, row.companyId))).then((entries) => entries[0]);
    const readiness = retiredAutomaticReview ? await issueService(db).getDependencyReadiness(row.issueId, db) : null;
    const currentRun = retiredAutomaticReview ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.runId)).then((entries) => entries[0]) : null;
    const latestContract = retiredAutomaticReview ? await db.select({ id: completionContracts.id }).from(completionContracts)
      .where(and(eq(completionContracts.companyId, row.companyId), eq(completionContracts.issueId, row.issueId)))
      .orderBy(desc(completionContracts.revision)).limit(1).then((entries) => entries[0]) : null;
    if (retiredAutomaticReview && (!currentIssue || currentRun?.status !== "succeeded"
      || (options.onlyWhenDue && hasNativeWorkspaceFinalizationOwner(currentRun.runnerProfileJson))
      || latestContract?.id !== contractRow.id
      || (currentIssue.executionRunId && currentIssue.executionRunId !== row.runId))) return { kind: "deferred" };
    const reviewBarrier = retiredAutomaticReview ? await db.select({ status: workspaceOperations.status })
      .from(workspaceOperations).where(and(eq(workspaceOperations.companyId, row.companyId),
        eq(workspaceOperations.heartbeatRunId, row.runId), eq(workspaceOperations.phase, "workspace_finalize")))
      .orderBy(desc(workspaceOperations.createdAt)).limit(1).then((entries) => entries[0]) : null;
    if (reviewBarrier && reviewBarrier.status !== "succeeded") return { kind: "deferred" };
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
    const hasUnresolvedIssueBlockers = (readiness?.unresolvedBlockerCount ?? 0) > 0;
    const governanceGate = retiredAutomaticReview && currentIssue
      ? await pendingNativeGovernance({ db, companyId: row.companyId, issueId: row.issueId,
          runId: row.runId, executionState: record(currentIssue.executionState) }) : null;
    const qualityReview = currentIssue ? await readRequiredQualityReview(db, currentIssue) : null;
    let decision = retiredAutomaticReview && currentIssue
      ? resolveNativeFinalizerStatus({
          hasPendingChildCompletion,
          requiredQualityReviewSatisfied: qualityReview?.satisfied,
          assessment: reassessment, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded",
          governanceGate,
          completionClaimPolicyAccepted: contractRow.risk === "low" && contractRow.completionAuthority === "agent_claim_policy",
          hasUnresolvedIssueBlockers,
          reviewOwnerUserId: currentIssue.responsibleUserId ?? currentIssue.createdByUserId,
          priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus, agentId: row.agentId,
        })
      : resolveNativeReconciliationStatus({
          facts: { ...facts, hasPendingChildCompletion },
          priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus, agentId: row.agentId,
        });
    if (decision.statusAction === "done" && qualityReview?.satisfied === false) {
      decision = resolveNativeFinalizerStatus({ assessment: reassessment, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded",
        requiredQualityReviewSatisfied: false, priorIssueStatus: row.issueStatus as NativeAuthoritativeIssueStatus, agentId: row.agentId });
    }
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
        requireReassessmentSource: options.onlyWhenDue ? {
          phase: row.coordinatorPhase, resultId: resultRow.id, assessmentId: assessment.id,
          decisionId: row.decisionId, agentId: row.agentId, retiredAutomaticReview: retiredAutomaticReview ? { contractId: contractRow.id, governanceGate, hasUnresolvedIssueBlockers } : null,
        } : undefined,
        requireNoPendingChildCompletion: decision.statusAction === "done" ? childCompletionRecipient : undefined,
        supersedesCommittedDecisionId: row.coordinatorPhase === "committed"
          ? row.decisionId ?? undefined
          : undefined,
      });
    } catch (error) {
      if (error instanceof NativeStatusRaceError) return options.onlyWhenDue
        ? { kind: "deferred", retry: true } : { kind: "deferred" };
      throw error;
    }
    return { kind: "committed", result: {
      runId: row.runId,
      phase: "committed",
      reconciliationAction: decision.reasonCode,
      decisionId: committed.decision.id,
      reconciliationDecision: decision,
    } };
  }
  return { kind: "unchanged" };
}
