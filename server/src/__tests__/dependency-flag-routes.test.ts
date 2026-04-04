import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockGetExperimental = vi.hoisted(() => vi.fn());

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn().mockResolvedValue([]),
}));

const mockDepService = vi.hoisted(() => ({
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  listBlockers: vi.fn().mockResolvedValue([]),
  listDependents: vi.fn().mockResolvedValue([]),
  findDependentsReadyToWake: vi.fn().mockResolvedValue([]),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
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
  issueDependencyService: () => mockDepService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
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

const ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "TEST-1",
  title: "Test issue",
  status: "todo",
  priority: "medium",
};

// ── Tests ────────────────────────────────────────────────────────────

describe("dependency routes — enableDependencies flag gating", () => {
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

    it("GET /api/issues/:id/dependencies returns 403", async () => {
      const res = await request(app).get("/api/issues/issue-1/dependencies");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dependencies.*not.*enabled/i);
    });

    it("POST /api/issues/:id/dependencies returns 403", async () => {
      const res = await request(app)
        .post("/api/issues/issue-1/dependencies")
        .send({ blockerIssueId: "b0000000-0000-0000-0000-000000000002" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dependencies.*not.*enabled/i);
    });

    it("DELETE /api/issues/:id/dependencies/:blockerIssueId returns 403", async () => {
      const res = await request(app).delete("/api/issues/issue-1/dependencies/issue-2");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dependencies.*not.*enabled/i);
    });

    it("GET /api/issues/:id/dependents returns 403", async () => {
      const res = await request(app).get("/api/issues/issue-1/dependents");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/dependencies.*not.*enabled/i);
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

    it("GET /api/issues/:id/dependencies returns 200", async () => {
      mockDepService.listBlockers.mockResolvedValue([]);
      const res = await request(app).get("/api/issues/issue-1/dependencies");
      expect(res.status).toBe(200);
    });

    it("POST /api/issues/:id/dependencies returns 201", async () => {
      mockDepService.addDependency.mockResolvedValue({
        id: "dep-1",
        issueId: "issue-1",
        blockerIssueId: "issue-2",
        companyId: "company-1",
      });
      const res = await request(app)
        .post("/api/issues/issue-1/dependencies")
        .send({ blockerIssueId: "b0000000-0000-0000-0000-000000000002" });
      expect(res.status).toBe(201);
    });

    it("DELETE /api/issues/:id/dependencies/:blockerIssueId returns 200 when found", async () => {
      mockDepService.removeDependency.mockResolvedValue({ id: "dep-1" });
      const res = await request(app).delete("/api/issues/issue-1/dependencies/issue-2");
      expect(res.status).toBe(200);
    });

    it("GET /api/issues/:id/dependents returns 200", async () => {
      mockDepService.listDependents.mockResolvedValue([]);
      const res = await request(app).get("/api/issues/issue-1/dependents");
      expect(res.status).toBe(200);
    });
  });
});
