import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  createForIssue: vi.fn(),
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

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Test issue",
  description: null,
  status: "in_progress",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  createdByUserId: null,
  executionWorkspaceId: "ws-1",
  labels: [],
  labelIds: [],
  hiddenAt: null,
  updatedAt: new Date("2026-04-01T12:00:00Z"),
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

describe("work product URL verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(issue);
  });

  describe("agent PR creation", () => {
    it("valid GitHub PR URL → 201", async () => {
      const wp = {
        type: "pull_request",
        provider: "github",
        title: "PR #42",
        url: "https://github.com/Viraforge/paperclip/pull/42",
        externalId: "42",
        status: "active",
      };
      mockWorkProductService.createForIssue.mockResolvedValue({ id: "wp-1", ...wp });

      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send(wp);

      expect(res.status).toBe(201);
    });

    it("missing URL → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "pull_request",
          provider: "github",
          title: "Fake PR",
          externalId: "99",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });

    it("non-GitHub URL → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "pull_request",
          provider: "github",
          title: "Fake PR",
          url: "https://example.com/pull/1",
          externalId: "1",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });

    it("missing externalId → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "pull_request",
          provider: "github",
          title: "PR #1",
          url: "https://github.com/org/repo/pull/1",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });

    it("malformed GitHub URL (missing PR number) → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "pull_request",
          provider: "github",
          title: "Bad PR",
          url: "https://github.com/org/repo/pull/",
          externalId: "1",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });
  });

  describe("agent branch/commit creation", () => {
    it("branch with valid GitHub URL → 201", async () => {
      const wp = {
        type: "branch",
        provider: "github",
        title: "feat/my-branch",
        url: "https://github.com/org/repo/tree/feat-branch",
        status: "active",
      };
      mockWorkProductService.createForIssue.mockResolvedValue({ id: "wp-1", ...wp });

      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send(wp);

      expect(res.status).toBe(201);
    });

    it("branch with invalid URL → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "branch",
          provider: "github",
          title: "feat/my-branch",
          url: "https://example.com/branch",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });

    it("branch without URL → 201 (URL optional for branches)", async () => {
      const wp = {
        type: "branch",
        provider: "github",
        title: "feat/my-branch",
        status: "active",
      };
      mockWorkProductService.createForIssue.mockResolvedValue({ id: "wp-1", ...wp });

      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send(wp);

      expect(res.status).toBe(201);
    });

    it("commit with invalid URL → 422", async () => {
      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send({
          type: "commit",
          provider: "github",
          title: "abc123",
          url: "https://example.com/commit/abc",
          status: "active",
        });

      expect(res.status).toBe(422);
      expect(res.body.gate).toBe("invalid_work_product_url");
    });
  });

  describe("board bypass", () => {
    it("board can create PR without URL → 201", async () => {
      const wp = {
        type: "pull_request",
        provider: "github",
        title: "Manual PR",
        status: "active",
      };
      mockWorkProductService.createForIssue.mockResolvedValue({ id: "wp-1", ...wp });

      const res = await request(createBoardApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send(wp);

      expect(res.status).toBe(201);
    });
  });

  describe("non-code work products", () => {
    it("agent can create document without GitHub URL → 201", async () => {
      const wp = {
        type: "document",
        provider: "paperclip",
        title: "Design doc",
        status: "active",
      };
      mockWorkProductService.createForIssue.mockResolvedValue({ id: "wp-1", ...wp });

      const res = await request(createAgentApp())
        .post(`/api/issues/${issue.id}/work-products`)
        .send(wp);

      expect(res.status).toBe(201);
    });
  });
});
