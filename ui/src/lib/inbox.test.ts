// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import type {
  Approval,
  DashboardSummary,
  ExecutionWorkspace,
  HeartbeatRun,
  Issue,
  JoinRequest,
  ProjectWorkspace,
} from "@paperclipai/shared";
import {
  DEFAULT_INBOX_ISSUE_COLUMNS,
  computeInboxBadgeData,
  getAvailableInboxIssueColumns,
  getApprovalsForTab,
  getInboxWorkItems,
  getInboxKeyboardSelectionIndex,
  getRecentTouchedIssues,
  getUnreadTouchedIssues,
  isMineInboxTab,
  loadInboxIssueColumns,
  loadLastInboxTab,
  normalizeInboxIssueColumns,
  RECENT_ISSUES_LIMIT,
  resolveIssueWorkspaceName,
  resolveInboxSelectionIndex,
  saveInboxIssueColumns,
  saveLastInboxTab,
  shouldShowInboxSection,
} from "./inbox";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

function makeApproval(status: Approval["status"]): Approval {
  return {
    id: `approval-${status}`,
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status,
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
  };
}

function makeApprovalWithTimestamps(
  id: string,
  status: Approval["status"],
  updatedAt: string,
): Approval {
  return {
    ...makeApproval(status),
    id,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

function makeJoinRequest(id: string): JoinRequest {
  return {
    id,
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestEmailSnapshot: null,
    requestIp: "127.0.0.1",
    requestingUserId: null,
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
  };
}

function makeRun(id: string, status: HeartbeatRun["status"], createdAt: string, agentId = "agent-1"): HeartbeatRun {
  return {
    id,
    companyId: "company-1",
    agentId,
    invocationSource: "assignment",
    triggerDetail: null,
    status,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    contextSnapshot: null,
    startedAt: new Date(createdAt),
    finishedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function makeIssue(id: string, isUnreadForMe: boolean): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    issueType: "task",
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: `PAP-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: new Date("2026-03-11T00:00:00.000Z"),
    lastExternalCommentAt: new Date("2026-03-11T01:00:00.000Z"),
    lastActivityAt: new Date("2026-03-11T01:00:00.000Z"),
    isUnreadForMe,
  };
}

function makeProjectWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  return {
    id: "project-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

function makeExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 branch",
    status: "active",
    cwd: "/tmp/project/worktree",
    repoUrl: null,
    baseRef: null,
    branchName: "pap-1",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-03-11T00:00:00.000Z"),
    openedAt: new Date("2026-03-11T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

const dashboard: DashboardSummary = {
  companyId: "company-1",
  agents: {
    active: 1,
    running: 0,
    paused: 0,
    error: 1,
  },
  tasks: {
    open: 1,
    inProgress: 0,
    blocked: 0,
    done: 0,
  },
  costs: {
    monthSpendCents: 900,
    monthBudgetCents: 1000,
    monthUtilizationPercent: 90,
  },
  pendingApprovals: 1,
  budgets: {
    activeIncidents: 0,
    pendingApprovals: 0,
    pausedAgents: 0,
    pausedProjects: 0,
  },
};

describe("inbox helpers", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("counts the same inbox sources the badge uses", () => {
    const result = computeInboxBadgeData({
      approvals: [makeApproval("pending"), makeApproval("approved")],
      joinRequests: [makeJoinRequest("join-1")],
      dashboard,
      heartbeatRuns: [
        makeRun("run-old", "failed", "2026-03-11T00:00:00.000Z"),
        makeRun("run-latest", "timed_out", "2026-03-11T01:00:00.000Z"),
        makeRun("run-other-agent", "failed", "2026-03-11T02:00:00.000Z", "agent-2"),
      ],
      mineIssues: [makeIssue("1", true)],
      dismissed: new Set<string>(),
    });

    expect(result).toEqual({
      inbox: 6,
      approvals: 1,
      failedRuns: 2,
      joinRequests: 1,
      mineIssues: 1,
      alerts: 1,
    });
  });

  it("drops dismissed runs and alerts from the computed badge", () => {
    const result = computeInboxBadgeData({
      approvals: [],
      joinRequests: [],
      dashboard,
      heartbeatRuns: [makeRun("run-1", "failed", "2026-03-11T00:00:00.000Z")],
      mineIssues: [],
      dismissed: new Set<string>(["run:run-1", "alert:budget", "alert:agent-errors"]),
    });

    expect(result).toEqual({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      mineIssues: 0,
      alerts: 0,
    });
  });

  it("keeps read issues in the touched list but excludes them from unread counts", () => {
    const issues = [makeIssue("1", true), makeIssue("2", false)];

    expect(getUnreadTouchedIssues(issues).map((issue) => issue.id)).toEqual(["1"]);
    expect(issues).toHaveLength(2);
  });

  it("shows recent approvals in updated order and unread approvals as actionable only", () => {
    const approvals = [
      makeApprovalWithTimestamps("approval-approved", "approved", "2026-03-11T02:00:00.000Z"),
      makeApprovalWithTimestamps("approval-pending", "pending", "2026-03-11T01:00:00.000Z"),
      makeApprovalWithTimestamps(
        "approval-revision",
        "revision_requested",
        "2026-03-11T03:00:00.000Z",
      ),
    ];

    expect(getApprovalsForTab(approvals, "mine", "all").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-approved",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "recent", "all").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-approved",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "unread", "all").map((approval) => approval.id)).toEqual([
      "approval-revision",
      "approval-pending",
    ]);
    expect(getApprovalsForTab(approvals, "all", "resolved").map((approval) => approval.id)).toEqual([
      "approval-approved",
    ]);
  });

  it("mixes approvals into the inbox feed by most recent activity", () => {
    const newerIssue = makeIssue("1", true);
    newerIssue.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    const olderIssue = makeIssue("2", false);
    olderIssue.lastActivityAt = new Date("2026-03-11T02:00:00.000Z");

    const approval = makeApprovalWithTimestamps(
      "approval-between",
      "pending",
      "2026-03-11T03:00:00.000Z",
    );

    expect(
      getInboxWorkItems({
        issues: [olderIssue, newerIssue],
        approvals: [approval],
      }).map((item) => {
        if (item.kind === "issue") return `issue:${item.issue.id}`;
        if (item.kind === "approval") return `approval:${item.approval.id}`;
        if (item.kind === "join_request") return `join:${item.joinRequest.id}`;
        return `run:${item.run.id}`;
      }),
    ).toEqual([
      "issue:1",
      "approval:approval-between",
      "issue:2",
    ]);
  });

  it("prefers canonical lastActivityAt over comment-only timestamps", () => {
    const activityIssue = makeIssue("1", true);
    activityIssue.lastExternalCommentAt = new Date("2026-03-11T01:00:00.000Z");
    activityIssue.lastActivityAt = new Date("2026-03-11T05:00:00.000Z");

    const commentIssue = makeIssue("2", true);
    commentIssue.lastExternalCommentAt = new Date("2026-03-11T04:00:00.000Z");
    commentIssue.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    expect(getRecentTouchedIssues([commentIssue, activityIssue]).map((issue) => issue.id)).toEqual(["1", "2"]);
  });

  it("mixes join requests into the inbox feed by most recent activity", () => {
    const issue = makeIssue("1", true);
    issue.lastActivityAt = new Date("2026-03-11T04:00:00.000Z");

    const joinRequest = makeJoinRequest("join-1");
    joinRequest.createdAt = new Date("2026-03-11T03:00:00.000Z");

    const approval = makeApprovalWithTimestamps(
      "approval-oldest",
      "pending",
      "2026-03-11T02:00:00.000Z",
    );

    expect(
      getInboxWorkItems({
        issues: [issue],
        approvals: [approval],
        joinRequests: [joinRequest],
      }).map((item) => {
        if (item.kind === "issue") return `issue:${item.issue.id}`;
        if (item.kind === "approval") return `approval:${item.approval.id}`;
        if (item.kind === "join_request") return `join:${item.joinRequest.id}`;
        return `run:${item.run.id}`;
      }),
    ).toEqual([
      "issue:1",
      "join:join-1",
      "approval:approval-oldest",
    ]);
  });

  it("sorts self-touched issues without external comments by updatedAt", () => {
    const recentSelfTouched = makeIssue("recent", false);
    recentSelfTouched.lastExternalCommentAt = null as unknown as Date;
    recentSelfTouched.updatedAt = new Date("2026-03-11T05:00:00.000Z");
    recentSelfTouched.myLastTouchAt = new Date("2026-03-11T05:00:00.000Z");

    const olderCommented = makeIssue("older", false);
    olderCommented.lastExternalCommentAt = new Date("2026-03-11T03:00:00.000Z");

    const items = getInboxWorkItems({
      issues: [olderCommented, recentSelfTouched],
      approvals: [],
    });

    expect(items.map((i) => (i.kind === "issue" ? i.issue.id : ""))).toEqual([
      "recent",
      "older",
    ]);
  });

  it("can include sections on recent without forcing them to be unread", () => {
    expect(
      shouldShowInboxSection({
        tab: "mine",
        hasItems: true,
        showOnMine: true,
        showOnRecent: false,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInboxSection({
        tab: "recent",
        hasItems: true,
        showOnMine: false,
        showOnRecent: true,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInboxSection({
        tab: "unread",
        hasItems: true,
        showOnMine: true,
        showOnRecent: true,
        showOnUnread: false,
        showOnAll: false,
      }),
    ).toBe(false);
  });

  it("limits recent touched issues before unread badge counting", () => {
    const issues = Array.from({ length: RECENT_ISSUES_LIMIT + 5 }, (_, index) => {
      const issue = makeIssue(String(index + 1), index < 3);
      issue.lastActivityAt = new Date(Date.UTC(2026, 2, 31, 0, 0, 0, 0) - index * 60_000);
      return issue;
    });

    const recentIssues = getRecentTouchedIssues(issues);

    expect(recentIssues).toHaveLength(RECENT_ISSUES_LIMIT);
    expect(getUnreadTouchedIssues(recentIssues).map((issue) => issue.id)).toEqual(["1", "2", "3"]);
  });

  it("defaults the remembered inbox tab to mine and persists all", () => {
    localStorage.clear();
    expect(loadLastInboxTab()).toBe("mine");

    saveLastInboxTab("all");
    expect(loadLastInboxTab()).toBe("all");
  });

  it("defaults issue columns to the current inbox layout", () => {
    expect(loadInboxIssueColumns()).toEqual(DEFAULT_INBOX_ISSUE_COLUMNS);
  });

  it("normalizes saved issue columns to valid values in canonical order", () => {
    saveInboxIssueColumns(["labels", "updated", "status", "workspace", "labels", "assignee"]);

    expect(loadInboxIssueColumns()).toEqual(["status", "assignee", "workspace", "labels", "updated"]);
    expect(normalizeInboxIssueColumns(["project", "workspace", "wat", "id"])).toEqual(["id", "project", "workspace"]);
  });

  it("hides the workspace column option unless isolated workspaces are enabled", () => {
    expect(getAvailableInboxIssueColumns(false)).toEqual(["status", "id", "assignee", "project", "labels", "updated"]);
    expect(getAvailableInboxIssueColumns(true)).toEqual([
      "status",
      "id",
      "assignee",
      "project",
      "workspace",
      "labels",
      "updated",
    ]);
  });

  it("allows hiding every optional issue column down to the title-only view", () => {
    saveInboxIssueColumns([]);
    expect(loadInboxIssueColumns()).toEqual([]);
  });

  it("shows explicit workspace names but leaves the default workspace blank", () => {
    const issue = makeIssue("1", true);
    issue.projectId = "project-1";
    issue.projectWorkspaceId = "project-workspace-1";
    issue.executionWorkspaceId = "execution-workspace-1";

    const executionWorkspace = makeExecutionWorkspace();
    const defaultWorkspace = makeProjectWorkspace();
    const secondaryWorkspace = makeProjectWorkspace({
      id: "project-workspace-2",
      name: "Secondary workspace",
      isPrimary: false,
    });

    expect(
      resolveIssueWorkspaceName(issue, {
        executionWorkspaceById: new Map([[executionWorkspace.id, executionWorkspace]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("PAP-1 branch");

    issue.executionWorkspaceId = null;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    issue.projectWorkspaceId = secondaryWorkspace.id;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("Secondary workspace");

    issue.projectWorkspaceId = null;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    issue.executionWorkspaceId = "execution-workspace-shared-default";
    issue.projectWorkspaceId = defaultWorkspace.id;
    expect(
      resolveIssueWorkspaceName(issue, {
        executionWorkspaceById: new Map([[
          issue.executionWorkspaceId,
          makeExecutionWorkspace({
            id: issue.executionWorkspaceId,
            mode: "shared_workspace",
            strategyType: "project_primary",
            projectWorkspaceId: defaultWorkspace.id,
            name: "PAP-1067",
          }),
        ]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();
  });

  it("maps legacy new-tab storage to mine", () => {
    localStorage.setItem("paperclip:inbox:last-tab", "new");
    expect(loadLastInboxTab()).toBe("mine");
  });

  it("enables swipe archive only on the mine tab", () => {
    expect(isMineInboxTab("mine")).toBe(true);
    expect(isMineInboxTab("recent")).toBe(false);
    expect(isMineInboxTab("unread")).toBe(false);
    expect(isMineInboxTab("all")).toBe(false);
  });

  it("anchors Mine selection to the first available inbox row", () => {
    expect(resolveInboxSelectionIndex(-1, 3)).toBe(-1);
    expect(resolveInboxSelectionIndex(5, 3)).toBe(2);
    expect(resolveInboxSelectionIndex(1, 0)).toBe(-1);
  });

  it("selects the first row only after keyboard navigation starts", () => {
    expect(getInboxKeyboardSelectionIndex(-1, 3, "next")).toBe(0);
    expect(getInboxKeyboardSelectionIndex(-1, 3, "previous")).toBe(0);
    expect(getInboxKeyboardSelectionIndex(0, 3, "next")).toBe(1);
    expect(getInboxKeyboardSelectionIndex(0, 3, "previous")).toBe(0);
  });
});
