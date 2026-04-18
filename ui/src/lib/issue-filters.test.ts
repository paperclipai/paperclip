// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { applyIssueFilters, countActiveIssueFilters, defaultIssueFilterState } from "./issue-filters";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
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
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("issue filters", () => {
  it("filters issues by creator across agents and users", () => {
    const issues = [
      makeIssue({ id: "agent-match", createdByAgentId: "agent-1" }),
      makeIssue({ id: "user-match", createdByUserId: "user-1" }),
      makeIssue({ id: "excluded", createdByAgentId: "agent-2", createdByUserId: "user-2" }),
    ];

    const filtered = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      creators: ["agent:agent-1", "user:user-1"],
    });

    expect(filtered.map((issue) => issue.id)).toEqual(["agent-match", "user-match"]);
  });

  it("counts creator filters as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      creators: ["user:user-1"],
    })).toBe(1);
  });

  it("filters blocked or waiting work across status and workflow state", () => {
    const issues = [
      makeIssue({ id: "blocked-status", status: "blocked" }),
      makeIssue({
        id: "waiting-human",
        missionControl: {
          workflowState: {
            kind: "waiting_on_human",
            enteredAt: new Date("2026-04-16T00:00:00.000Z"),
          },
        },
      }),
      makeIssue({
        id: "blocked-upstream",
        missionControl: {
          workflowState: {
            kind: "blocked_on_upstream",
            enteredAt: new Date("2026-04-17T00:00:00.000Z"),
          },
        },
      }),
      makeIssue({ id: "active", status: "in_progress" }),
    ];

    const filtered = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      blockedOrWaiting: true,
    });

    expect(filtered.map((issue) => issue.id)).toEqual([
      "blocked-status",
      "waiting-human",
      "blocked-upstream",
    ]);
  });

  it("filters recent handoffs from either activity summaries or active handoff state", () => {
    const issues = [
      makeIssue({
        id: "summary-handoff",
        latestHandoffSummary: {
          kind: "handoff",
          action: "issue.reviewers_updated",
          text: "Handed off to Ork",
          actorType: "agent",
          actorId: "agent-1",
          agentId: "agent-1",
          userId: null,
          createdAt: new Date("2026-04-16T00:00:00.000Z"),
        },
      }),
      makeIssue({
        id: "active-handoff",
        missionControl: {
          handoff: {
            fromAgentId: "agent-1",
            toAgentId: "agent-2",
            reason: "Need implementation",
            requestedNextStep: "Pick up the coding slice",
            unblockCondition: null,
            timestamp: new Date("2026-04-17T00:00:00.000Z"),
            context: {
              issueId: "issue-1",
              identifier: "PAP-1",
              title: "Issue",
            },
          },
        },
      }),
      makeIssue({ id: "no-handoff" }),
    ];

    const filtered = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      recentHandoffs: true,
    });

    expect(filtered.map((issue) => issue.id)).toEqual(["summary-handoff", "active-handoff"]);
  });

  it("counts mission-control visibility filters as active groups", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      blockedOrWaiting: true,
      recentHandoffs: true,
    })).toBe(2);
  });
});
