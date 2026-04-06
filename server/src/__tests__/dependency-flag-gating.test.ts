import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockGetExperimental = vi.hoisted(() => vi.fn());

const ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "TEST-1",
  title: "Test issue",
  status: "todo",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByUserId: "user-1",
  parentId: null,
  goalId: null,
  projectId: null,
  executionWorkspaceId: null,
  hiddenAt: null,
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn().mockResolvedValue([]),
  getRelationSummaries: vi.fn().mockResolvedValue({ blockedBy: [], blocks: [] }),
  getAncestors: vi.fn().mockResolvedValue([]),
  listWakeableBlockedDependents: vi.fn().mockResolvedValue([]),
  listAttachments: vi.fn().mockResolvedValue([]),
  getCommentCursor: vi.fn().mockResolvedValue(null),
  getComment: vi.fn().mockResolvedValue(null),
  findMentionedProjectIds: vi.fn().mockResolvedValue([]),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn().mockResolvedValue(null),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn().mockResolvedValue(null),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn().mockResolvedValue(null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  instanceSettingsService: () => ({
    getExperimental: mockGetExperimental,
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    listByIds: vi.fn().mockResolvedValue([]),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../services/github-pr-reconcile.js", () => ({
  parseGitHubPrUrl: vi.fn(),
  reconcilePrState: vi.fn(),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function createApp() {
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

// ── Tests ────────────────────────────────────────────────────────────

describe("enableDependencies flag gating on blockedByIssueIds", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockIssueService.getById.mockResolvedValue(ISSUE);
  });

  describe("when enableDependencies is OFF", () => {
    beforeEach(() => {
      mockGetExperimental.mockResolvedValue({
        enableIsolatedWorkspaces: false,
        autoRestartDevServerWhenIdle: false,
        enableDependencies: false,
      });
    });

    it("PATCH /issues/:id with blockedByIssueIds returns 403", async () => {
      const res = await request(app)
        .patch("/api/issues/issue-1")
        .send({ blockedByIssueIds: ["issue-2"], status: "blocked" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dependencies.*not.*enabled/i);
    });

    it("PATCH /issues/:id without blockedByIssueIds proceeds normally", async () => {
      mockIssueService.update.mockResolvedValue({ ...ISSUE, status: "in_progress" });
      const res = await request(app)
        .patch("/api/issues/issue-1")
        .send({ status: "in_progress" });
      expect(res.status).toBe(200);
    });
  });

  describe("when enableDependencies is ON", () => {
    beforeEach(() => {
      mockGetExperimental.mockResolvedValue({
        enableIsolatedWorkspaces: false,
        autoRestartDevServerWhenIdle: false,
        enableDependencies: true,
      });
    });

    it("PATCH /issues/:id with blockedByIssueIds proceeds (not rejected)", async () => {
      mockIssueService.update.mockResolvedValue({ ...ISSUE, status: "blocked" });
      const res = await request(app)
        .patch("/api/issues/issue-1")
        .send({ blockedByIssueIds: ["issue-2"], status: "blocked" });
      // Should not be 403 — the request is allowed when flag is on
      expect(res.status).not.toBe(403);
    });
  });
});
