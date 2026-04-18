// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { defaultIssueFilterState } from "./issue-filters";
import {
  buildInboxOperationalViews,
  filterOperationalQueueIssues,
  getActiveInboxOperationalViewKey,
  getMissionControlOwnerAgents,
} from "./inbox-operational-views";

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

describe("inbox operational views", () => {
  it("limits owner views to the mission-control operators in stable order", () => {
    const ownerAgents = getMissionControlOwnerAgents([
      { id: "agent-3", name: "Stitch" },
      { id: "agent-4", name: "Someone Else" },
      { id: "agent-1", name: "Main" },
      { id: "agent-2", name: "Ork" },
      { id: "agent-5", name: "Personal OS" },
    ]);

    expect(ownerAgents.map((agent) => agent.name)).toEqual(["Main", "Ork", "Stitch", "Personal OS"]);
  });

  it("builds the blocked/waiting and recent-handoff operational views", () => {
    const views = buildInboxOperationalViews([{ id: "agent-1", name: "Main" }], true);

    expect(views.find((view) => view.key === "blocked_or_waiting")?.filterState).toMatchObject({
      statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
      blockedOrWaiting: true,
      hideRoutineExecutions: true,
    });
    expect(views.find((view) => view.key === "recent_handoffs")?.filterState).toMatchObject({
      recentHandoffs: true,
      hideRoutineExecutions: true,
    });
  });

  it("detects the active operational view from filter state", () => {
    const views = buildInboxOperationalViews([
      { id: "agent-1", name: "Main" },
      { id: "agent-2", name: "Ork" },
    ], false);

    expect(getActiveInboxOperationalViewKey({
      ...defaultIssueFilterState,
      statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
      owners: ["agent-2"],
    }, views)).toBe("owner:agent-2");

    expect(getActiveInboxOperationalViewKey(defaultIssueFilterState, views)).toBeNull();
  });

  it("keeps the operator queue limited to mission-control workflow lanes", () => {
    const ownerAgents = getMissionControlOwnerAgents([
      { id: "agent-main", name: "Main" },
      { id: "agent-ork", name: "Ork" },
      { id: "agent-stitch", name: "Stitch" },
      { id: "agent-personal", name: "Personal OS" },
      { id: "agent-other", name: "Support Bot" },
    ]);

    const filtered = filterOperationalQueueIssues(
      [
        makeIssue({ id: "owned-by-main", ownerAgentId: "agent-main" }),
        makeIssue({
          id: "needs-human",
          missionControl: {
            collaboratorAgentIds: [],
            needsHumanAttention: true,
          },
        }),
        makeIssue({
          id: "active-handoff",
          missionControl: {
            collaboratorAgentIds: [],
            handoff: {
              fromAgentId: "agent-main",
              toAgentId: "agent-ork",
              reason: "Implementation",
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
        makeIssue({
          id: "blocked-upstream",
          missionControl: {
            collaboratorAgentIds: [],
            workflowState: {
              kind: "blocked_on_upstream",
              enteredAt: new Date("2026-04-17T01:00:00.000Z"),
            },
          },
        }),
        makeIssue({ id: "other-owner-noise", ownerAgentId: "agent-other" }),
        makeIssue({ id: "unowned-generic-noise" }),
      ],
      ownerAgents,
    );

    expect(filtered.map((issue) => issue.id)).toEqual([
      "owned-by-main",
      "needs-human",
      "active-handoff",
      "blocked-upstream",
    ]);
  });
});
