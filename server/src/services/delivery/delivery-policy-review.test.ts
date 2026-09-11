import { describe, expect, it } from "vitest";
import type { DeliveryReviewPolicy } from "@paperclipai/shared";
import { evaluateDeliveryRequirements, effectiveReviewPolicy, type DeliveryEvidence } from "./policy.js";

const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const evidence: DeliveryEvidence = {
  headSha,
  checks: [{ name: "Platform gate", status: "success", url: null }],
  reviewStatus: "commented",
  reviewHeadSha: headSha,
  approvals: [],
  prAuthorLogin: "publisher",
  blockingFindings: 0,
  staleResolutionFindings: 0,
  independentChangesRequested: false,
  nativeReview: null,
};

function decision(patch: Partial<DeliveryEvidence>) {
  return evaluateDeliveryRequirements({
    requireIndependentApproval: true,
    requireGreptile: true,
    requiredChecks: ["Platform gate"],
    evidence: { ...evidence, ...patch },
  });
}

/** The agent-review regime: a verified native review of the exact revision. */
function agentReviewDecision(
  patch: Partial<DeliveryEvidence> = {},
  reviewPolicy: DeliveryReviewPolicy = "native_agent_review",
) {
  return evaluateDeliveryRequirements({
    requireIndependentApproval: false,
    reviewPolicy,
    requireGreptile: false,
    requiredChecks: ["Platform gate"],
    evidence: { ...evidence, ...patch },
  });
}

describe("delivery approval and repair routing", () => {
  it("routes missing independent approval separately from code repair", () => {
    expect(decision({})?.reasonCode).toBe("review_approval_required");
    expect(decision({ approvals: [{ login: "publisher", commitSha: headSha }] })?.reasonCode)
      .toBe("review_approval_required");
    expect(decision({ approvals: [{ login: "reviewer", commitSha: headSha }] })).toBeNull();
  });

  it("surfaces actionable findings before asking for approval", () => {
    const blocked = decision({ blockingFindings: 1 });
    expect(blocked?.reasonCode).toBe("review_blocking_findings");
    expect(blocked?.reasonCode).not.toBe(decision({})?.reasonCode);
    expect(decision({ reviewStatus: "changes_requested" })?.reasonCode).toBe("review_blocking_findings");
  });

  it("keeps unreadable author identity distinct from repairable findings", () => {
    expect(decision({ prAuthorLogin: null })?.reasonCode).toBe("provider_unknown");
  });

  it("requires a native review of the exact revision under the agent-review regime", () => {
    const review = {
      interactionId: "11111111-1111-4111-8111-111111111111",
      reviewerAgentId: "22222222-2222-4222-8222-222222222222",
      reviewerModel: "claude-bridge/claude-fable-5",
      revision: headSha,
      workspaceKey: "acme/widget:delivery/x",
      reviewedAt: null,
    };
    // No GitHub account approval is needed, but a missing review of the head is
    // still a review gate — a worker-declared readiness boolean is not review.
    expect(agentReviewDecision()).toMatchObject({ reasonCode: "review_approval_required" });
    // A review of another revision never approves this one.
    expect(agentReviewDecision({ nativeReview: { ...review, revision: otherSha } }))
      .toMatchObject({ reasonCode: "review_approval_required" });
    expect(agentReviewDecision({ nativeReview: review })).toBeNull();
    // "Agent review plus CI" needs both halves: the regime refuses an
    // unconfigured repository regardless of review status or Greptile, which is
    // a review and not repository CI.
    const unconfigured = evaluateDeliveryRequirements({
      requireIndependentApproval: false,
      reviewPolicy: "native_agent_review",
      requireGreptile: true,
      requiredChecks: [],
      evidence: { ...evidence, nativeReview: review },
    });
    expect(unconfigured).toMatchObject({ reasonCode: "checks_required" });
    // The record's legacy meaning is preserved: without a regime, the boolean
    // still decides and an older authorization is never silently re-scoped.
    expect(effectiveReviewPolicy({ requireIndependentApproval: false })).toBe("none");
    expect(effectiveReviewPolicy({ requireIndependentApproval: true })).toBe("github_approval");
    expect(effectiveReviewPolicy({ reviewPolicy: "native_agent_review", requireIndependentApproval: true }))
      .toBe("native_agent_review");
    expect(agentReviewDecision({ reviewStatus: "commented" }, "none")).toBeNull();
  });

  it("routes a resolution that belongs to another revision to a review wait, not a code repair", () => {
    const stale = decision({ blockingFindings: 1, staleResolutionFindings: 1 });
    expect(stale).toMatchObject({ reasonCode: "review_head_stale" });
    expect(stale?.nextAction).toMatch(/current head/);
    // Mixed evidence stays actionable for the implementation owner: an
    // unresolved finding is still repaired.
    expect(decision({ blockingFindings: 2, staleResolutionFindings: 1 })?.reasonCode)
      .toBe("review_blocking_findings");
    // An explicit rejection stands on its own, however the findings are
    // resolved: the GitHub review verdict and the provider's own verdict are
    // both independent evidence.
    expect(decision({ blockingFindings: 1, staleResolutionFindings: 1, independentChangesRequested: true })?.reasonCode)
      .toBe("review_blocking_findings");
    expect(decision({ blockingFindings: 1, staleResolutionFindings: 1, reviewStatus: "changes_requested" })?.reasonCode)
      .toBe("review_head_stale");
  });
});
