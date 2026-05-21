// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import { buildOperatorDigest } from "./operator-digest";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Run Alpha158 baseline",
    description: "Reproduce the baseline and prepare review artifacts.",
    status: "todo",
    workMode: "standard",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 12,
    identifier: "CMP-12",
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
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T01:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  } as Issue;
}

describe("buildOperatorDigest", () => {
  it("prioritizes pending human interactions", () => {
    const digest = buildOperatorDigest({
      issue: issue({ status: "in_review" }),
      interactions: [{
        id: "interaction-1",
        companyId: "company-1",
        issueId: "issue-1",
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve the plan?",
        },
        createdAt: new Date("2026-05-20T02:00:00.000Z"),
        updatedAt: new Date("2026-05-20T02:00:00.000Z"),
      } satisfies IssueThreadInteraction],
    });

    expect(digest.state).toBe("needs_you");
    expect(digest.humanAction).toContain("Approve the plan?");
    expect(digest.nextStep).toContain("pending interaction");
  });

  it("summarizes blocked issues with the first blocker", () => {
    const digest = buildOperatorDigest({
      issue: issue({
        status: "blocked",
        blockedBy: [{
          id: "blocker-1",
          identifier: "CMP-9",
          title: "Restore data access",
          status: "todo",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: null,
        }],
      }),
    });

    expect(digest.state).toBe("blocked");
    expect(digest.oneLiner).toBe("Blocked by CMP-9.");
    expect(digest.humanAction).toContain("CMP-9");
  });

  it("surfaces review artifacts as evidence", () => {
    const digest = buildOperatorDigest({
      issue: issue({
        status: "in_review",
        workProducts: [{
          id: "wp-1",
          companyId: "company-1",
          projectId: null,
          issueId: "issue-1",
          executionWorkspaceId: null,
          runtimeServiceId: null,
          type: "document",
          provider: "local",
          externalId: null,
          title: "Experiment spec",
          url: "/work-products/spec",
          status: "ready_for_review",
          reviewState: "needs_board_review",
          isPrimary: true,
          healthStatus: "healthy",
          summary: "Defines the next experiment pass.",
          metadata: null,
          createdByRunId: null,
          createdAt: new Date("2026-05-20T02:00:00.000Z"),
          updatedAt: new Date("2026-05-20T03:00:00.000Z"),
        }],
      }),
    });

    expect(digest.state).toBe("ready_review");
    expect(digest.oneLiner).toBe("Defines the next experiment pass.");
    expect(digest.evidence).toEqual([{ label: "Experiment spec", href: "/work-products/spec" }]);
  });

  it("uses running when live runs exist", () => {
    const digest = buildOperatorDigest({
      issue: issue({ status: "todo" }),
      hasLiveRuns: true,
    });

    expect(digest.state).toBe("running");
    expect(digest.oneLiner).toBe("A run is active for this issue.");
  });
});
