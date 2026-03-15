import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  companyGetById: vi.fn(),
  agentsList: vi.fn(),
  goalsList: vi.fn(),
  projectsList: vi.fn(),
  issuesList: vi.fn(),
}));

vi.mock("../services/access.js", () => ({
  accessService: vi.fn(() => ({})),
}));

vi.mock("../services/companies.js", () => ({
  companyService: vi.fn(() => ({
    getById: mocks.companyGetById,
  })),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({
    list: mocks.agentsList,
  })),
}));

vi.mock("../services/goals.js", () => ({
  goalService: vi.fn(() => ({
    list: mocks.goalsList,
  })),
}));

vi.mock("../services/projects.js", () => ({
  projectService: vi.fn(() => ({
    list: mocks.projectsList,
  })),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({
    list: mocks.issuesList,
  })),
}));

const { companyPortabilityService } = await import("../services/company-portability.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("company portability export", () => {
  it("exports seeded goals, projects, and issues with stable references", async () => {
    const now = new Date("2026-03-12T10:00:00.000Z");

    mocks.companyGetById.mockResolvedValue({
      id: "company-1",
      name: "Safe Autonomous Organization",
      description: "Governance-first operating company",
      brandColor: "#0f766e",
      requireBoardApprovalForNewAgents: true,
    });
    mocks.agentsList.mockResolvedValue([
      {
        id: "agent-ceo",
        name: "CEO",
        status: "active",
        role: "executive",
        title: "Chief Executive Officer",
        icon: null,
        capabilities: null,
        reportsTo: null,
        adapterType: "process",
        adapterConfig: {
          promptTemplate: "Lead the organization.",
        },
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
        createdAt: now,
      },
      {
        id: "agent-safety",
        name: "Safety Lead",
        status: "active",
        role: "governance",
        title: "Safety Lead",
        icon: null,
        capabilities: null,
        reportsTo: "agent-ceo",
        adapterType: "process",
        adapterConfig: {
          promptTemplate: "Own safety controls.",
        },
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
        createdAt: new Date("2026-03-12T10:05:00.000Z"),
      },
    ]);
    mocks.goalsList.mockResolvedValue([
      {
        id: "goal-1",
        companyId: "company-1",
        title: "Operating Boundary",
        description: "Define bounded authority.",
        level: "company",
        status: "active",
        parentId: null,
        ownerAgentId: "agent-ceo",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "goal-2",
        companyId: "company-1",
        title: "Control Checklist",
        description: "Publish the first control checklist.",
        level: "team",
        status: "planned",
        parentId: "goal-1",
        ownerAgentId: "agent-safety",
        createdAt: new Date("2026-03-12T10:10:00.000Z"),
        updatedAt: now,
      },
    ]);
    mocks.projectsList.mockResolvedValue([
      {
        id: "project-1",
        companyId: "company-1",
        urlKey: "initial-control-framework",
        goalId: "goal-2",
        goalIds: ["goal-1", "goal-2"],
        goals: [
          { id: "goal-1", title: "Operating Boundary" },
          { id: "goal-2", title: "Control Checklist" },
        ],
        name: "Initial Control Framework",
        description: "Translate goals into controls.",
        status: "planned",
        leadAgentId: "agent-safety",
        targetDate: "2026-03-31",
        color: "#0f766e",
        workspaces: [
          {
            id: "workspace-1",
            companyId: "company-1",
            projectId: "project-1",
            name: "Control Docs",
            cwd: "/tmp/control-docs",
            repoUrl: "https://github.com/example/control-docs",
            repoRef: "main",
            metadata: { purpose: "docs" },
            isPrimary: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        primaryWorkspace: null,
        archivedAt: null,
        createdAt: new Date("2026-03-12T10:20:00.000Z"),
        updatedAt: now,
      },
    ]);
    mocks.issuesList.mockResolvedValue([
      {
        id: "issue-1",
        companyId: "company-1",
        projectId: "project-1",
        goalId: "goal-2",
        parentId: null,
        title: "Draft initial safety checklist",
        description: "Produce the first-pass checklist.",
        status: "backlog",
        priority: "high",
        assigneeAgentId: "agent-safety",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        issueNumber: 1,
        identifier: "SAO-1",
        requestDepth: 0,
        billingCode: "safety",
        assigneeAdapterOverrides: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        hiddenAt: null,
        labels: [],
        createdAt: new Date("2026-03-12T10:30:00.000Z"),
        updatedAt: now,
      },
      {
        id: "issue-2",
        companyId: "company-1",
        projectId: "project-1",
        goalId: "goal-2",
        parentId: "issue-1",
        title: "Review checklist with CEO",
        description: "Validate decision boundaries.",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: "agent-ceo",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        issueNumber: 2,
        identifier: "SAO-2",
        requestDepth: 1,
        billingCode: null,
        assigneeAdapterOverrides: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        hiddenAt: null,
        labels: [],
        createdAt: new Date("2026-03-12T10:40:00.000Z"),
        updatedAt: now,
      },
    ]);

    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        goals: true,
        projects: true,
        issues: true,
      },
    });

    expect(exported.warnings).toEqual([]);
    expect(exported.manifest.company).toEqual(expect.objectContaining({
      name: "Safe Autonomous Organization",
      requireBoardApprovalForNewAgents: true,
    }));
    expect(exported.manifest.goals).toEqual([
      expect.objectContaining({
        key: "operating-boundary",
        ownerAgentSlug: "ceo",
        parentKey: null,
      }),
      expect.objectContaining({
        key: "control-checklist",
        ownerAgentSlug: "safety-lead",
        parentKey: "operating-boundary",
      }),
    ]);
    expect(exported.manifest.projects).toEqual([
      expect.objectContaining({
        key: "initial-control-framework",
        goalKeys: ["operating-boundary", "control-checklist"],
        leadAgentSlug: "safety-lead",
        workspaces: [
          expect.objectContaining({
            name: "Control Docs",
            cwd: "/tmp/control-docs",
            repoUrl: "https://github.com/example/control-docs",
          }),
        ],
      }),
    ]);
    expect(exported.manifest.issues).toEqual([
      expect.objectContaining({
        key: "draft-initial-safety-checklist",
        projectKey: "initial-control-framework",
        goalKey: "control-checklist",
        parentKey: null,
        assigneeAgentSlug: "safety-lead",
      }),
      expect.objectContaining({
        key: "review-checklist-with-ceo",
        parentKey: "draft-initial-safety-checklist",
        assigneeAgentSlug: "ceo",
      }),
    ]);
    expect(exported.files["COMPANY.md"]).toContain('name: "Safe Autonomous Organization"');
    expect(exported.files["agents/ceo/AGENTS.md"]).toContain("Lead the organization.");
    expect(exported.files["agents/safety-lead/AGENTS.md"]).toContain("Own safety controls.");
  });
});
