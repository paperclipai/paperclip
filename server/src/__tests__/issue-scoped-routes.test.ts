import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  listAttachments: vi.fn(),
  remove: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(async () => ({ companyWide: true, departmentIds: [] })),
}));

const mockScopedAccessService = vi.hoisted(() => ({
  resolveAccessibleDepartmentIds: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDepartmentService = vi.hoisted(() => ({
  listDepartmentIdsForPrincipal: vi.fn(async () => [] as string[]),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/access.js", () => ({
  accessService: () => mockScopedAccessService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  departmentService: () => mockDepartmentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(async () => undefined),
}));

async function createApp() {
  const { issueRoutes } = await import("../routes/issues.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function buildIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    departmentId: null,
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
    createdByAgentId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1",
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: [],
    labels: [],
    blockedBy: [],
    blocks: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("issue scoped mutation routes", () => {
  const engineeringId = "22222222-2222-4222-8222-222222222222";
  const financeId = "33333333-3333-4333-8333-333333333333";
  const projectOneId = "44444444-4444-4444-8444-444444444444";
  const projectTwoId = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    vi.clearAllMocks();
    mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: [engineeringId],
    });
    mockAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
      companyWide: false,
      departmentIds: [engineeringId],
    });
    mockProjectService.getById.mockImplementation(async (projectId: string) => {
      if (projectId === projectOneId) {
        return { id: projectId, companyId: "company-1", departmentId: engineeringId };
      }
      if (projectId === projectTwoId) {
        return { id: projectId, companyId: "company-1", departmentId: financeId };
      }
      return null;
    });
  });

  it("infers the issue department from the selected project on create", async () => {
    mockIssueService.create.mockResolvedValue(buildIssue({ departmentId: engineeringId, projectId: projectOneId }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Scoped issue",
        projectId: projectOneId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        departmentId: engineeringId,
        projectId: projectOneId,
      }),
    );
  }, 15_000);

  it("blocks moving an issue into a department outside the managed scope", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue({
      departmentId: engineeringId,
      projectId: projectOneId,
    }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        projectId: projectTwoId,
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks comment mutations outside the managed department scope", async () => {
    mockIssueService.getById.mockResolvedValue(buildIssue({
      departmentId: financeId,
      projectId: projectTwoId,
    }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Need an update.",
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  describe("tasks:assign department-scoped enforcement", () => {
    const inScopeAgentId = "66666666-6666-4666-8666-666666666666";
    const outOfScopeAgentId = "77777777-7777-4777-8777-777777777777";
    const undepartedAgentId = "88888888-8888-4888-8888-888888888888";
    const inScopeUserId = "user-engineering";

    beforeEach(() => {
      mockDepartmentService.listDepartmentIdsForPrincipal.mockImplementation(
        async (_companyId: string, _principalType: string, principalId: string) => {
          if (principalId === inScopeAgentId) return [engineeringId];
          if (principalId === outOfScopeAgentId) return [financeId];
          if (principalId === undepartedAgentId) return [];
          if (principalId === inScopeUserId) return [engineeringId];
          return [];
        },
      );
    });

    it("allows assignment to an agent inside the actor's tasks:assign scope", async () => {
      mockIssueService.create.mockResolvedValue(
        buildIssue({
          departmentId: engineeringId,
          projectId: projectOneId,
          assigneeAgentId: inScopeAgentId,
        }),
      );

      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({
          title: "Assign to in-scope agent",
          projectId: projectOneId,
          assigneeAgentId: inScopeAgentId,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalled();
    });

    it("blocks assignment to an agent in a different department", async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({
          title: "Assign to out-of-scope agent",
          projectId: projectOneId,
          assigneeAgentId: outOfScopeAgentId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/agent assignee's department/i);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("blocks assignment to an agent without any department for non-company-wide actors", async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({
          title: "Assign to dept-less agent",
          projectId: projectOneId,
          assigneeAgentId: undepartedAgentId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Company-wide tasks:assign/);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });

    it("allows assignment to a user with membership in an in-scope department", async () => {
      mockIssueService.create.mockResolvedValue(
        buildIssue({
          departmentId: engineeringId,
          projectId: projectOneId,
          assigneeUserId: inScopeUserId,
        }),
      );

      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({
          title: "Assign to in-scope user",
          projectId: projectOneId,
          assigneeUserId: inScopeUserId,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("allows company-wide actors to assign to any agent regardless of department", async () => {
      mockScopedAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
        companyWide: true,
        departmentIds: [],
      });
      mockAccessService.resolveAccessibleDepartmentIds.mockResolvedValue({
        companyWide: true,
        departmentIds: [],
      });
      mockIssueService.create.mockResolvedValue(
        buildIssue({
          departmentId: financeId,
          projectId: projectTwoId,
          assigneeAgentId: outOfScopeAgentId,
        }),
      );

      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({
          title: "Company-wide assign",
          projectId: projectTwoId,
          assigneeAgentId: outOfScopeAgentId,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockDepartmentService.listDepartmentIdsForPrincipal).not.toHaveBeenCalled();
    });
  });
});
