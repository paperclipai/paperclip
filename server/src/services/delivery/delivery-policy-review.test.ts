import { describe, expect, it } from "vitest";
import { evaluateDeliveryRequirements, type DeliveryEvidence } from "./policy.js";

const headSha = "a".repeat(40);
const evidence: DeliveryEvidence = {
  headSha,
  checks: [{ name: "Platform gate", status: "success", url: null }],
  reviewStatus: "commented",
  reviewHeadSha: headSha,
  approvals: [],
  prAuthorLogin: "publisher",
  blockingFindings: 0,
};

function decision(patch: Partial<DeliveryEvidence>) {
  return evaluateDeliveryRequirements({
    requireIndependentApproval: true,
    requireGreptile: true,
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
});
