import { describe, expect, it } from "vitest";
import {
  ISSUE_DISPOSITION_EVIDENCE_REF_KINDS,
  ISSUE_DISPOSITION_SOURCE_CLASSES,
  ISSUE_DISPOSITION_USEFUL_OUTPUT_CLASSES,
  ISSUE_DISPOSITION_VERDICTS,
  evaluateDispositionTransition,
  isIssueDispositionSourceClass,
  isIssueFinalDisposition,
  parseIssueDispositionIdempotencyKey,
  buildIssueDispositionIdempotencyKey,
  validateAgentInReviewDisposition,
} from "./issue-disposition.js";

describe("validateAgentInReviewDisposition", () => {
  const baseInput = {
    actorType: "agent" as const,
    existingStatus: "in_progress" as const,
    nextStatus: "in_review" as const,
    nextAssigneeUserId: null,
    hasTypedExecutionParticipant: false,
    hasScheduledMonitor: false,
    hasPendingInteraction: false,
    hasPendingApproval: false,
  };

  it("rejects transitions to in_review without a review path", () => {
    const result = validateAgentInReviewDisposition(baseInput);
    expect(result.ok).toBe(false);
  });

  it("allows transitions when an eligible review path exists", () => {
    expect(validateAgentInReviewDisposition({ ...baseInput, nextAssigneeUserId: "11111111-1111-4111-8111-111111111111" }).ok).toBe(true);
    expect(validateAgentInReviewDisposition({ ...baseInput, hasTypedExecutionParticipant: true }).ok).toBe(true);
    expect(validateAgentInReviewDisposition({ ...baseInput, hasScheduledMonitor: true }).ok).toBe(true);
    expect(validateAgentInReviewDisposition({ ...baseInput, hasPendingInteraction: true }).ok).toBe(true);
    expect(validateAgentInReviewDisposition({ ...baseInput, hasPendingApproval: true }).ok).toBe(true);
  });

  it("skips validation for board-authored transitions", () => {
    const result = validateAgentInReviewDisposition({ ...baseInput, actorType: "user" });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateDispositionTransition", () => {
  const baseTransition = {
    actorType: "agent" as const,
    existingStatus: "in_progress" as const,
    hasReviewPath: true,
    hasQaPath: true,
    hasApprovalPath: true,
    hasParentBlocker: true,
    hasApprovedReviewDecisions: true,
    hasApprovedApprovalDecisions: true,
    hasFirstClassBlocker: true,
    hasPriorChangesRequestedDecision: true,
    hasCanonicalIssueRef: true,
    hasSuccessorRef: true,
    hasCauseClassification: true,
  };

  it("LET-246 row done: commits to status done when all preconditions are met", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "done" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("done");
    expect(result.intention.parentBlockerIntention).toBe("remove_from_parent_blockers");
    expect(result.intention.targetExecutionStageType).toBeNull();
  });

  it("LET-246 row done: rejects without approved review decisions", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "done", hasApprovedReviewDecisions: false }),
    ).toMatchObject({ ok: false, missing: "approved_review_decisions" });
  });

  it("LET-246 row done: rejects without approved approval decisions", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "done", hasApprovedApprovalDecisions: false }),
    ).toMatchObject({ ok: false, missing: "approved_approval_decisions" });
  });

  it("LET-246 row blocked: commits to status blocked when first-class blocker exists", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "blocked" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("blocked");
    expect(result.intention.parentBlockerIntention).toBe("none");
  });

  it("LET-246 row blocked: rejects without a first-class blocker", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "blocked", hasFirstClassBlocker: false }),
    ).toMatchObject({ ok: false, missing: "first_class_blocker" });
  });

  it("LET-246 row needs_fix: routes back to in_progress and creates fix subtask intention", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_fix" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("in_progress");
    expect(result.intention.parentBlockerIntention).toBe("create_or_reuse_fix_subtask");
  });

  it("LET-246 row needs_fix: rejects without a prior changes_requested decision", () => {
    expect(
      evaluateDispositionTransition({
        ...baseTransition,
        nextDisposition: "needs_fix",
        hasPriorChangesRequestedDecision: false,
      }),
    ).toMatchObject({ ok: false, missing: "prior_changes_requested_decision" });
  });

  it("LET-246 row needs_review: targets in_review and review stage when review path exists", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_review" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("in_review");
    expect(result.intention.targetExecutionStageType).toBe("review");
    expect(result.intention.parentBlockerIntention).toBe("request_review");
  });

  it("LET-246 row needs_review: rejects without a review path", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_review", hasReviewPath: false }),
    ).toMatchObject({ ok: false, missing: "review_path" });
  });

  it("LET-246 row needs_qa: targets in_review/review stage when qa path exists", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_qa" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("in_review");
    expect(result.intention.parentBlockerIntention).toBe("request_qa_review");
  });

  it("LET-246 row needs_qa: rejects without a QA path", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_qa", hasQaPath: false }),
    ).toMatchObject({ ok: false, missing: "qa_path" });
  });

  it("LET-246 row needs_approval: targets in_review/approval stage when approval path exists", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_approval" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("in_review");
    expect(result.intention.targetExecutionStageType).toBe("approval");
    expect(result.intention.parentBlockerIntention).toBe("request_approval");
  });

  it("LET-246 row needs_approval: rejects without an approval path", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "needs_approval", hasApprovalPath: false }),
    ).toMatchObject({ ok: false, missing: "approval_path" });
  });

  it("LET-246 row duplicate: cancels and rewrites parent blocker to canonical issue", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "duplicate" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("cancelled");
    expect(result.intention.parentBlockerIntention).toBe("replace_with_canonical_issue");
  });

  it("LET-246 row duplicate: rejects without a canonical issue reference", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "duplicate", hasCanonicalIssueRef: false }),
    ).toMatchObject({ ok: false, missing: "canonical_issue_ref" });
  });

  it("LET-246 row superseded: cancels and rewrites parent blocker to successor", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "superseded" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("cancelled");
    expect(result.intention.parentBlockerIntention).toBe("replace_with_successor");
  });

  it("LET-246 row superseded: rejects without a successor reference", () => {
    expect(
      evaluateDispositionTransition({ ...baseTransition, nextDisposition: "superseded", hasSuccessorRef: false }),
    ).toMatchObject({ ok: false, missing: "successor_ref" });
  });

  it("LET-246 row not_actionable: cancels and removes this issue from parent blockers", () => {
    const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: "not_actionable" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unexpected");
    expect(result.intention.targetStatus).toBe("cancelled");
    expect(result.intention.parentBlockerIntention).toBe("remove_from_parent_blockers");
  });

  it("LET-246 row not_actionable: rejects without a cause classification", () => {
    expect(
      evaluateDispositionTransition({
        ...baseTransition,
        nextDisposition: "not_actionable",
        hasCauseClassification: false,
      }),
    ).toMatchObject({ ok: false, missing: "cause_classification" });
  });

  it("supports all LET-246 final dispositions when preconditions are met", () => {
    const allDispositions = [
      "done",
      "blocked",
      "needs_fix",
      "needs_review",
      "needs_qa",
      "needs_approval",
      "duplicate",
      "superseded",
      "not_actionable",
    ] as const;

    for (const disposition of allDispositions) {
      const result = evaluateDispositionTransition({ ...baseTransition, nextDisposition: disposition });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects unsupported from-status transitions", () => {
    const result = evaluateDispositionTransition({
      ...baseTransition,
      existingStatus: "done",
      nextDisposition: "needs_review",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_disposition_transition" });
  });

  it("builds and parses LET-246 idempotency keys", () => {
    const key = buildIssueDispositionIdempotencyKey({
      issueId: "11111111-1111-4111-8111-111111111111",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      dispositionValue: "done",
    });
    expect(key).toBe("disposition:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:done");
    expect(parseIssueDispositionIdempotencyKey(key)).toMatchObject({
      issueId: "11111111-1111-4111-8111-111111111111",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      dispositionValue: "done",
    });
    expect(parseIssueDispositionIdempotencyKey("wrong:key")).toBeNull();
  });

  it("exports LET-246/247 helper enums", () => {
    expect(ISSUE_DISPOSITION_EVIDENCE_REF_KINDS).toEqual([
      "comment",
      "document",
      "issue",
      "run",
      "approval",
      "event",
      "external",
    ]);
    expect(ISSUE_DISPOSITION_SOURCE_CLASSES).toEqual(["agent", "user", "system", "reviewer", "qa_reviewer", "approval_owner"]);
    expect(ISSUE_DISPOSITION_USEFUL_OUTPUT_CLASSES).toEqual([
      "useful_output",
      "failed_with_useful_output",
      "successful_run_missing_state",
      "no_useful_output",
      "unknown",
    ]);
    expect(ISSUE_DISPOSITION_VERDICTS).toEqual(["pass", "fail", "request_changes", "pending", "not_applicable"]);
  });

  it("checks typed helpers", () => {
    expect(isIssueFinalDisposition("not_actionable")).toBe(true);
    expect(isIssueFinalDisposition("stuck")).toBe(false);
    expect(isIssueDispositionSourceClass("reviewer")).toBe(true);
    expect(isIssueDispositionSourceClass("robot")).toBe(false);
  });
});
