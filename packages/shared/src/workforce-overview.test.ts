import { describe, expect, it } from "vitest";
import {
  projectWorkforceOverview,
  retainWorkforceSnapshot,
  workforceConnection,
  type WorkforceAgentInput,
  type WorkforceIssueInput,
  type WorkforceOverviewSnapshot,
} from "./workforce-overview.js";

const NOW = "2026-09-29T09:40:00.000Z";

function issue(overrides: Partial<WorkforceIssueInput> & Pick<WorkforceIssueInput, "id" | "status">): WorkforceIssueInput {
  return {
    identifier: null,
    title: overrides.id,
    projectId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    priority: "medium",
    checkoutRunId: null,
    executionRunId: null,
    currentStageType: null,
    lastDecisionOutcome: null,
    executionParticipantUserId: null,
    unblockAction: null,
    unblockOwnerUserId: null,
    unblockOwnerBoard: false,
    completedAt: null,
    updatedAt: NOW,
    monitorNextCheckAt: null,
    labelNames: [],
    ...overrides,
  };
}

function idleAgent(id: string): WorkforceAgentInput {
  return {
    id,
    name: id,
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: null,
    adapterType: "process",
    model: null,
    environmentId: null,
    host: null,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    lastHeartbeatAt: null,
  };
}

function snapshot(overrides: Partial<WorkforceOverviewSnapshot> = {}): WorkforceOverviewSnapshot {
  return {
    companyId: "company-1",
    now: NOW,
    truncated: false,
    initiativeQuery: null,
    agents: [],
    projects: [],
    issues: [],
    blockerEdges: [],
    approvals: [],
    runs: [],
    activity: [],
    workProducts: [],
    members: [],
    environments: [],
    ...overrides,
  };
}

describe("projectWorkforceOverview", () => {
  it("keeps a paused Vulcan out of executing even with an in-progress task and a running run", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        agents: [
          {
            id: "xo",
            name: "XO",
            role: "ceo",
            title: "XO",
            status: "idle",
            reportsTo: null,
            adapterType: "cursor",
            model: "composer-2",
            environmentId: null,
            host: null,
            pauseReason: null,
            pausedAt: null,
            errorReason: null,
            lastHeartbeatAt: NOW,
          },
          {
            id: "vulcan",
            name: "Vulcan",
            role: "engineer",
            title: "Engineer",
            status: "paused",
            reportsTo: "xo",
            adapterType: "cursor",
            model: "grok-4.7",
            environmentId: "env-1",
            host: null,
            pauseReason: "manual",
            pausedAt: NOW,
            errorReason: null,
            lastHeartbeatAt: "2026-09-29T08:00:00.000Z",
          },
        ],
        environments: [{ id: "env-1", name: "vulcan-host" }],
        issues: [
          {
            id: "issue-1",
            identifier: "TYR-10",
            title: "Keep shipping",
            status: "in_progress",
            projectId: "project-1",
            parentId: null,
            assigneeAgentId: "vulcan",
            assigneeUserId: null,
            priority: "high",
            checkoutRunId: "run-1",
            executionRunId: "run-1",
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
        ],
        runs: [
          {
            id: "run-1",
            agentId: "vulcan",
            issueId: "issue-1",
            status: "running",
            error: null,
            errorCode: null,
            livenessReason: null,
            nextAction: null,
            scheduledRetryReason: null,
            startedAt: NOW,
            finishedAt: null,
            updatedAt: NOW,
            createdAt: NOW,
          },
        ],
      }),
    );

    expect(overview.counts.executingAgents.value).toBe(0);
    expect(overview.counts.pausedAgents.value).toBe(1);
    const vulcan = overview.agents.find((agent) => agent.name === "Vulcan");
    expect(vulcan?.disposition).toBe("paused");
    expect(vulcan?.dispositionLabel).toBe("Paused");
    expect(vulcan?.outcomeNote).toMatch(/Paused/);
    expect(vulcan?.host).toBe("vulcan-host");
    expect(vulcan?.model).toBe("grok-4.7");
    expect(vulcan?.reporting.some((hop) => hop.xo && hop.name === "XO")).toBe(true);
    expect(vulcan?.taskStatus).toBe("In progress");
    expect(vulcan?.runStatus).toBe("running");
    expect(overview.readOnly).toBe(true);
  });

  it("treats a running status with a pause reason as paused", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        agents: [
          {
            id: "vulcan",
            name: "Vulcan",
            role: "engineer",
            title: null,
            status: "running",
            reportsTo: null,
            adapterType: "process",
            model: null,
            environmentId: null,
            host: null,
            pauseReason: "budget",
            pausedAt: NOW,
            errorReason: null,
            lastHeartbeatAt: null,
          },
        ],
      }),
    );
    expect(overview.counts.executingAgents.value).toBe(0);
    expect(overview.agents[0]?.dispositionLabel).toBe("Paused");
    expect(overview.agents[0]?.reasons).toContain("Paused: budget");
  });

  it("does not invent project progress percentages", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        projects: [
          {
            id: "project-1",
            name: "Launch",
            status: "in_progress",
            leadAgentId: null,
            pauseReason: null,
            pausedAt: null,
            archivedAt: null,
            updatedAt: NOW,
          },
        ],
      }),
    );
    const card = overview.projects[0]!;
    expect(card.stage).toBe("In progress");
    expect(card).not.toHaveProperty("percent");
    expect(card).not.toHaveProperty("progress");
    expect(Object.keys(card).join(" ")).not.toMatch(/percent|progress/i);
    expect(JSON.stringify(card)).not.toMatch(/\d+%/);
    expect(card.lastAcceptedOutput).toBe("None recorded");
    expect(card.nextAction).toBe("Not recorded");
  });

  it("labels security blockers and excludes paused assignees from waiting eligible", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        agents: [
          {
            id: "sec",
            name: "Shield",
            role: "security",
            title: null,
            status: "idle",
            reportsTo: null,
            adapterType: "process",
            model: null,
            environmentId: null,
            host: null,
            pauseReason: null,
            pausedAt: null,
            errorReason: null,
            lastHeartbeatAt: null,
          },
          {
            id: "vulcan",
            name: "Vulcan",
            role: "engineer",
            title: null,
            status: "paused",
            reportsTo: null,
            adapterType: "process",
            model: null,
            environmentId: null,
            host: null,
            pauseReason: "manual",
            pausedAt: NOW,
            errorReason: null,
            lastHeartbeatAt: null,
          },
          {
            id: "ready",
            name: "Ready",
            role: "engineer",
            title: null,
            status: "idle",
            reportsTo: null,
            adapterType: "process",
            model: null,
            environmentId: null,
            host: null,
            pauseReason: null,
            pausedAt: null,
            errorReason: null,
            lastHeartbeatAt: null,
          },
        ],
        issues: [
          {
            id: "sec-issue",
            identifier: "TYR-2",
            title: "Rotate credentials",
            status: "blocked",
            projectId: null,
            parentId: null,
            assigneeAgentId: "sec",
            assigneeUserId: null,
            priority: "critical",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: "Board confirms the rotation window",
            unblockOwnerUserId: null,
            unblockOwnerBoard: true,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: ["Security"],
          },
          {
            id: "paused-todo",
            identifier: "TYR-3",
            title: "Paused assignee",
            status: "todo",
            projectId: null,
            parentId: null,
            assigneeAgentId: "vulcan",
            assigneeUserId: null,
            priority: "medium",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
          {
            id: "ready-todo",
            identifier: "TYR-4",
            title: "Ready work",
            status: "todo",
            projectId: null,
            parentId: null,
            assigneeAgentId: "ready",
            assigneeUserId: null,
            priority: "medium",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
        ],
      }),
    );

    expect(overview.counts.waitingEligible.value).toBe(1);
    expect(overview.counts.blocked.value).toBe(1);
    expect(overview.counts.security.value).toBe(1);
    expect(overview.counts.security.label).toBe("Security");
    expect(overview.blockers[0]?.security).toBe(true);
    expect(overview.blockers[0]?.releaseCondition).toBe("Board confirms the rotation window");
  });

  it("attributes board approvals to Marc only when a member named Marc exists", () => {
    const approval = {
      id: "approval-1",
      type: "hire_agent",
      status: "pending",
      title: "Hire a researcher",
      security: false,
      createdAt: NOW,
    };
    const withoutMarc = projectWorkforceOverview(snapshot({ approvals: [approval] }));
    expect(withoutMarc.counts.marcDecisions.value).toBe(0);
    expect(withoutMarc.counts.marcDecisions.attribution).toBe("none");
    expect(withoutMarc.decisions[0]?.marc).toBe(false);
    expect(withoutMarc.decisions[0]?.owner).toBe("Board");

    const withMarc = projectWorkforceOverview(
      snapshot({
        members: [{ userId: "user-marc", name: "Marc" }],
        approvals: [approval],
      }),
    );
    expect(withMarc.counts.marcDecisions.value).toBe(1);
    expect(withMarc.counts.marcDecisions.attribution).toBe("member");
    expect(withMarc.decisions[0]?.owner).toBe("Marc");
  });

  it("labels timeline events that have no run or actor as unknown provenance", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        initiativeQuery: "TYR-721",
        issues: [
          {
            id: "init",
            identifier: "TYR-721",
            title: "Live workforce",
            status: "in_progress",
            projectId: null,
            parentId: null,
            assigneeAgentId: null,
            assigneeUserId: null,
            priority: "high",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
          {
            id: "child",
            identifier: "TYR-722",
            title: "Build the page",
            status: "todo",
            projectId: null,
            parentId: "init",
            assigneeAgentId: null,
            assigneeUserId: null,
            priority: "medium",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: null,
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
        ],
        activity: [
          {
            id: "act-unknown",
            actorType: "system",
            actorId: "system",
            action: "issue.updated",
            entityType: "issue",
            entityId: "child",
            agentId: null,
            runId: null,
            createdAt: NOW,
            summary: null,
            mentionedAssignee: null,
          },
          {
            id: "act-run",
            actorType: "agent",
            actorId: "agent-1",
            action: "issue.commented",
            entityType: "issue",
            entityId: "init",
            agentId: "agent-1",
            runId: "run-9",
            createdAt: "2026-09-29T09:00:00.000Z",
            summary: "Posted the plan",
            mentionedAssignee: null,
          },
        ],
      }),
    );

    expect(overview.timeline).toHaveLength(2);
    expect(overview.timeline.every((entry) => entry.evidence === "activity_log")).toBe(true);
    const unknown = overview.timeline.find((entry) => entry.id === "act-unknown");
    expect(unknown?.provenance).toBe("unknown");
    expect(unknown?.provenanceLabel).toBe("Unknown provenance");
    expect(overview.timeline.find((entry) => entry.id === "act-run")?.provenance).toBe("run");
  });

  it("keeps deliverable links evidence-backed", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        issues: [
          {
            id: "issue-1",
            identifier: "TYR-8",
            title: "Deliver",
            status: "done",
            projectId: null,
            parentId: null,
            assigneeAgentId: null,
            assigneeUserId: null,
            priority: "medium",
            checkoutRunId: null,
            executionRunId: null,
            currentStageType: null,
            lastDecisionOutcome: null,
            executionParticipantUserId: null,
            unblockAction: null,
            unblockOwnerUserId: null,
            unblockOwnerBoard: false,
            completedAt: "2026-09-29T09:00:00.000Z",
            updatedAt: NOW,
            monitorNextCheckAt: null,
            labelNames: [],
          },
        ],
        workProducts: [
          {
            id: "wp-1",
            issueId: "issue-1",
            projectId: null,
            type: "artifact",
            title: "Preview notes",
            url: null,
            openPath: "/api/companies/company-1/issues/issue-1/attachments/wp-1/content",
            status: "active",
            reviewState: "approved",
            updatedAt: NOW,
          },
          {
            id: "wp-2",
            issueId: "issue-1",
            projectId: null,
            type: "pull_request",
            title: "External PR",
            url: "https://github.com/tyrxtech/paperclip/pull/1",
            openPath: null,
            status: "active",
            reviewState: "none",
            updatedAt: NOW,
          },
          {
            id: "wp-3",
            issueId: "issue-1",
            projectId: null,
            type: "document",
            title: "Missing link",
            url: null,
            openPath: null,
            status: "active",
            reviewState: "none",
            updatedAt: NOW,
          },
        ],
      }),
    );

    const byId = new Map(overview.deliverables.map((item) => [item.id, item]));
    expect(byId.get("wp-1")).toMatchObject({ authenticated: true, href: "/api/companies/company-1/issues/issue-1/attachments/wp-1/content" });
    expect(byId.get("wp-2")).toMatchObject({ authenticated: false, linkLabel: "External link" });
    expect(byId.get("wp-3")?.href).toBeNull();
    expect(byId.get("wp-3")?.linkLabel).toBe("No authenticated link recorded");
    expect(overview.counts.recentlyAccepted.value).toBe(1);
  });

  it("does not invent a timeline when the initiative is missing", () => {
    const overview = projectWorkforceOverview(snapshot({ initiativeQuery: "TYR-404" }));
    expect(overview.timeline).toEqual([]);
    expect(overview.timelineNote).toMatch(/not found/);
  });

  it("defaults the timeline to the most recently updated parent, including a completed one", () => {
    const overview = projectWorkforceOverview(
      snapshot({
        issues: [
          issue({ id: "open-parent", identifier: "TYR-1", status: "in_progress", updatedAt: "2026-09-28T00:00:00.000Z" }),
          issue({ id: "open-child", status: "todo", parentId: "open-parent", updatedAt: "2026-09-28T00:00:00.000Z" }),
          issue({
            id: "done-parent",
            identifier: "TYR-2",
            status: "done",
            updatedAt: "2026-09-29T09:00:00.000Z",
            completedAt: "2026-09-29T09:00:00.000Z",
          }),
          issue({
            id: "done-child",
            status: "done",
            parentId: "done-parent",
            updatedAt: "2026-09-29T09:00:00.000Z",
            completedAt: "2026-09-29T09:00:00.000Z",
          }),
        ],
      }),
    );

    expect(overview.selectedInitiativeId).toBe("done-parent");
    expect(overview.initiatives[0]?.identifier).toBe("TYR-2");
  });

  it("does not count a todo as waiting eligible when a blocker is cancelled or missing", () => {
    const ready = idleAgent("ready");
    const overview = projectWorkforceOverview(
      snapshot({
        agents: [ready],
        issues: [
          issue({ id: "missing-block", status: "todo", assigneeAgentId: "ready" }),
          issue({ id: "cancelled-block", status: "todo", assigneeAgentId: "ready" }),
          issue({ id: "cancelled-blocker", identifier: "TYR-9", status: "cancelled" }),
          issue({ id: "clear", status: "todo", assigneeAgentId: "ready" }),
          issue({ id: "done-block", status: "todo", assigneeAgentId: "ready" }),
          issue({ id: "done-blocker", identifier: "TYR-8", status: "done", completedAt: NOW }),
        ],
        blockerEdges: [
          { blockerIssueId: "not-loaded", blockedIssueId: "missing-block" },
          { blockerIssueId: "cancelled-blocker", blockedIssueId: "cancelled-block" },
          { blockerIssueId: "done-blocker", blockedIssueId: "done-block" },
        ],
      }),
    );

    expect(overview.counts.waitingEligible.value).toBe(2);
  });
});

describe("workforce refresh state", () => {
  it("keeps the last snapshot when a refresh fails", () => {
    const overview = projectWorkforceOverview(snapshot());
    expect(retainWorkforceSnapshot(overview, { ok: false })).toBe(overview);
    expect(retainWorkforceSnapshot(null, { ok: false })).toBeNull();
  });

  it("does not report a disconnected or stale snapshot as live zeros", () => {
    const disconnected = workforceConnection({
      hasSnapshot: true,
      lastSuccessAt: "2026-09-29T09:00:00.000Z",
      now: NOW,
      lastFetchFailed: true,
      visible: true,
    });
    expect(disconnected.connection).toBe("disconnected");

    const stale = workforceConnection({
      hasSnapshot: true,
      lastSuccessAt: "2026-09-29T09:00:00.000Z",
      now: NOW,
      lastFetchFailed: false,
      visible: true,
    });
    expect(stale.connection).toBe("stale");

    const hidden = workforceConnection({
      hasSnapshot: true,
      lastSuccessAt: NOW,
      now: NOW,
      lastFetchFailed: false,
      visible: false,
    });
    expect(hidden.connection).toBe("stale");

    const live = workforceConnection({
      hasSnapshot: true,
      lastSuccessAt: NOW,
      now: "2026-09-29T09:40:10.000Z",
      lastFetchFailed: false,
      visible: true,
    });
    expect(live.connection).toBe("live");
  });
});
