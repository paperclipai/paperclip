import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  release: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockPromoteDeferredIssueWakeupForIssue = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    getRun: vi.fn(async (runId: string) =>
      runId === "run-1"
        ? {
          id: "run-1",
          companyId: "company-1",
          agentId: "agent-1",
          status: "running",
        }
        : null),
    reportRunActivity: vi.fn(async () => undefined),
    promoteDeferredIssueWakeupForIssue: mockPromoteDeferredIssueWakeupForIssue,
  }),
  instanceSettingsService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue release routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockPromoteDeferredIssueWakeupForIssue.mockResolvedValue(null);
  });

  it("preserves board identity across reroute then release", async () => {
    mockIssueService.getById
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: "local-board",
      })
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        createdByUserId: "local-board",
      });
    mockIssueService.update.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      checkoutRunId: "run-1",
      executionRunId: "run-1",
    });
    mockIssueService.release.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      checkoutRunId: "run-1",
      executionRunId: "run-1",
    });

    const app = createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const patchRes = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: null, assigneeUserId: "local-board" });

    expect(patchRes.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      {
        actorAgentId: null,
        actorRunId: null,
      },
    );

    const releaseRes = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/release")
      .send({});

    expect(releaseRes.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      actorAgentId: null,
      actorRunId: null,
      actorUserId: "local-board",
    });
    expect(mockPromoteDeferredIssueWakeupForIssue).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "company-1",
    );
  });

  it("passes board user identity into release", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
    mockIssueService.release.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/release")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      actorAgentId: null,
      actorRunId: null,
      actorUserId: "local-board",
    });
    expect(mockPromoteDeferredIssueWakeupForIssue).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "company-1",
    );
  });

  it("passes agent run identity into release", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
    mockIssueService.release.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/release")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "agent-1",
      "run-1",
    );
    expect(mockIssueService.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      actorAgentId: "agent-1",
      actorRunId: "run-1",
      actorUserId: null,
    });
    expect(mockPromoteDeferredIssueWakeupForIssue).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "company-1",
    );
  });

  it("does not log issue.released when release conflicts", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
    mockIssueService.release.mockRejectedValue(conflict("Issue still owned by active run"));

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/release")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Issue still owned by active run" });
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockPromoteDeferredIssueWakeupForIssue).not.toHaveBeenCalled();
  });
});
