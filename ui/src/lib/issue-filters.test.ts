// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ExternalObjectSummary, Issue } from "@paperclipai/shared";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueUpdatedServerBefore,
  issueUpdatedTimeRange,
  issueUpdatedWithinPatch,
  nextIssueUpdatedFilterExpiryMs,
  normalizeIssueFilterState,
  readIssueUpdatedParams,
  writeIssueUpdatedParams,
  resolveIssueFilterWorkspaceId,
  searchIssueFilterOptions,
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
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
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

it("separates monitored waits from In Progress in task filters", () => {
  const monitored = makeIssue({ id: "waiting", status: "in_progress", displayStatus: "monitoring" });
  const working = makeIssue({ id: "working", status: "in_progress" });
  const rows = [monitored, working];
  expect(applyIssueFilters(rows, { ...defaultIssueFilterState, statuses: ["monitoring"] }).map(row => row.id)).toEqual(["waiting"]);
  expect(applyIssueFilters(rows, { ...defaultIssueFilterState, statuses: ["in_progress"] }).map(row => row.id)).toEqual(["working"]);
});

describe("issue filters", () => {
  it("hides automation by default while an opt-in includes every creation source", () => {
    const issues = [makeIssue({ id: "human", createdByUserId: "person" }), makeIssue({ id: "agent", createdByAgentId: "agent" }), makeIssue({ id: "routine", originKind: "routine_execution", createdByUserId: "person" }), makeIssue({ id: "system" })];
    expect(applyIssueFilters(issues, defaultIssueFilterState, null, true).map((issue) => issue.id)).toEqual(["human"]);
    expect(applyIssueFilters(issues, { ...defaultIssueFilterState, showAgentCreatedTasks: true }, null, true)).toEqual(issues);
    // Membership and task-detail collections can explicitly bypass creation visibility.
    expect(applyIssueFilters(issues, defaultIssueFilterState, null, false)).toEqual(issues);
    expect(countActiveIssueFilters(defaultIssueFilterState, true)).toBe(0);
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, showAgentCreatedTasks: true }, true)).toBe(1);
  });

  it("selects only routine executions even when automatic tasks are hidden", () => {
    const routine = makeIssue({ id: "routine", originKind: "routine_execution", createdByUserId: "person" });
    const issues = [makeIssue({ id: "manual", createdByUserId: "person" }), routine,
      makeIssue({ id: "agent", createdByAgentId: "agent" }), makeIssue({ id: "channel", originKind: "chat_channel" })];
    const filters = { ...defaultIssueFilterState, routineTasksOnly: true };
    expect(applyIssueFilters(issues, filters, null, true)).toEqual([routine]);
    expect(applyIssueFilters(issues, { ...filters, statuses: ["done"] })).toEqual([]);
    expect(countActiveIssueFilters(filters, true)).toBe(1);
    expect(normalizeIssueFilterState({ routineTasksOnly: true }).routineTasksOnly).toBe(true);
    expect(normalizeIssueFilterState({ routineTasksOnly: "true" }).routineTasksOnly).toBe(false);
  });

  it("defaults legacy and invalid preferences to hidden without losing other filters", () => {
    expect(normalizeIssueFilterState({ hideRoutineExecutions: false, statuses: ["todo"] })).toMatchObject({ showAgentCreatedTasks: false, statuses: ["todo"] });
    expect(normalizeIssueFilterState({ showAgentCreatedTasks: "true" }).showAgentCreatedTasks).toBe(false);
    expect(normalizeIssueFilterState({ showAgentCreatedTasks: true }).showAgentCreatedTasks).toBe(true);
  });

  it("searches filter options case-insensitively without mutating the source", () => {
    const options = [{ name: "Alpha Agent" }, { name: "Release QA" }];
    expect(searchIssueFilterOptions(options, "  qa ", (option) => option.name)).toEqual([
      { name: "Release QA" },
    ]);
    expect(options).toHaveLength(2);
  });

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

describe("Updated filter", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
  const updatedIds = (issues: Issue[], patch: Parameters<typeof applyIssueFilters>[1]) =>
    applyIssueFilters(issues, patch, null, false, undefined, {}, now).map((issue) => issue.id);

  it("keeps only tasks whose row time is inside the last 3 days", () => {
    const issues = [
      makeIssue({ id: "fresh", updatedAt: hoursAgo(1) }),
      makeIssue({ id: "edge", updatedAt: hoursAgo(72) }),
      makeIssue({ id: "old", updatedAt: hoursAgo(72.01) }),
    ];
    expect(updatedIds(issues, { ...defaultIssueFilterState, updatedWithin: "3d" })).toEqual(["fresh", "edge"]);
    expect(updatedIds(issues, { ...defaultIssueFilterState, updatedWithin: "24h" })).toEqual(["fresh"]);
    expect(updatedIds(issues, { ...defaultIssueFilterState, updatedWithin: "7d" })).toEqual(["fresh", "edge", "old"]);
    expect(updatedIds(issues, defaultIssueFilterState)).toEqual(["fresh", "edge", "old"]);
  });

  it("uses the same time the row shows, not only the stored update time", () => {
    const issues = [
      makeIssue({ id: "commented", updatedAt: hoursAgo(24 * 10), lastActivityAt: hoursAgo(2) }),
      makeIssue({ id: "external", updatedAt: hoursAgo(24 * 10), lastExternalCommentAt: hoursAgo(5) }),
      makeIssue({ id: "stale-activity", updatedAt: hoursAgo(1), lastActivityAt: hoursAgo(24 * 10) }),
    ];
    expect(updatedIds(issues, { ...defaultIssueFilterState, updatedWithin: "3d" })).toEqual(["commented", "external"]);
  });

  it("runs a custom range from the start of the first day to the end of the last day in local time", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const issues = [
        makeIssue({ id: "before", updatedAt: new Date("2026-11-03T07:59:59.999Z") }),
        makeIssue({ id: "first-moment", updatedAt: new Date("2026-11-03T08:00:00.000Z") }),
        makeIssue({ id: "last-moment", updatedAt: new Date("2026-11-05T07:59:59.999Z") }),
        makeIssue({ id: "after", updatedAt: new Date("2026-11-05T08:00:00.000Z") }),
      ];
      const range = { ...defaultIssueFilterState, updatedWithin: "custom" as const, updatedFrom: "2026-11-03", updatedTo: "2026-11-04" };
      expect(updatedIds(issues, range)).toEqual(["first-moment", "last-moment"]);
      expect(updatedIds(issues, { ...range, updatedFrom: "2026-11-04", updatedTo: "2026-11-03" })).toEqual(["first-moment", "last-moment"]);
      expect(updatedIds(issues, { ...range, updatedTo: null })).toEqual(["first-moment", "last-moment", "after"]);
      expect(updatedIds(issues, { ...range, updatedFrom: null })).toEqual(["before", "first-moment", "last-moment"]);
      expect(issueUpdatedTimeRange({ updatedWithin: "custom", updatedFrom: null, updatedTo: null }, now)).toBeNull();
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("restores saved choices and drops values it does not know", () => {
    expect(normalizeIssueFilterState({ updatedWithin: "3d" })).toMatchObject({ updatedWithin: "3d", updatedFrom: null, updatedTo: null });
    expect(normalizeIssueFilterState({ updatedWithin: "custom", updatedFrom: "2026-11-01", updatedTo: "2026-11-12" }))
      .toMatchObject({ updatedWithin: "custom", updatedFrom: "2026-11-01", updatedTo: "2026-11-12" });
    expect(normalizeIssueFilterState({ updatedWithin: "90d", updatedFrom: "Nov 1", updatedTo: 5 }))
      .toMatchObject({ updatedWithin: null, updatedFrom: null, updatedTo: null });
    expect(normalizeIssueFilterState({})).toMatchObject({ updatedWithin: null });
    expect(normalizeIssueFilterState({ updatedWithin: "custom", updatedFrom: "2026-02-31", updatedTo: "2026-13-01" }))
      .toMatchObject({ updatedWithin: "custom", updatedFrom: null, updatedTo: null });
    expect(issueUpdatedTimeRange({ updatedWithin: "custom", updatedFrom: "2026-02-31", updatedTo: "2026-02-30" })).toBeNull();
  });

  it("counts as one active filter and clears with the default state", () => {
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, updatedWithin: "3d" })).toBe(1);
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, updatedWithin: "custom", updatedFrom: "2026-11-01", updatedTo: "2026-11-12" })).toBe(1);
    expect(countActiveIssueFilters(defaultIssueFilterState)).toBe(0);
    expect(defaultIssueFilterState).toMatchObject({ updatedWithin: null, updatedFrom: null, updatedTo: null });
  });

  it("sends the server only the end of a custom range", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(issueUpdatedServerBefore({ updatedWithin: "custom", updatedFrom: "2026-11-03", updatedTo: "2026-11-04" }))
        .toBe("2026-11-05T08:00:00.000Z");
      expect(issueUpdatedServerBefore({ updatedWithin: "custom", updatedFrom: "2026-11-03", updatedTo: null })).toBeUndefined();
      expect(issueUpdatedServerBefore({ updatedWithin: "3d", updatedFrom: null, updatedTo: null })).toBeUndefined();
      expect(issueUpdatedServerBefore({ updatedWithin: null, updatedFrom: null, updatedTo: "2026-11-04" })).toBeUndefined();
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("keeps custom days only for a custom range", () => {
    expect(issueUpdatedWithinPatch("3d")).toEqual({ updatedWithin: "3d", updatedFrom: null, updatedTo: null });
    expect(issueUpdatedWithinPatch(null)).toEqual({ updatedWithin: null, updatedFrom: null, updatedTo: null });
    expect(issueUpdatedWithinPatch("custom")).toEqual({ updatedWithin: "custom" });
  });

  it("reads and writes the page address values", () => {
    const params = new URLSearchParams("view=all&updated=custom&updatedFrom=2026-11-01&updatedTo=bad");
    expect(readIssueUpdatedParams(params)).toEqual({ updatedWithin: "custom", updatedFrom: "2026-11-01", updatedTo: null });
    expect(readIssueUpdatedParams(new URLSearchParams("updated=3d&updatedFrom=2026-11-01")))
      .toEqual({ updatedWithin: "3d", updatedFrom: null, updatedTo: null });
    expect(readIssueUpdatedParams(new URLSearchParams("updated=90d"))).toEqual({ updatedWithin: null, updatedFrom: null, updatedTo: null });

    writeIssueUpdatedParams(params, { updatedWithin: "custom", updatedFrom: "2026-11-01", updatedTo: "2026-11-12" });
    expect(params.toString()).toBe("view=all&updated=custom&updatedFrom=2026-11-01&updatedTo=2026-11-12");
    writeIssueUpdatedParams(params, { updatedWithin: "7d", updatedFrom: "2026-11-01", updatedTo: null });
    expect(params.toString()).toBe("view=all&updated=7d");
    writeIssueUpdatedParams(params, { updatedWithin: null, updatedFrom: null, updatedTo: null });
    expect(params.toString()).toBe("view=all");
  });

  it("computes the earliest expiry timestamp for relative windows only", () => {
    const issues = [
      makeIssue({ id: "already-old", updatedAt: hoursAgo(30) }),
      makeIssue({ id: "expiring-soon", updatedAt: hoursAgo(23) }),
      makeIssue({ id: "fresh", updatedAt: hoursAgo(1) }),
    ];
    expect(nextIssueUpdatedFilterExpiryMs(issues, "24h", now.getTime())).toBe(
      hoursAgo(23).getTime() + 24 * 60 * 60 * 1000 + 1,
    );
    expect(nextIssueUpdatedFilterExpiryMs(issues, null, now.getTime())).toBeNull();
    expect(nextIssueUpdatedFilterExpiryMs(issues, "custom", now.getTime())).toBeNull();
    expect(nextIssueUpdatedFilterExpiryMs([makeIssue({ id: "old", updatedAt: hoursAgo(30) })], "24h", now.getTime())).toBeNull();
  });
});
