// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ActivityEvent, Agent, HeartbeatRun, Issue } from "@paperclipai/shared";
import { deriveDashboardObservability } from "./dashboard-observability";

const NOW = new Date("2026-03-31T12:00:00.000Z");

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  const { id, name, ...rest } = overrides;
  return Object.assign({
    id,
    companyId: "company-1",
    name,
    urlKey: name.toLowerCase().replace(/\s+/g, "-"),
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false,
    },
    lastHeartbeatAt: new Date("2026-03-31T11:00:00.000Z"),
    metadata: null,
    createdAt: new Date("2026-03-31T09:00:00.000Z"),
    updatedAt: new Date("2026-03-31T11:00:00.000Z"),
  }, rest);
}

function makeIssue(overrides: Partial<Issue> & Pick<Issue, "id" | "status" | "title">): Issue {
  const { id, status, title, ...rest } = overrides;
  return Object.assign({
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status,
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
    identifier: `TCN-${overrides.id}`,
    originKind: "manual",
    originId: null,
    originRunId: null,
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
    createdAt: new Date("2026-03-31T09:00:00.000Z"),
    updatedAt: new Date("2026-03-31T10:00:00.000Z"),
  }, rest);
}

function makeRun(overrides: Partial<HeartbeatRun> & Pick<HeartbeatRun, "id" | "agentId" | "status">): HeartbeatRun {
  const { id, agentId, status, ...rest } = overrides;
  return Object.assign({
    id,
    companyId: "company-1",
    agentId,
    invocationSource: "assignment",
    triggerDetail: null,
    status,
    startedAt: new Date("2026-03-31T10:00:00.000Z"),
    finishedAt: new Date("2026-03-31T10:05:00.000Z"),
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
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    operationalEffect: null,
    createdAt: new Date("2026-03-31T10:00:00.000Z"),
    updatedAt: new Date("2026-03-31T10:05:00.000Z"),
  }, rest);
}

function makeActivityEvent(
  overrides: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "action" | "entityType" | "entityId">,
): ActivityEvent {
  const { id, action, entityType, entityId, ...rest } = overrides;
  return Object.assign({
    id,
    companyId: "company-1",
    actorType: "system",
    actorId: "paperclip",
    action,
    entityType,
    entityId,
    agentId: null,
    runId: null,
    details: null,
    createdAt: new Date("2026-03-31T10:00:00.000Z"),
  }, rest);
}

/** Shared deterministic fixture for focused deriveDashboardObservability tests. */
function observabilityFixture() {
  const claudio = makeAgent({ id: "agent-claudio", name: "Claudio" });
  const reviewer = makeAgent({ id: "agent-reviewer", name: "Revisor PR" });

  const issues = [
    makeIssue({
      id: "1",
      title: "Executor work",
      status: "in_progress",
      assigneeAgentId: claudio.id,
      updatedAt: new Date("2026-03-31T09:00:00.000Z"),
    }),
    makeIssue({
      id: "2",
      title: "Queued review",
      status: "handoff_ready",
      assigneeAgentId: reviewer.id,
      updatedAt: new Date("2026-03-30T09:00:00.000Z"),
    }),
    makeIssue({
      id: "3",
      title: "Blocked work",
      status: "blocked",
      assigneeAgentId: null,
      updatedAt: new Date("2026-03-29T09:00:00.000Z"),
    }),
    makeIssue({
      id: "4",
      title: "Adapter health alert",
      status: "todo",
      assigneeAgentId: null,
      originKind: "agent_health_alert",
      originId: `agent:${claudio.id}:health:environment_missing_cli`,
      updatedAt: new Date("2026-03-31T08:00:00.000Z"),
    }),
    makeIssue({
      id: "5",
      title: "Closed item",
      status: "done",
    }),
  ];

  const runs = [
    makeRun({
      id: "run-success",
      agentId: claudio.id,
      status: "succeeded",
      createdAt: new Date("2026-03-31T11:00:00.000Z"),
      finishedAt: new Date("2026-03-31T11:05:00.000Z"),
      operationalEffect: {
        producedEffect: true,
        activityCount: 1,
        actions: ["issue.comment"],
        signals: [],
        summary: "Updated issue",
        counts: {
          comments: 1,
          statusChanges: 0,
          handoffs: 0,
          assignmentChanges: 0,
          checkouts: 0,
          documents: 0,
          workProducts: 0,
          approvals: 0,
          attachments: 0,
          issueCreations: 0,
          releases: 0,
          otherMutations: 0,
        },
      },
    }),
    makeRun({
      id: "run-failed",
      agentId: reviewer.id,
      status: "failed",
      createdAt: new Date("2026-03-31T10:30:00.000Z"),
      finishedAt: new Date("2026-03-31T10:31:00.000Z"),
      error: "adapter crashed",
    }),
  ];

  const activity = [
    makeActivityEvent({
      id: "evt-review-dedup",
      action: "issue.review_dispatch_reused",
      entityType: "issue",
      entityId: "2",
      details: {
        duplicatePrevented: true,
        dedupReason: "same_head_sha",
      },
      createdAt: new Date("2026-03-31T11:30:00.000Z"),
    }),
    makeActivityEvent({
      id: "evt-health-suppressed",
      action: "issue.health_alert_reopen_suppressed",
      entityType: "issue",
      entityId: "4",
      details: {
        originId: `agent:${claudio.id}:health:environment_missing_cli`,
      },
      createdAt: new Date("2026-03-31T11:40:00.000Z"),
    }),
    makeActivityEvent({
      id: "evt-old",
      action: "issue.review_dispatch_reused",
      entityType: "issue",
      entityId: "2",
      details: {
        duplicatePrevented: true,
      },
      createdAt: new Date("2026-03-29T11:40:00.000Z"),
    }),
  ];

  return {
    claudio,
    reviewer,
    agents: [claudio, reviewer] as Agent[],
    issues,
    runs,
    activity,
  };
}

describe("deriveDashboardObservability", () => {
  it("returns sensible defaults for empty inputs", () => {
    const data = deriveDashboardObservability({
      agents: [],
      issues: [],
      runs: [],
      activity: [],
      now: NOW,
    });

    expect(data.summary).toEqual({
      openCount: 0,
      wipCount: 0,
      technicalQueueCount: 0,
      staleOver24hCount: 0,
      adapterAlertCount: 0,
      duplicateReviewPreventionCount24h: 0,
      healthAlertReopenSuppressedCount24h: 0,
      reviewDispatchNoopCount24h: 0,
      mergeDelegateWakeupFailedCount24h: 0,
    });
    expect(data.visibleStatuses).toEqual([]);
    expect(data.agentRows).toEqual([]);
    expect(data.technicalQueue).toEqual([]);
    expect(data.openIssuesByUpdateTime).toEqual([]);
    expect(data.adapterAlerts).toEqual([]);
  });

  it("summary counts open, WIP, technical queue, staleness, adapter alerts, and 24h activity windows", () => {
    const { agents, issues, runs, activity } = observabilityFixture();
    const data = deriveDashboardObservability({ agents, issues, runs, activity, now: NOW });

    expect(data.summary).toEqual({
      openCount: 4,
      wipCount: 2,
      technicalQueueCount: 1,
      staleOver24hCount: 2,
      adapterAlertCount: 1,
      duplicateReviewPreventionCount24h: 1,
      healthAlertReopenSuppressedCount24h: 1,
      reviewDispatchNoopCount24h: 0,
      mergeDelegateWakeupFailedCount24h: 0,
    });
  });

  it("technical queue selects handoff/review lane issues ordered by updatedAt ascending", () => {
    const { agents, issues, runs, activity } = observabilityFixture();
    const data = deriveDashboardObservability({ agents, issues, runs, activity, now: NOW });

    expect(data.technicalQueue.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("open issues by update time lists all open issues oldest-first", () => {
    const { agents, issues, runs, activity } = observabilityFixture();
    const data = deriveDashboardObservability({ agents, issues, runs, activity, now: NOW });

    expect(data.openIssuesByUpdateTime.map((issue) => issue.id)).toEqual(["3", "2", "4", "1"]);
  });

  it("builds agent rows with visible statuses, Unassigned bucket, adapter alerts, and latest failure run", () => {
    const { agents, issues, runs, activity, claudio, reviewer } = observabilityFixture();
    const data = deriveDashboardObservability({ agents, issues, runs, activity, now: NOW });

    expect(data.visibleStatuses).toEqual(["todo", "in_progress", "handoff_ready", "blocked"]);

    expect(data.agentRows.map((row) => row.agentName)).toEqual(["Claudio", "Revisor PR", "Unassigned"]);
    const claudioRow = data.agentRows.find((row) => row.agentId === claudio.id);
    const reviewerRow = data.agentRows.find((row) => row.agentId === reviewer.id);
    const unassignedRow = data.agentRows.find((row) => row.agentId === null);

    expect(claudioRow).toMatchObject({
      agentName: "Claudio",
      totalOpen: 1,
      wipCount: 1,
      lastUsefulHeartbeatAt: new Date("2026-03-31T11:05:00.000Z"),
    });
    expect(claudioRow?.adapterAlerts.map((issue) => issue.id)).toEqual(["4"]);
    expect(reviewerRow?.latestFailureRun?.id).toBe("run-failed");
    expect(unassignedRow).toMatchObject({
      agentName: "Unassigned",
      totalOpen: 2,
      wipCount: 0,
    });
  });

  it("prefers latest failure without operational effect when recent failed runs still produced mutations", () => {
    const { agents, issues, runs, activity, reviewer } = observabilityFixture();
    const withMixedFailures = [
      makeRun({
        id: "run-failed-with-effect",
        agentId: reviewer.id,
        status: "failed",
        createdAt: new Date("2026-03-31T11:10:00.000Z"),
        finishedAt: new Date("2026-03-31T11:11:00.000Z"),
        operationalEffect: {
          producedEffect: true,
          activityCount: 2,
          actions: ["issue.checked_out", "issue.updated"],
          signals: ["checkouts", "statusChanges"],
          summary: "1 status change, 1 checkout",
          counts: {
            comments: 0,
            statusChanges: 1,
            handoffs: 0,
            assignmentChanges: 0,
            checkouts: 1,
            documents: 0,
            workProducts: 0,
            approvals: 0,
            attachments: 0,
            issueCreations: 0,
            releases: 0,
            otherMutations: 0,
          },
        },
      }),
      ...runs,
    ];
    const data = deriveDashboardObservability({ agents, issues, runs: withMixedFailures, activity, now: NOW });
    const reviewerRow = data.agentRows.find((row) => row.agentId === reviewer.id);
    expect(reviewerRow?.latestFailureRun?.id).toBe("run-failed");
  });
});
