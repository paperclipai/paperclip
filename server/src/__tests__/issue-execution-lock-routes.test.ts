import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  release: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp(actor?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: null,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: "in_progress" | "todo" | "blocked" = "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    checkoutRunId: "run-1",
    executionRunId: "run-1",
    createdByUserId: "local-board",
    identifier: "PAP-581",
    title: "Execution run lock cleanup",
  };
}

function makeRun(status: "queued" | "running" | "cancelled" = "queued") {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "22222222-2222-4222-8222-222222222222",
    status,
  };
}

describe("issue execution lock cleanup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAgentService.getById.mockResolvedValue(null);
    mockHeartbeatService.getRun.mockResolvedValue(makeRun("queued"));
    mockHeartbeatService.cancelRun.mockResolvedValue(makeRun("cancelled"));
  });

  it("cancels stale queued run when PATCH leaves in_progress", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(existing.id, { status: "blocked" });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", { suppressDeferredPromotion: true });
  });

  it("cancels stale queued run on release", async () => {
    const existing = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.release.mockResolvedValue({
      ...existing,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp()).post(`/api/issues/${existing.id}/release`);

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith(existing.id, undefined, null, { allowAnyIssueRelease: false });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", { suppressDeferredPromotion: true });
  });

  it("cancels current agent run on release to prevent lock recontamination", async () => {
    const existing = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.release.mockResolvedValue({
      ...existing,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      runId: "run-1",
    })).post(`/api/issues/${existing.id}/release`);

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith(
      existing.id,
      "22222222-2222-4222-8222-222222222222",
      "run-1",
      { allowAnyIssueRelease: false },
    );
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", { suppressDeferredPromotion: true });
  });

  it("passes CEO override when releasing another agent's issue", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      checkoutRunId: "run-assignee",
      executionRunId: "run-assignee",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.release.mockResolvedValue({
      ...existing,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    mockAgentService.getById.mockResolvedValue({
      id: "ceo-agent",
      companyId: "company-1",
      role: "ceo",
      permissions: null,
    });

    const res = await request(createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "ceo-agent",
      runId: "run-ceo",
    })).post(`/api/issues/${existing.id}/release`);

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith(existing.id, "ceo-agent", "run-ceo", {
      allowAnyIssueRelease: true,
    });
  });

  it("keeps non-CEO agent release under assignee-only rule", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      checkoutRunId: "run-assignee",
      executionRunId: "run-assignee",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.release.mockRejectedValue(conflict("Only assignee can release issue"));
    mockAgentService.getById.mockResolvedValue({
      id: "worker-agent",
      companyId: "company-1",
      role: "engineer",
      permissions: null,
    });

    const res = await request(createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "worker-agent",
      runId: "run-worker",
    })).post(`/api/issues/${existing.id}/release`);

    expect(mockIssueService.release).toHaveBeenCalledWith(existing.id, "worker-agent", "run-worker", {
      allowAnyIssueRelease: false,
    });
    expect(res.status).toBe(409);
  });
});
