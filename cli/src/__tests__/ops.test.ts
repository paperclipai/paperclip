import { describe, expect, it } from "vitest";
import type { Agent, Company, DashboardSummary, Issue, Project } from "@paperclipai/shared";
import { buildOpsSummary, renderOpsSummary } from "../commands/client/ops.js";

const company: Company = {
  id: "company-1",
  name: "Rainwater",
  description: null,
  status: "active",
  issuePrefix: "RAI",
  issueCounter: 12,
  budgetMonthlyCents: 50000,
  spentMonthlyCents: 4900,
  requireBoardApprovalForNewAgents: false,
  brandColor: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const dashboard: DashboardSummary = {
  companyId: "company-1",
  agents: {
    active: 1,
    running: 1,
    paused: 0,
    error: 0,
  },
  tasks: {
    open: 2,
    inProgress: 1,
    blocked: 1,
    done: 4,
  },
  costs: {
    monthSpendCents: 4900,
    monthBudgetCents: 50000,
    monthUtilizationPercent: 9.8,
  },
  pendingApprovals: 1,
  staleTasks: 2,
};

const projects: Project[] = [
  {
    id: "project-1",
    companyId: "company-1",
    urlKey: "core-foundation",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Core Foundation",
    description: null,
    status: "in_progress",
    leadAgentId: "agent-1",
    targetDate: null,
    color: null,
    executionWorkspacePolicy: null,
    workspaces: [],
    primaryWorkspace: {
      id: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      name: "rainwater",
      cwd: "/Users/example/rainwater",
      repoUrl: null,
      repoRef: null,
      metadata: null,
      isPrimary: true,
      runtimeServices: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "project-2",
    companyId: "company-1",
    urlKey: "ops-cadence",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Ops Cadence",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: null,
    executionWorkspacePolicy: null,
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const agents: Agent[] = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "openclaw_gateway",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 25000,
    spentMonthlyCents: 4900,
    permissions: { canCreateAgents: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Ops",
    urlKey: "ops",
    role: "cto",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 0,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const issues: Issue[] = [
  {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    goalId: null,
    parentId: null,
    title: "Ship operator summary",
    description: null,
    status: "blocked",
    priority: "critical",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 7,
    identifier: "RAI-7",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    project: projects[0],
    goal: null,
    mentionedProjects: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "issue-2",
    companyId: "company-1",
    projectId: "project-2",
    goalId: null,
    parentId: null,
    title: "Tidy profile switching",
    description: null,
    status: "todo",
    priority: "high",
    assigneeAgentId: "agent-2",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 8,
    identifier: "RAI-8",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    project: projects[1],
    goal: null,
    mentionedProjects: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe("buildOpsSummary", () => {
  it("builds compact counts and focus rows", () => {
    const summary = buildOpsSummary({
      profileName: "rainwater",
      company,
      dashboard,
      projects,
      agents,
      activeIssues: issues,
      limit: 2,
    });

    expect(summary.company.name).toBe("Rainwater");
    expect(summary.projects.total).toBe(2);
    expect(summary.projects.withPrimaryWorkspace).toBe(1);
    expect(summary.projects.byStatus.in_progress).toBe(1);
    expect(summary.projects.byStatus.planned).toBe(1);
    expect(summary.tasks.focus[0]?.identifier).toBe("RAI-7");
    expect(summary.agents.focus[0]?.status).toBe("running");
  });
});

describe("renderOpsSummary", () => {
  it("renders a readable operator summary", () => {
    const summary = buildOpsSummary({
      profileName: "rainwater",
      company,
      dashboard,
      projects,
      agents,
      activeIssues: issues,
      limit: 1,
    });

    const text = renderOpsSummary(summary);
    expect(text).toContain("Company: Rainwater [active] prefix=RAI profile=rainwater");
    expect(text).toContain("Focus projects:");
    expect(text).toContain("core-foundation [in_progress]");
    expect(text).toContain("RAI-7 [critical/blocked]");
    expect(text).toContain("CEO [ceo/running]");
  });
});
