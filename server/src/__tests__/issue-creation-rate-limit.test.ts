import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  hasReachedStatus: vi.fn(),
  countRecentByAgent: vi.fn(),
  getDepartmentLabelIds: vi.fn(),
  findDepartmentDuplicate: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true },
    })),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => ({ contextSnapshot: {} })),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const createdIssue = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "company-1",
  identifier: "PAP-999",
  title: "Test issue",
  description: null,
  status: "backlog",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByAgentId: "agent-1",
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
  hiddenAt: null,
  updatedAt: new Date("2026-04-03T12:00:00Z"),
};

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const DEPT_LABEL_ID = "d0000000-0000-4000-8000-000000000001";

describe("issue creation rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ISSUE_CREATION_RATE_LIMIT;
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(new Set([DEPT_LABEL_ID]));
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.AGENT_ISSUE_CREATION_RATE_LIMIT;
  });

  it("returns 429 when agent exceeds rate limit", async () => {
    mockIssueService.countRecentByAgent.mockResolvedValue(50);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Spam issue", issueType: "initiative" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.gate).toBe("issue_creation_rate_limit");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows creation when under rate limit", async () => {
    mockIssueService.countRecentByAgent.mockResolvedValue(49);
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Test issue", issueType: "initiative", labelIds: [DEPT_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(res.body.identifier).toBe("PAP-999");
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("bypasses rate limit for board users", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Board issue", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.countRecentByAgent).not.toHaveBeenCalled();
  });

  it("respects AGENT_ISSUE_CREATION_RATE_LIMIT env override", async () => {
    process.env.AGENT_ISSUE_CREATION_RATE_LIMIT = "10";
    mockIssueService.countRecentByAgent.mockResolvedValue(9);
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Test issue", issueType: "initiative", labelIds: [DEPT_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("logs rate limit events to activity log", async () => {
    mockIssueService.countRecentByAgent.mockResolvedValue(50);

    const app = createAgentApp();
    await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Spam issue", issueType: "initiative" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.creation_rate_limited",
        details: expect.objectContaining({
          count: 50,
          limit: 50,
          window: "1h",
        }),
      }),
    );
  });
});
