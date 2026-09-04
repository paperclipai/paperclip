import { and, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  agents,
  heartbeatRunEvents,
  issueApprovals,
  issueAttachments,
  issueThreadInteractions,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  normalizePrpResultSignals,
  type PrpIgnoredAttentionRequest,
  type PrpNormalizedAttentionRequest,
  type PrpVerificationReasonCode,
} from "../../vendor/paperclip-runner/index.js";

export type NativeEvidenceOutcome = "accepted" | "missing" | "rejected" | "unverifiable";

export interface NativeEvidenceRefAssessment {
  ref: string;
  kind: "event" | "work_product" | "approval" | "interaction" | "attachment" | "unknown";
  outcome: NativeEvidenceOutcome;
  reasonCode: string;
  durableRecordId: string | null;
}

export interface NativeEvidenceAssessment {
  objectiveClaimSatisfied: boolean;
  objectiveSatisfied: boolean;
  allCriteriaSatisfied: boolean;
  verificationPassed: boolean;
  hasFailedVerification: boolean;
  hasBlockingRemainingWork: boolean;
  reportedDisposition: "done" | "blocked" | "needs_review" | "yielded";
  summary: string;
  contractRevisionMatches: boolean;
  criterionAssessments: Array<{
    criterionId: string;
    claimStatus: "satisfied" | "not_satisfied" | "unknown" | null;
    outcome: NativeEvidenceOutcome;
    evidenceRefs: NativeEvidenceRefAssessment[];
    reasonCode: string;
  }>;
  verificationAssessments: Array<{
    commandOrCheck: string;
    claimStatus: "passed" | "failed" | "not_run";
    outcome: NativeEvidenceOutcome;
    evidenceRef: NativeEvidenceRefAssessment | null;
    reasonCode: string;
    reportedReasonCode: PrpVerificationReasonCode | null;
    detail: string | null;
  }>;
  verificationCaveats: Array<{
    commandOrCheck: string;
    reasonCode: PrpVerificationReasonCode | null;
    detail: string | null;
  }>;
  acceptedEvidenceRefs: string[];
  missingRequirements: string[];
  rejectedEvidence: Array<{ ref: string; reasonCode: string }>;
  unverifiableEvidence: Array<{ ref: string; reasonCode: string }>;
  blocker: {
    unblockAction: string;
    boardOwned: boolean;
    scope: "current_track" | "task_wide";
  } | null;
  continuation: {
    kind: "same_agent" | "retry" | "delegated_issue" | "response_wake" | "monitor";
    summary: string;
    idempotencyKey: string;
  } | null;
  /** Actionable, blocking requests only. */
  attentionRequests: PrpNormalizedAttentionRequest[];
  ignoredAttentionRequests: PrpIgnoredAttentionRequest[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function uuidRef(ref: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (!ref.startsWith(`${prefix}:`)) continue;
    const value = ref.slice(prefix.length + 1).trim();
    // Model-authored evidence often annotates a durable reference, for example
    // `interaction:<uuid> (request_confirmation, status accepted)`. Extract the
    // canonical UUID only; never pass the descriptive suffix (or arbitrary
    // malformed text) to a Postgres UUID comparison.
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f-])/i.exec(value);
    return match?.[1] ?? null;
  }
  return null;
}

async function classifyEvidenceRef(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  ref: string;
}): Promise<NativeEvidenceRefAssessment> {
  const eventMatch = /^event:(\d+)$/.exec(input.ref);
  if (eventMatch) {
    const cursor = Number(eventMatch[1]);
    const event = await input.db.select({
      id: heartbeatRunEvents.id,
      eventType: heartbeatRunEvents.eventType,
      payload: heartbeatRunEvents.payload,
    })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.runId, input.runId),
        or(eq(heartbeatRunEvents.seq, cursor), eq(heartbeatRunEvents.sourceSeq, cursor)),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!event) {
      return { ref: input.ref, kind: "event", outcome: "missing", reasonCode: "durable_run_event_missing", durableRecordId: null };
    }
    const prpEvent = record(record(event.payload).prpEvent);
    const evidenceOutcome = text(record(prpEvent.payload).evidenceOutcome);
    if (prpEvent.sourceKind === "control_plane" && evidenceOutcome === "accepted") {
      return { ref: input.ref, kind: "event", outcome: "accepted", reasonCode: "control_plane_evidence_accepted", durableRecordId: String(event.id) };
    }
    if (prpEvent.sourceKind === "control_plane" && evidenceOutcome === "rejected") {
      return { ref: input.ref, kind: "event", outcome: "rejected", reasonCode: "control_plane_evidence_rejected", durableRecordId: String(event.id) };
    }
    return {
      ref: input.ref,
      kind: "event",
      outcome: "unverifiable",
      reasonCode: event.eventType === "run.result.proposed"
        ? "model_result_event_is_claim_only"
        : "run_event_has_no_authoritative_evidence_verdict",
      durableRecordId: String(event.id),
    };
  }

  const workProductId = uuidRef(input.ref, ["work_product", "work-product", "artifact"]);
  if (workProductId) {
    const row = await input.db.select({
      id: issueWorkProducts.id,
      status: issueWorkProducts.status,
      reviewState: issueWorkProducts.reviewState,
    }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, workProductId),
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, input.issueId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!row) return { ref: input.ref, kind: "work_product", outcome: "missing", reasonCode: "work_product_missing", durableRecordId: null };
    if (
      ["failed", "error", "cancelled", "rejected", "changes_requested"].includes(row.status)
      || ["rejected", "changes_requested"].includes(row.reviewState)
    ) {
      return { ref: input.ref, kind: "work_product", outcome: "rejected", reasonCode: "work_product_rejected", durableRecordId: row.id };
    }
    if (
      row.reviewState === "approved"
      || ["approved", "passed", "succeeded", "completed", "merged", "published"].includes(row.status)
    ) {
      return { ref: input.ref, kind: "work_product", outcome: "accepted", reasonCode: "work_product_authoritatively_accepted", durableRecordId: row.id };
    }
    return { ref: input.ref, kind: "work_product", outcome: "unverifiable", reasonCode: "work_product_not_yet_accepted", durableRecordId: row.id };
  }

  const approvalId = uuidRef(input.ref, ["approval"]);
  if (approvalId) {
    const row = await input.db.select({ id: approvals.id, status: approvals.status })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        eq(approvals.companyId, input.companyId),
        eq(approvals.id, approvalId),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!row) return { ref: input.ref, kind: "approval", outcome: "missing", reasonCode: "approval_missing", durableRecordId: null };
    if (row.status === "approved") return { ref: input.ref, kind: "approval", outcome: "accepted", reasonCode: "approval_approved", durableRecordId: row.id };
    if (["rejected", "cancelled"].includes(row.status)) return { ref: input.ref, kind: "approval", outcome: "rejected", reasonCode: "approval_rejected", durableRecordId: row.id };
    return { ref: input.ref, kind: "approval", outcome: "missing", reasonCode: "approval_pending", durableRecordId: row.id };
  }

  const interactionId = uuidRef(input.ref, ["interaction"]);
  if (interactionId) {
    const row = await input.db.select({
      id: issueThreadInteractions.id,
      status: issueThreadInteractions.status,
      result: issueThreadInteractions.result,
    }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!row) return { ref: input.ref, kind: "interaction", outcome: "missing", reasonCode: "interaction_missing", durableRecordId: null };
    const outcome = text(record(row.result).outcome);
    if (["accepted", "answered", "resolved"].includes(outcome ?? "") || ["accepted", "answered"].includes(row.status)) {
      return { ref: input.ref, kind: "interaction", outcome: "accepted", reasonCode: "interaction_resolved", durableRecordId: row.id };
    }
    if (["rejected", "expired", "cancelled"].includes(row.status) || ["rejected", "withdrawn", "issue_closed"].includes(outcome ?? "")) {
      return { ref: input.ref, kind: "interaction", outcome: "rejected", reasonCode: "interaction_rejected", durableRecordId: row.id };
    }
    return { ref: input.ref, kind: "interaction", outcome: "missing", reasonCode: "interaction_pending", durableRecordId: row.id };
  }

  const attachmentId = uuidRef(input.ref, ["attachment"]);
  if (attachmentId) {
    const row = await input.db.select({ id: issueAttachments.id }).from(issueAttachments).where(and(
      eq(issueAttachments.id, attachmentId),
      eq(issueAttachments.companyId, input.companyId),
      eq(issueAttachments.issueId, input.issueId),
    )).limit(1).then((rows) => rows[0] ?? null);
    return row
      ? { ref: input.ref, kind: "attachment", outcome: "accepted", reasonCode: "attachment_persisted", durableRecordId: row.id }
      : { ref: input.ref, kind: "attachment", outcome: "missing", reasonCode: "attachment_missing", durableRecordId: null };
  }

  return {
    ref: input.ref,
    kind: "unknown",
    outcome: "unverifiable",
    reasonCode: "unsupported_evidence_reference",
    durableRecordId: null,
  };
}

/**
 * Classifies model claims against immutable server-owned records. A model's
 * `satisfied` or `passed` value is retained as a claim but never becomes proof.
 */
export async function classifyNativeEvidence(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  contract: Record<string, unknown>;
  result: Record<string, unknown>;
}): Promise<NativeEvidenceAssessment> {
  const claim = record(input.result.completionClaim);
  const claimedCriteria = Array.isArray(claim.criteria) ? claim.criteria.map(record) : [];
  const contractCriteria = Array.isArray(input.contract.criteria) ? input.contract.criteria.map(record) : [];
  const remaining = Array.isArray(claim.remainingWork) ? claim.remainingWork.map(record) : [];
  const normalizedSignals = normalizePrpResultSignals(input.result);
  const verification = normalizedSignals.verification;
  const reported = input.result.reportedWorkDisposition;
  const blocker = record(input.result.blocker);
  const blockerOwner = record(blocker.owner);
  const continuation = record(input.result.continuation);
  if (!["done", "blocked", "needs_review", "yielded"].includes(String(reported))) {
    throw new Error("native_result_invalid_disposition");
  }

  const contractRevision = text(input.contract.revision);
  const contractRevisionMatches = contractRevision !== null && text(claim.contractRevision) === contractRevision;
  const cache = new Map<string, Promise<NativeEvidenceRefAssessment>>();
  const resolveRef = (ref: string) => {
    let pending = cache.get(ref);
    if (!pending) {
      pending = classifyEvidenceRef({ ...input, ref });
      cache.set(ref, pending);
    }
    return pending;
  };

  const criterionAssessments = await Promise.all(contractCriteria.map(async (criterion) => {
    const criterionId = text(criterion.id) ?? "invalid-contract-criterion";
    const claimed = claimedCriteria.find((entry) => text(entry.criterionId) === criterionId) ?? null;
    const claimStatus = claimed && ["satisfied", "not_satisfied", "unknown"].includes(String(claimed.status))
      ? claimed.status as "satisfied" | "not_satisfied" | "unknown"
      : null;
    const refs = claimed && Array.isArray(claimed.evidenceRefs)
      ? claimed.evidenceRefs.flatMap((value) => text(value) ? [text(value)!] : [])
      : [];
    const evidenceRefs = await Promise.all(refs.map(resolveRef));
    let outcome: NativeEvidenceOutcome;
    let reasonCode: string;
    if (!contractRevisionMatches) {
      outcome = "rejected";
      reasonCode = "contract_revision_stale";
    } else if (!claimed) {
      outcome = "missing";
      reasonCode = "criterion_claim_missing";
    } else if (claimStatus === "not_satisfied") {
      outcome = "rejected";
      reasonCode = "criterion_reported_not_satisfied";
    } else if (claimStatus !== "satisfied") {
      outcome = "unverifiable";
      reasonCode = "criterion_claim_not_satisfied";
    } else if (refs.length === 0) {
      outcome = "missing";
      reasonCode = "criterion_evidence_missing";
    } else if (evidenceRefs.some((entry) => entry.outcome === "rejected")) {
      outcome = "rejected";
      reasonCode = "criterion_evidence_rejected";
    } else if (evidenceRefs.some((entry) => entry.outcome === "unverifiable")) {
      outcome = "unverifiable";
      reasonCode = "criterion_evidence_unverifiable";
    } else if (evidenceRefs.some((entry) => entry.outcome === "missing")) {
      outcome = "missing";
      reasonCode = "criterion_evidence_missing";
    } else {
      outcome = "accepted";
      reasonCode = "criterion_evidence_accepted";
    }
    return { criterionId, claimStatus, outcome, evidenceRefs, reasonCode };
  }));

  const verificationAssessments = await Promise.all(verification.map(async (entry) => {
    const commandOrCheck = entry.commandOrCheck;
    const claimStatus = entry.status;
    const ref = entry.artifactRef;
    const evidenceRef = ref ? await resolveRef(ref) : null;
    const common = { commandOrCheck, claimStatus, evidenceRef, reportedReasonCode: entry.reasonCode, detail: entry.detail };
    if (claimStatus === "failed") return { ...common, outcome: "rejected" as const, reasonCode: "verification_reported_failed" };
    if (claimStatus === "not_run") return { ...common, outcome: "missing" as const, reasonCode: "verification_not_run" };
    if (!evidenceRef) return { ...common, outcome: "unverifiable" as const, reasonCode: "verification_has_no_durable_reference" };
    return {
      ...common,
      outcome: evidenceRef.outcome,
      reasonCode: evidenceRef.outcome === "accepted" ? "verification_evidence_accepted" : evidenceRef.reasonCode,
    };
  }));

  const allRefs = [...cache.keys()].map((ref) => cache.get(ref)!);
  const resolvedRefs = await Promise.all(allRefs);
  const acceptedEvidenceRefs = resolvedRefs.filter((entry) => entry.outcome === "accepted").map((entry) => entry.ref);
  const missingRequirements = [
    ...criterionAssessments.filter((entry) => entry.outcome === "missing").map((entry) => entry.criterionId),
    ...verificationAssessments.filter((entry) => entry.outcome === "missing").map((entry) => entry.commandOrCheck),
  ];
  const rejectedEvidence = resolvedRefs.filter((entry) => entry.outcome === "rejected").map((entry) => ({ ref: entry.ref, reasonCode: entry.reasonCode }));
  const unverifiableEvidence = resolvedRefs.filter((entry) => entry.outcome === "unverifiable").map((entry) => ({ ref: entry.ref, reasonCode: entry.reasonCode }));
  const allCriteriaSatisfied = contractCriteria.length > 0 && criterionAssessments.every((entry) => entry.outcome === "accepted");
  const verificationPassed = verificationAssessments.length > 0 && verificationAssessments.every((entry) => entry.outcome === "accepted");
  const hasFailedVerification = verificationAssessments.some((entry) => entry.claimStatus === "failed");
  const continuationKind = continuation.kind;
  const actionableAttentionRequests: PrpNormalizedAttentionRequest[] = [];
  const ignoredAttentionRequests = [...normalizedSignals.ignoredAttentionRequests];
  for (const request of normalizedSignals.actionableAttentionRequests) {
    if (request.ownerClass === "agent" && request.targetAgentId) {
      const targetExists = await input.db.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, request.targetAgentId),
        eq(agents.companyId, input.companyId),
      )).limit(1).then((rows) => rows.length > 0);
      if (!targetExists) {
        ignoredAttentionRequests.push({
          sourceIndex: request.sourceIndex,
          sourceKind: request.sourceKind,
          summary: request.summary,
          disposition: "rejected",
          reasonCode: "attention_request_target_agent_unavailable",
        });
        continue;
      }
    }
    actionableAttentionRequests.push(request);
  }

  return {
    objectiveClaimSatisfied: claim.objectiveSatisfied === true,
    objectiveSatisfied: claim.objectiveSatisfied === true && allCriteriaSatisfied,
    allCriteriaSatisfied,
    verificationPassed,
    hasFailedVerification,
    hasBlockingRemainingWork:
      remaining.some((entry) => entry.blocksCompletion === true)
      || (reported === "done" && Object.keys(blocker).length > 0),
    reportedDisposition: reported as NativeEvidenceAssessment["reportedDisposition"],
    summary: typeof input.result.summary === "string" ? input.result.summary : "Native run completed.",
    contractRevisionMatches,
    criterionAssessments,
    verificationAssessments,
    verificationCaveats: verificationAssessments
      .filter((entry) => entry.claimStatus === "not_run")
      .map((entry) => ({
        commandOrCheck: entry.commandOrCheck,
        reasonCode: entry.reportedReasonCode,
        detail: entry.detail,
      })),
    acceptedEvidenceRefs,
    missingRequirements,
    rejectedEvidence,
    unverifiableEvidence,
    blocker: reported === "blocked" && typeof blocker.unblockAction === "string"
      ? {
          unblockAction: blocker.unblockAction,
          boardOwned: blockerOwner.kind === "board" || blockerOwner.owner === "board",
          scope: blocker.scope === "task_wide" ? "task_wide" : "current_track",
        }
      : null,
    continuation: reported === "yielded"
      && ["same_agent", "retry", "delegated_issue", "response_wake", "monitor"].includes(String(continuationKind))
      && text(continuation.summary)
      && text(continuation.idempotencyKey)
      ? {
          kind: continuationKind as NativeEvidenceAssessment["continuation"] extends infer T ? T extends { kind: infer K } ? K : never : never,
          summary: text(continuation.summary)!,
          idempotencyKey: text(continuation.idempotencyKey)!,
        }
      : null,
    attentionRequests: actionableAttentionRequests,
    ignoredAttentionRequests,
  };
}
