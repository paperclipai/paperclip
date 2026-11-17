import { describe, expect, it } from "vitest";
import { continuationApprovalAccepted, currentContinuationApproval, type ContinuationApproval } from "./continuation-approval.js";
import type { ContinuationCheckpoint } from "./continuation-scoring.js";

function recording() {
  const card: ContinuationApproval = { id: "revised-card", issueId: "parent", kind: "request_confirmation", status: "pending",
    resolverPolicy: "human_only", effectiveResolverPolicy: "human_only", continuationPolicy: "wake_assignee_on_accept",
    payload: { acceptLabel: "Confirm", target: { type: "issue_document", issueId: "parent", key: "plan", revisionId: "revised" } } };
  const checkpoint: ContinuationCheckpoint = { phase: "revised", issue: { id: "parent", status: "in_review" },
    children: [], attachments: [], comments: [], runs: [],
    documents: [{ key: "plan", body: "Use the revised word after approval.", latestRevisionId: "revised" }],
    interactions: [{ ...card, id: "old-card", status: "expired", payload: { target: { ...card.payload.target, revisionId: "old" } } }, card] };
  return { card, checkpoint };
}

describe("continuation plan human approval", () => {
  it("selects the current revision while preserving the expired prior request", () => {
    const { card, checkpoint } = recording();
    expect(currentContinuationApproval(checkpoint)).toBe(card);
    expect((checkpoint.interactions[0] as ContinuationApproval).status).toBe("expired");
  });

  it("rejects approval of a stale revision before a browser action", () => {
    const { card, checkpoint } = recording();
    card.payload.target!.revisionId = "old";
    expect(() => currentContinuationApproval(checkpoint)).toThrow(/current plan revision/);
  });

  it("requires the exact recorded human acceptance, not dismissal or an agent claim", () => {
    const { card } = recording();
    const dismissed = { ...card, dismissedAt: "2026-11-04T21:41:02Z", dismissedByUserId: "user" };
    expect(continuationApprovalAccepted(card, dismissed)).toBe(false);
    const accepted = { ...card, status: "accepted", result: { outcome: "accepted" },
      resolvedByUserId: "user", resolvedAt: "2026-11-04T21:41:03Z" };
    expect(continuationApprovalAccepted(card, accepted)).toBe(true);
    expect(continuationApprovalAccepted(card, { ...accepted, resolvedByUserId: null, resolvedByAgentId: "agent" })).toBe(false);
    expect(continuationApprovalAccepted(card, { ...accepted, payload: { target: { ...card.payload.target!, revisionId: "old" } } })).toBe(false);
  });
});
