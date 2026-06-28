// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ExternalObjectSummary, Issue } from "@paperclipai/shared";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  resolveIssueFilterWorkspaceId,
  shouldIncludeIssueFilterWorkspaceOption,
} from "./issue-filters";

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
    workMode: overrides.workMode ?? "standard",
  };
}

function makeExternalObjectSummary(overrides: Partial<ExternalObjectSummary> = {}): ExternalObjectSummary {
  return {
    total: 1,
    byStatusCategory: {},
    byLiveness: { fresh: 1 },
    highestSeverity: "neutral",
    staleCount: 0,
    authRequiredCount: 0,
    unreachableCount: 0,
    objects: [],
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

  it("filters issues to live issue ids when live-only is enabled", () => {
    const issues = [
      makeIssue({ id: "live-issue" }),
      makeIssue({ id: "idle-issue" }),
    ];

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, liveOnly: true },
      null,
      false,
      new Set(["live-issue"]),
    );

    expect(filtered.map((issue) => issue.id)).toEqual(["live-issue"]);
  });

  it("counts the live-only filter as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      liveOnly: true,
    })).toBe(1);
  });

  it("does not treat default project workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "default-workspace-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
    });
    const workspaceContext = {
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(applyIssueFilters(
      [issue],
      { ...defaultIssueFilterState, workspaces: ["workspace-default"] },
      null,
      false,
      undefined,
      workspaceContext,
    )).toEqual([]);
  });

  it("does not treat shared default execution workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "shared-default-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-shared-default",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-shared-default",
        { mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-shared-default", mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(false);
  });

  it("keeps non-default project and isolated execution workspaces filterable", () => {
    const featureIssue = makeIssue({
      id: "feature-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-feature",
    });
    const executionIssue = makeIssue({
      id: "execution-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-isolated",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-isolated",
        { mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(featureIssue, workspaceContext)).toBe("workspace-feature");
    expect(resolveIssueFilterWorkspaceId(executionIssue, workspaceContext)).toBe("execution-isolated");
    expect(shouldIncludeIssueFilterWorkspaceOption({ id: "workspace-feature" }, new Set(["workspace-default"]))).toBe(true);
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-isolated", mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(true);
  });

  it.each([
    ["failed", ["failed-issue", "blocked-issue"]],
    ["auth_required", ["auth-issue"]],
    ["stale", ["stale-issue"]],
    ["none", ["none-issue"]],
  ])("filters issues by external-object status token %s", (externalObjectStatus, expectedIssueIds) => {
    const issues = [
      makeIssue({ id: "failed-issue" }),
      makeIssue({ id: "blocked-issue" }),
      makeIssue({ id: "auth-issue" }),
      makeIssue({ id: "stale-issue" }),
      makeIssue({ id: "none-issue" }),
      makeIssue({ id: "fresh-issue" }),
    ];
    const summaries = new Map<string, ExternalObjectSummary>([
      ["failed-issue", makeExternalObjectSummary({ byStatusCategory: { failed: 1 }, highestSeverity: "danger" })],
      ["blocked-issue", makeExternalObjectSummary({ byStatusCategory: { blocked: 1 }, highestSeverity: "danger" })],
      ["auth-issue", makeExternalObjectSummary({
        byLiveness: { auth_required: 1 },
        highestSeverity: "danger",
        authRequiredCount: 1,
      })],
      ["stale-issue", makeExternalObjectSummary({
        byLiveness: { stale: 1 },
        highestSeverity: "warning",
        staleCount: 1,
      })],
      ["fresh-issue", makeExternalObjectSummary({ byStatusCategory: { succeeded: 1 }, highestSeverity: "success" })],
    ]);

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, externalObjectStatuses: [externalObjectStatus] },
      null,
      false,
      undefined,
      {
        externalObjectSummaryByIssueId: summaries,
        externalObjectSummariesReady: true,
      },
    );

    expect(filtered.map((issue) => issue.id)).toEqual(expectedIssueIds);
  });

  it("does not apply external-object filters before summaries are ready", () => {
    const filtered = applyIssueFilters(
      [makeIssue({ id: "issue-1" })],
      { ...defaultIssueFilterState, externalObjectStatuses: ["none"] },
      null,
      false,
      undefined,
      { externalObjectSummaryByIssueId: new Map(), externalObjectSummariesReady: false },
    );

    expect(filtered).toEqual([]);
  });
});
