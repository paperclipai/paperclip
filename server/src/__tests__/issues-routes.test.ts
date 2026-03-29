import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  createLabel: vi.fn(),
  getLabelById: vi.fn(),
  deleteLabel: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  issueApprovalService: () => mockIssueApprovalService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  workProductService: () => mockWorkProductService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../attachment-types.js", () => ({
  isAllowedContentType: () => true,
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
}));

vi.mock("./issues-checkout-wakeup.js", () => ({
  shouldWakeAssigneeOnCheckout: vi.fn().mockReturnValue(false),
}));

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const OTHER_COMPANY_ACTOR = {
  type: "board",
  userId: "user-2",
  companyIds: ["company-other"],
  source: "session",
  isInstanceAdmin: false,
};

const mockStorage = {
  upload: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
};

function createApp(actor: any = BOARD_ACTOR) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorage as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
    title: "Test Issue",
    description: "Test description",
    status: "open",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "user-1",
    createdByAgentId: null,
    projectId: null,
    goalId: null,
    parentId: null,
    hiddenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("issues routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({});
    mockWorkProductService.listForIssue.mockResolvedValue([]);
  });

  describe("GET /api/companies/:companyId/issues", () => {
    it("returns issues list for authorized company", async () => {
      const issues = [makeIssue(), makeIssue({ id: "issue-2", identifier: "PAP-2" })];
      mockIssueService.list.mockResolvedValue(issues);

      const res = await request(createApp()).get("/api/companies/company-1/issues");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.any(Object));
    });

    it("passes filter params through to the service", async () => {
      mockIssueService.list.mockResolvedValue([]);

      const res = await request(createApp()).get(
        "/api/companies/company-1/issues?status=open&assigneeAgentId=agent-1",
      );

      expect(res.status).toBe(200);
      expect(mockIssueService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          status: "open",
          assigneeAgentId: "agent-1",
        }),
      );
    });

    it("rejects access for user not in company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/companies/company-1/issues",
      );

      expect(res.status).toBe(403);
    });

    it("returns 400 for missing companyId", async () => {
      const res = await request(createApp()).get("/api/issues");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing companyId");
    });
  });

  describe("POST /api/companies/:companyId/issues", () => {
    it("creates a new issue", async () => {
      const created = makeIssue();
      mockIssueService.create.mockResolvedValue(created);

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "Test Issue" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("issue-1");
      expect(mockIssueService.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          title: "Test Issue",
          createdByUserId: "user-1",
        }),
      );
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("wakes assignee agent on creation with assignment", async () => {
      const agentUuid = "a0000000-0000-1000-8000-000000000099";
      const created = makeIssue({
        assigneeAgentId: agentUuid,
        status: "open",
      });
      mockIssueService.create.mockResolvedValue(created);
      mockAccessService.canUser.mockResolvedValue(true);
      mockHeartbeatService.wakeup.mockResolvedValue(undefined);

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "New Task", assigneeAgentId: agentUuid });

      expect(res.status).toBe(201);
      // wakeup is called via void (fire-and-forget), but it should be called
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        agentUuid,
        expect.objectContaining({ source: "assignment" }),
      );
    });

    it("rejects creation for user not in company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR))
        .post("/api/companies/company-1/issues")
        .send({ title: "Sneaky issue" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/issues/:id", () => {
    it("returns issue with ancestors and project details", async () => {
      const issue = makeIssue({ projectId: "proj-1" });
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.getAncestors.mockResolvedValue([]);
      mockProjectService.getById.mockResolvedValue({ id: "proj-1", name: "Project" });
      mockProjectService.listByIds.mockResolvedValue([]);

      const res = await request(createApp()).get("/api/issues/issue-1");

      expect(res.status).toBe(200);
      expect(mockIssueService.getById).toHaveBeenCalledWith("issue-1");
    });

    it("returns 404 for non-existent issue", async () => {
      mockIssueService.getById.mockResolvedValue(null);

      const res = await request(createApp()).get("/api/issues/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Issue not found");
    });

    it("rejects access for user not in issue's company", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());

      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/issues/issue-1",
      );

      expect(res.status).toBe(403);
    });

    it("resolves identifier-style IDs (e.g. PAP-1)", async () => {
      const issue = makeIssue();
      mockIssueService.getByIdentifier.mockResolvedValue(issue);
      mockIssueService.getById.mockResolvedValue(issue);
      mockProjectService.listByIds.mockResolvedValue([]);

      const res = await request(createApp()).get("/api/issues/PAP-1");

      expect(res.status).toBe(200);
      expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-1");
    });
  });

  describe("PATCH /api/issues/:id", () => {
    it("updates issue status", async () => {
      const existing = makeIssue();
      const updated = makeIssue({ status: "done" });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/issues/issue-1")
        .send({ status: "done" });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ status: "done" }),
      );
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 for non-existent issue", async () => {
      mockIssueService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/issues/nonexistent")
        .send({ status: "done" });

      expect(res.status).toBe(404);
    });

    it("rejects update from user not in issue's company", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue());

      const res = await request(createApp(OTHER_COMPANY_ACTOR))
        .patch("/api/issues/issue-1")
        .send({ status: "done" });

      expect(res.status).toBe(403);
    });
  });

  describe("company isolation", () => {
    it("cannot list issues from another company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/companies/company-1/issues",
      );

      expect(res.status).toBe(403);
      expect(mockIssueService.list).not.toHaveBeenCalled();
    });

    it("cannot get single issue from another company", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ companyId: "company-1" }),
      );

      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        "/api/issues/issue-1",
      );

      expect(res.status).toBe(403);
    });

    it("cannot create issue in another company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR))
        .post("/api/companies/company-1/issues")
        .send({ title: "Intruder issue" });

      expect(res.status).toBe(403);
      expect(mockIssueService.create).not.toHaveBeenCalled();
    });
  });
});
