import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const DEPT_ENG_LABEL_ID = "d0000000-0000-4000-8000-000000000001";
const DEPT_QA_LABEL_ID = "d0000000-0000-4000-8000-000000000002";
const NON_DEPT_LABEL_ID = "d0000000-0000-4000-8000-000000000099";

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
      permissions: { canCreateAgents: false },
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
  identifier: "PAP-500",
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
  labels: [{ id: DEPT_ENG_LABEL_ID, companyId: "company-1", name: "dept:engineering", color: "#3B82F6", createdAt: new Date(), updatedAt: new Date() }],
  labelIds: [DEPT_ENG_LABEL_ID],
  hiddenAt: null,
  updatedAt: new Date("2026-04-10T12:00:00Z"),
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

describe("department label gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countRecentByAgent.mockResolvedValue(0);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(
      new Set([DEPT_ENG_LABEL_ID, DEPT_QA_LABEL_ID]),
    );
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
  });

  it("agent creating issue without dept label → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Missing dept label", issueType: "initiative" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("department_label_required");
    expect(res.body.error).toBe("department_label_required");
    expect(res.body.availableDeptLabelIds).toEqual(
      expect.arrayContaining([DEPT_ENG_LABEL_ID, DEPT_QA_LABEL_ID]),
    );
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("agent creating issue with non-dept label only → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Wrong label type", issueType: "initiative", labelIds: [NON_DEPT_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("department_label_required");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("agent creating issue with one dept label → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Good issue", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("agent creating issue with dept label + other label → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Mixed labels", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID, NON_DEPT_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("agent creating issue with multiple dept labels → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Two depts", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID, DEPT_QA_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("department_label_required");
    expect(res.body.error).toBe("multiple_department_labels");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("board user creating issue without dept label → 201 (bypass)", async () => {
    mockIssueService.create.mockResolvedValue({
      ...createdIssue,
      labels: [],
      labelIds: [],
    });

    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Board bypass", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.getDepartmentLabelIds).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("logs activity when agent is blocked by gate", async () => {
    const app = createAgentApp();
    await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "No dept label", issueType: "initiative" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.department_label_gate_blocked",
        agentId: "agent-1",
      }),
    );
  });
});

describe("department-wide dedup gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countRecentByAgent.mockResolvedValue(0);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(
      new Set([DEPT_ENG_LABEL_ID, DEPT_QA_LABEL_ID]),
    );
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
  });

  it("blocks agent when similar title exists in same department → 409", async () => {
    mockIssueService.findDepartmentDuplicate.mockResolvedValue({
      id: "existing-issue-id",
      identifier: "PAP-100",
      title: "Write blog post about cold calling",
    });

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Draft blog post on cold calling", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(409);
    expect(res.body.gate).toBe("department_dedup_blocker");
    expect(res.body.existingIdentifier).toBe("PAP-100");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows creation when no department duplicate exists → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Completely unique task", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.findDepartmentDuplicate).toHaveBeenCalledWith(
      "company-1",
      DEPT_ENG_LABEL_ID,
      "Completely unique task",
    );
  });

  it("logs activity when department dedup blocks", async () => {
    mockIssueService.findDepartmentDuplicate.mockResolvedValue({
      id: "existing-id",
      identifier: "PAP-200",
      title: "Existing task",
    });

    const app = createAgentApp();
    await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Existing task again", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.department_dedup_blocked",
        agentId: "agent-1",
      }),
    );
  });

  it("board user bypasses department dedup → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue);

    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Board can create duplicates", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.findDepartmentDuplicate).not.toHaveBeenCalled();
  });
});
