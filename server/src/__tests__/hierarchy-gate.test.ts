import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const DEPT_ENG_LABEL_ID = "d0000000-0000-4000-8000-000000000001";
const INITIATIVE_ID = "a0000000-0000-4000-8000-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";

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
  getIssueTypeById: vi.fn(),
  getLabelsByIssueId: vi.fn(),
  getActiveChildCount: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => ({
    id: "agent-1",
    companyId: "company-1",
    role: "ceo" as string,
    permissions: { canCreateAgents: false },
  })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  agentService: () => mockAgentService,
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

const createdInitiative = {
  id: INITIATIVE_ID,
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Test Initiative",
  description: null,
  status: "backlog",
  priority: "medium",
  issueType: "initiative",
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

const createdTask = {
  ...createdInitiative,
  id: TASK_ID,
  identifier: "PAP-101",
  title: "Test Task",
  issueType: "task",
  parentId: INITIATIVE_ID,
};

// Minimal db mock for inline queries in the route handler (relay dedup uses db.select directly)
const mockDbQuery = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
};
const mockDb = { select: vi.fn(() => mockDbQuery) } as any;

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
  app.use("/api", issueRoutes(mockDb, {} as any));
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

describe("hierarchy gate — issue creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countRecentByAgent.mockResolvedValue(0);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(new Set([DEPT_ENG_LABEL_ID]));
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
    mockIssueService.getIssueTypeById.mockResolvedValue(null);
    mockIssueService.getLabelsByIssueId.mockResolvedValue([]);
  });

  it("agent creating task without parentId → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Orphan task", issueType: "task", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("task_requires_initiative_parent");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("agent creating initiative with parentId → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Bad initiative", issueType: "initiative", parentId: INITIATIVE_ID, labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_cannot_have_parent");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("agent creating task with parentId pointing to a task → 422", async () => {
    mockIssueService.getIssueTypeById.mockResolvedValue({ id: TASK_ID, issueType: "task", companyId: "company-1" });
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Child of task", issueType: "task", parentId: TASK_ID, labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("parent_must_be_initiative");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("agent creating task with parentId pointing to initiative → 201", async () => {
    mockIssueService.getIssueTypeById.mockResolvedValue({ id: INITIATIVE_ID, issueType: "initiative", companyId: "company-1" });
    mockIssueService.getLabelsByIssueId.mockResolvedValue([{ labelId: DEPT_ENG_LABEL_ID }]);
    mockIssueService.create.mockResolvedValue(createdTask);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Valid task", issueType: "task", parentId: INITIATIVE_ID, labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("agent creating initiative without parentId → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdInitiative);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Valid initiative", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("board user creating task without parentId → 422 (universal enforcement)", async () => {
    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Orphan task from board", issueType: "task" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("task_requires_initiative_parent");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("board user creating initiative → 201", async () => {
    mockIssueService.create.mockResolvedValue(createdInitiative);
    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Board initiative", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("agent creating task with nonexistent parentId → 422", async () => {
    mockIssueService.getIssueTypeById.mockResolvedValue(null);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Task with bad parent", issueType: "task", parentId: "00000000-0000-4000-8000-000000000099", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("parent_not_found");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});

describe("initiative creation hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countRecentByAgent.mockResolvedValue(0);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(new Set([DEPT_ENG_LABEL_ID]));
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue(createdInitiative);
  });

  it("non-leadership agent (engineer) cannot create initiative → 422", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-1", companyId: "company-1", role: "engineer", permissions: {},
    } as any);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Big strategic initiative", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_requires_leadership_role");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("leadership agent (ceo) can create initiative → 201", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-1", companyId: "company-1", role: "ceo", permissions: {},
    } as any);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Company-wide Q2 strategic initiative", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("cto, cmo, cfo, pm all count as leadership", async () => {
    for (const role of ["cto", "cmo", "cfo", "pm"]) {
      mockIssueService.create.mockClear();
      mockAgentService.getById.mockResolvedValueOnce({
        id: "agent-1", companyId: "company-1", role, permissions: {},
      } as any);
      const app = createAgentApp();
      const res = await request(app)
        .post("/api/companies/company-1/issues")
        .send({ title: `Strategic work stream from ${role}`, issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });
      expect(res.status, `role=${role}`).toBe(201);
    }
  });

  it("heuristic: rejects title starting with [DLD-XXXX] pattern → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "[DLD-3079] Remediate AI SEO gaps", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_title_looks_like_task");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("heuristic: rejects [post] prefix → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "[post] how to write good blogs", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_title_looks_like_task");
  });

  it("heuristic: rejects operational verb titles → 422", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Fix validation bug in login form", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_title_looks_like_task");
  });

  it("heuristic: allows proper initiative titles → 201", async () => {
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Customer Onboarding Overhaul Q2", issueType: "initiative", labelIds: [DEPT_ENG_LABEL_ID] });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("board user bypasses role gate and heuristic", async () => {
    const app = createBoardApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "[DLD-3079] Board can still create this", issueType: "initiative" });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});

describe("department consistency gate", () => {
  const DEPT_QA_LABEL_ID = "d0000000-0000-4000-8000-000000000002";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.countRecentByAgent.mockResolvedValue(0);
    mockIssueService.getDepartmentLabelIds.mockResolvedValue(new Set([DEPT_ENG_LABEL_ID, DEPT_QA_LABEL_ID]));
    mockIssueService.findDepartmentDuplicate.mockResolvedValue(null);
    mockIssueService.getIssueTypeById.mockResolvedValue({ id: INITIATIVE_ID, issueType: "initiative", companyId: "company-1" });
  });

  it("task dept label differs from parent initiative dept label → 422", async () => {
    // Parent initiative has dept:engineering
    mockIssueService.getLabelsByIssueId.mockResolvedValue([{ labelId: DEPT_ENG_LABEL_ID }]);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Cross-dept task",
        issueType: "task",
        parentId: INITIATIVE_ID,
        labelIds: [DEPT_QA_LABEL_ID], // QA label on task, but parent is engineering
      });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("department_mismatch");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("task dept label matches parent initiative dept label → 201", async () => {
    mockIssueService.getLabelsByIssueId.mockResolvedValue([{ labelId: DEPT_ENG_LABEL_ID }]);
    mockIssueService.create.mockResolvedValue(createdTask);
    const app = createAgentApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Same-dept task",
        issueType: "task",
        parentId: INITIATIVE_ID,
        labelIds: [DEPT_ENG_LABEL_ID],
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});

describe("initiative deletion guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      ...createdInitiative,
      issueType: "initiative",
      status: "in_progress",
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("cancelling initiative with active children → 422", async () => {
    mockIssueService.getActiveChildCount.mockResolvedValue({ count: 3, identifiers: ["PAP-101", "PAP-102", "PAP-103"] });
    const app = createAgentApp();
    const res = await request(app)
      .patch("/api/issues/" + INITIATIVE_ID)
      .send({ status: "cancelled", comment: "Cancelling initiative" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("initiative_has_active_children");
    expect(res.body.activeChildCount).toBe(3);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("cancelling initiative with all children terminal → allowed", async () => {
    mockIssueService.getActiveChildCount.mockResolvedValue({ count: 0, identifiers: [] });
    mockIssueService.update.mockResolvedValue({ ...createdInitiative, status: "cancelled" });
    const app = createAgentApp();
    const res = await request(app)
      .patch("/api/issues/" + INITIATIVE_ID)
      .send({ status: "cancelled", comment: "All children done" });

    // Should pass the initiative deletion guard (may hit other gates)
    expect(res.status).not.toBe(422);
    // Confirm the guard didn't block it
    expect(res.body.gate).not.toBe("initiative_has_active_children");
  });
});
