import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";

import {
  buildApprovalQueueRow,
  groupApprovalsForQueue,
  summarizeApprovals,
  summarizePayload,
  APPROVAL_QUEUE_TEST_HELPERS,
} from "./approval-queue";

const { TYPE_RISK } = APPROVAL_QUEUE_TEST_HELPERS;

function makeApproval(overrides: Partial<Approval> & { id: string }): Approval {
  return {
    id: overrides.id,
    companyId: "company-1",
    type: overrides.type ?? "hire_agent",
    requestedByAgentId: overrides.requestedByAgentId ?? null,
    requestedByUserId: overrides.requestedByUserId ?? null,
    status: overrides.status ?? "pending",
    payload: overrides.payload ?? {},
    decisionNote: overrides.decisionNote ?? null,
    decidedByUserId: overrides.decidedByUserId ?? null,
    decidedAt: overrides.decidedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-19T10:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-19T10:00:00Z"),
  } as Approval;
}

describe("summarizePayload", () => {
  it("returns the payload reason when present", () => {
    const approval = makeApproval({
      id: "1",
      type: "request_board_approval",
      payload: { reason: "Approve LET-484 PR merge" },
    });
    expect(summarizePayload(approval)).toBe("Approve LET-484 PR merge");
  });

  it("falls back to candidate name for hire_agent", () => {
    const approval = makeApproval({
      id: "2",
      type: "hire_agent",
      payload: { candidateName: "EAOS Frontend Engineer" },
    });
    expect(summarizePayload(approval)).toBe("Hire EAOS Frontend Engineer");
  });

  it("falls back to a budget-override hint for budget_override_required", () => {
    const approval = makeApproval({
      id: "3",
      type: "budget_override_required",
      payload: { capUsd: "1000" },
    });
    expect(summarizePayload(approval)).toBe("Budget override · 1000");
  });

  it("falls back to a generic label for an empty payload", () => {
    const approval = makeApproval({ id: "4", type: "approve_ceo_strategy", payload: {} });
    expect(summarizePayload(approval)).toBe("CEO strategy approval");
  });
});

describe("summarizeApprovals", () => {
  it("buckets each status and flags high-risk open items", () => {
    const counts = summarizeApprovals([
      makeApproval({ id: "1", status: "pending", type: "request_board_approval" }), // critical risk · open
      makeApproval({ id: "2", status: "pending", type: "hire_agent" }), // medium risk
      makeApproval({ id: "3", status: "revision_requested", type: "budget_override_required" }), // high risk · open
      makeApproval({ id: "4", status: "approved", type: "hire_agent" }),
      makeApproval({ id: "5", status: "rejected", type: "approve_ceo_strategy" }),
      makeApproval({ id: "6", status: "cancelled", type: "request_board_approval" }), // not open → no highRisk bump
    ]);
    expect(counts).toEqual({
      total: 6,
      pending: 2,
      revisionRequested: 1,
      approved: 1,
      rejected: 1,
      cancelled: 1,
      highRisk: 2,
    });
  });

  it("returns zeros for an empty list", () => {
    expect(summarizeApprovals([])).toEqual({
      total: 0,
      pending: 0,
      revisionRequested: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      highRisk: 0,
    });
  });
});

describe("groupApprovalsForQueue", () => {
  it("splits approvals into pending / revision_requested / decided buckets", () => {
    const buckets = groupApprovalsForQueue([
      makeApproval({ id: "p1", status: "pending", createdAt: new Date("2026-05-18T10:00:00Z") }),
      makeApproval({ id: "p2", status: "pending", createdAt: new Date("2026-05-17T10:00:00Z") }),
      makeApproval({
        id: "r1",
        status: "revision_requested",
        createdAt: new Date("2026-05-19T08:00:00Z"),
      }),
      makeApproval({
        id: "d1",
        status: "approved",
        createdAt: new Date("2026-05-15T10:00:00Z"),
        decidedAt: new Date("2026-05-15T11:00:00Z"),
      }),
      makeApproval({
        id: "d2",
        status: "rejected",
        createdAt: new Date("2026-05-16T10:00:00Z"),
        decidedAt: new Date("2026-05-16T11:00:00Z"),
      }),
    ]);

    expect(buckets.map((b) => b.id)).toEqual(["pending", "revision_requested", "decided"]);
    const pending = buckets.find((b) => b.id === "pending")!;
    // Oldest-first for the pending bucket (longest waiting at top).
    expect(pending.rows.map((row) => row.id)).toEqual(["p2", "p1"]);
    const revisionRequested = buckets.find((b) => b.id === "revision_requested")!;
    expect(revisionRequested.rows.map((row) => row.id)).toEqual(["r1"]);
    const decided = buckets.find((b) => b.id === "decided")!;
    // Most-recent decision first.
    expect(decided.rows.map((row) => row.id)).toEqual(["d2", "d1"]);
  });

  it("caps the decided bucket at 10 rows to keep the queue scannable", () => {
    const decided: Approval[] = [];
    for (let i = 0; i < 15; i += 1) {
      decided.push(
        makeApproval({
          id: `d-${i}`,
          status: "approved",
          createdAt: new Date(Date.now() - i * 60_000),
          decidedAt: new Date(Date.now() - i * 60_000 + 1_000),
        }),
      );
    }
    const buckets = groupApprovalsForQueue(decided);
    const decidedBucket = buckets.find((b) => b.id === "decided")!;
    expect(decidedBucket.rows.length).toBe(10);
  });
});

describe("buildApprovalQueueRow", () => {
  it("derives the risk tier from the approval type", () => {
    const row = buildApprovalQueueRow(makeApproval({ id: "1", type: "request_board_approval" }));
    expect(row.riskLevel).toBe("critical");
    const row2 = buildApprovalQueueRow(makeApproval({ id: "2", type: "hire_agent" }));
    expect(row2.riskLevel).toBe("medium");
  });

  it("points the kernel route at the legacy approvals detail page", () => {
    const row = buildApprovalQueueRow(makeApproval({ id: "approval-42" }));
    expect(row.kernelRoute).toBe("/approvals/approval-42");
  });
});

describe("TYPE_RISK invariants", () => {
  it("assigns a tier to every supported approval type", () => {
    const types = ["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"] as const;
    for (const type of types) {
      expect(TYPE_RISK[type]).toMatch(/^(low|medium|high|critical)$/);
    }
  });
});
