import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";

const mockIssueCreate = vi.fn();

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true },
    })),
  }),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({ getById: vi.fn() }),
  heartbeatService: () => ({}),
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
  issueApprovalService: () => ({}),
  issueService: () => ({
    create: mockIssueCreate,
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  logActivity: vi.fn(),
  projectService: () => ({ getById: vi.fn() }),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  buildIssueWakeContextSnapshot: vi.fn(),
  queueIssueAssignmentWakeup: vi.fn(),
}));

describe("issue routes create path guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueCreate.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "ISS-1",
      title: "Child issue",
      status: "todo",
    });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    return app;
  }

  it("returns a clear error when an agent guesses POST /api/issues", async () => {
    const res = await request(createApp()).post("/api/issues").send({
      title: "Child issue",
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Issue creation requires /api/companies/{companyId}/issues.",
    });
  });

  it("normalizes body into description on company-scoped issue creation", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Child issue",
        body: "Delegate this task to the worker.",
      });

    expect(res.status).toBe(201);
    expect(mockIssueCreate).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Child issue",
      description: "Delegate this task to the worker.",
    }));
  });
});
