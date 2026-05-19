import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  bucketMissions,
  resolveMissionRow,
  summarizeMissionList,
  type MissionRow,
} from "./mission-resolver";

const NOW = new Date("2026-05-18T22:00:00.000Z");

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Default issue",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: "LET-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-18T20:00:00.000Z"),
    updatedAt: new Date("2026-05-18T21:30:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("resolveMissionRow", () => {
  it("classifies an in_progress issue as active and backend-backed", () => {
    const row = resolveMissionRow(makeIssue({ status: "in_progress" }), NOW);
    expect(row.primaryState).toBe("active");
    expect(row.truthLabel).toBe("Backend-backed");
    expect(row.freshness).toBe("Fresh");
    expect(row.kernelRoute).toBe("/issues/issue-1");
  });

  it("classifies a blocked issue with a blocker count reason", () => {
    const row = resolveMissionRow(
      makeIssue({
        status: "blocked",
        blockedBy: [
          { id: "x", title: "x" } as unknown as NonNullable<Issue["blockedBy"]>[number],
        ],
      }),
      NOW,
    );
    expect(row.primaryState).toBe("blocked");
    expect(row.primaryStateReason).toContain("1 dependency issue");
    expect(row.treeSummary.blockedByCount).toBe(1);
  });

  it("classifies in_review and marks the next gate as human-owned", () => {
    const row = resolveMissionRow(makeIssue({ status: "in_review" }), NOW);
    expect(row.primaryState).toBe("in-review");
    expect(row.nextGateSummary.requiresHuman).toBe(true);
  });

  it("splits done with vs without evidence", () => {
    const withEvidence = resolveMissionRow(
      makeIssue({
        status: "done",
        workProducts: [{ id: "wp1" } as unknown as NonNullable<Issue["workProducts"]>[number]],
      }),
      NOW,
    );
    expect(withEvidence.primaryState).toBe("done-with-evidence");
    expect(withEvidence.evidenceSummary.hasWorkProducts).toBe(true);

    const withoutEvidence = resolveMissionRow(makeIssue({ status: "done" }), NOW);
    expect(withoutEvidence.primaryState).toBe("done-evidence-incomplete");
  });

  it("flags backlog/todo without an assignee as needs-next-owner", () => {
    const row = resolveMissionRow(
      makeIssue({ status: "todo", assigneeAgentId: null, assigneeUserId: null }),
      NOW,
    );
    expect(row.primaryState).toBe("needs-next-owner");
    expect(row.ownerSummary.currentTruth).toBe("Backend-derived");
  });

  it("marks risk as elevated when the title mentions a live-action category", () => {
    const row = resolveMissionRow(
      makeIssue({ title: "[OPS] deploy hotfix to production" }),
      NOW,
    );
    expect(row.riskSummary.liveActionMentioned).toBe(true);
    expect(row.riskSummary.severity).toBe("elevated");
    expect(row.riskSummary.truth).toBe("Backend-derived");
  });

  it("returns Unknown freshness when updatedAt is missing or invalid", () => {
    const row = resolveMissionRow(
      makeIssue({ updatedAt: null as unknown as Issue["updatedAt"] }),
      NOW,
    );
    expect(row.freshness).toBe("Unknown");
  });

  it("returns Stale freshness past the 7-day threshold", () => {
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const row = resolveMissionRow(makeIssue({ updatedAt: old }), NOW);
    expect(row.freshness).toBe("Stale");
  });
});

describe("bucketMissions / summarizeMissionList", () => {
  function rowFor(overrides: Partial<Issue>): MissionRow {
    return resolveMissionRow(makeIssue(overrides), NOW);
  }

  it("partitions rows by primary state and counts backend-backed totals", () => {
    const rows: MissionRow[] = [
      rowFor({ id: "a", status: "in_progress" }),
      rowFor({ id: "b", status: "blocked" }),
      rowFor({
        id: "c",
        status: "in_review",
      }),
      rowFor({
        id: "d",
        status: "done",
        workProducts: [{ id: "wp" } as unknown as NonNullable<Issue["workProducts"]>[number]],
      }),
      rowFor({ id: "e", status: "cancelled" }),
    ];
    const buckets = bucketMissions(rows);
    expect(buckets.active.map((r) => r.id)).toEqual(["a"]);
    expect(buckets.blocked.map((r) => r.id)).toEqual(["b"]);
    expect(buckets.inReview.map((r) => r.id)).toEqual(["c"]);
    expect(buckets.doneWithEvidence.map((r) => r.id)).toEqual(["d"]);
    expect(buckets.other.map((r) => r.id)).toEqual(["e"]);

    const summary = summarizeMissionList(rows);
    expect(summary.totalBackendBacked).toBe(5);
    expect(summary.active).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.inReview).toBe(1);
    expect(summary.doneWithEvidence).toBe(1);
  });

  it("never inflates counts from preview data — empty input means zero counts", () => {
    expect(summarizeMissionList([])).toEqual({
      totalBackendBacked: 0,
      active: 0,
      blocked: 0,
      inReview: 0,
      doneWithEvidence: 0,
      stale: 0,
    });
  });
});
