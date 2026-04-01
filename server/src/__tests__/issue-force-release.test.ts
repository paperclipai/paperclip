import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  release: vi.fn(),
  forceRelease: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({}),
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
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";

function makeLockedIssue() {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: "stale-run-id",
    executionRunId: "stale-run-id",
    executionLockedAt: new Date("2026-04-01T06:00:00Z"),
    executionAgentNameKey: "sudoku ceo",
  };
}

function makeReleasedIssue() {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    executionAgentNameKey: null,
  };
}

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user-1",
      companyId: COMPANY_ID,
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      runId: "run-abc",
      companyId: COMPANY_ID,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /issues/:id/release — force flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("board user with force:true calls forceRelease and returns 200", async () => {
    mockIssueService.getById.mockResolvedValue(makeLockedIssue());
    mockIssueService.forceRelease.mockResolvedValue(makeReleasedIssue());

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.forceRelease).toHaveBeenCalledWith(ISSUE_ID);
    expect(mockIssueService.release).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.force_released", entityId: ISSUE_ID }),
    );
  });

  it("agent with force:true is rejected with 403", async () => {
    mockIssueService.getById.mockResolvedValue(makeLockedIssue());

    const res = await request(createAgentApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({ force: true, agentId: "agent-1" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only board users can force-release a locked issue" });
    expect(mockIssueService.forceRelease).not.toHaveBeenCalled();
    expect(mockIssueService.release).not.toHaveBeenCalled();
  });

  it("board user without force calls normal release path", async () => {
    mockIssueService.getById.mockResolvedValue(makeLockedIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.release.mockResolvedValue({
      ...makeReleasedIssue(),
      assigneeAgentId: null,
    });

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalled();
    expect(mockIssueService.forceRelease).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.released", entityId: ISSUE_ID }),
    );
  });

  it("returns 404 when force-releasing a non-existent issue", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({ force: true });

    expect(res.status).toBe(404);
    expect(mockIssueService.forceRelease).not.toHaveBeenCalled();
  });

  it("returns 404 when forceRelease service returns null", async () => {
    mockIssueService.getById.mockResolvedValue(makeLockedIssue());
    mockIssueService.forceRelease.mockResolvedValue(null);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({ force: true });

    expect(res.status).toBe(404);
  });
});
