// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import type { Approval, DashboardSummary, HeartbeatRun, Issue, JoinRequest } from "@paperclipai/shared";
import {
  computeInboxBadgeData,
  getRecentTouchedIssues,
  getUnreadTouchedIssues,
  loadLastInboxTab,
  RECENT_ISSUES_LIMIT,
  saveLastInboxTab,
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
    goalId: null,
    parentId: null,
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
    isUnreadForMe,
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
      unreadIssues: [makeIssue("1", true)],
      dismissed: new Set<string>(),
    });

    expect(result).toEqual({
      inbox: 6,
      approvals: 1,
      failedRuns: 2,
      joinRequests: 1,
      unreadTouchedIssues: 1,
      alerts: 1,
    });
  });

  it("drops dismissed runs and alerts from the computed badge", () => {
    const result = computeInboxBadgeData({
      approvals: [],
      joinRequests: [],
      dashboard,
      heartbeatRuns: [makeRun("run-1", "failed", "2026-03-11T00:00:00.000Z")],
      unreadIssues: [],
      dismissed: new Set<string>(["run:run-1", "alert:budget", "alert:agent-errors"]),
    });

    expect(result).toEqual({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      unreadTouchedIssues: 0,
      alerts: 0,
    });
  });

  it("keeps read issues in the touched list but excludes them from unread counts", () => {
    const issues = [makeIssue("1", true), makeIssue("2", false)];

    expect(getUnreadTouchedIssues(issues).map((issue) => issue.id)).toEqual(["1"]);
    expect(issues).toHaveLength(2);
  });

  it("limits recent touched issues before unread badge counting", () => {
    const issues = Array.from({ length: RECENT_ISSUES_LIMIT + 5 }, (_, index) => {
      const issue = makeIssue(String(index + 1), index < 3);
      issue.lastExternalCommentAt = new Date(Date.UTC(2026, 2, 31, 0, 0, 0, 0) - index * 60_000);
      return issue;
    });

    const recentIssues = getRecentTouchedIssues(issues);

    expect(recentIssues).toHaveLength(RECENT_ISSUES_LIMIT);
    expect(getUnreadTouchedIssues(recentIssues).map((issue) => issue.id)).toEqual(["1", "2", "3"]);
  });

  it("defaults the remembered inbox tab to recent and persists all", () => {
    localStorage.clear();
    expect(loadLastInboxTab()).toBe("recent");

    saveLastInboxTab("all");
    expect(loadLastInboxTab()).toBe("all");
  });

  it("maps legacy new-tab storage to recent", () => {
    localStorage.setItem("paperclip:inbox:last-tab", "new");
    expect(loadLastInboxTab()).toBe("recent");
  });
});
