import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  release: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
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

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
    runId: null,
  },
) {
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
    mockHeartbeatService.getRun.mockResolvedValue(makeRun("queued"));
    mockHeartbeatService.cancelRun.mockResolvedValue(makeRun("cancelled"));
    mockAgentService.getById.mockResolvedValue(null);
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

  it("cancels stale queued run when PATCH moves issue back to todo", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(existing.id, { status: "todo" });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", { suppressDeferredPromotion: true });
  });

  it("cancels stale queued run when PATCH reassigns issue", async () => {
    const existing = makeIssue("in_progress");
    const nextAssignee = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      assigneeAgentId: nextAssignee,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: nextAssignee });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(existing.id, { assigneeAgentId: nextAssignee });
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
    expect(mockIssueService.release).toHaveBeenCalledWith(existing.id, undefined, null, {
      allowAssigneeOverride: false,
    });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", { suppressDeferredPromotion: true });
  });

  it("allows manager agent override on release", async () => {
    const existing = {
      ...makeIssue("todo"),
      assigneeAgentId: "assignee-agent",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.getById.mockResolvedValue({
      id: "manager-agent",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: true },
    });
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

    const res = await request(
      createApp({
        type: "agent",
        agentId: "manager-agent",
        companyId: "company-1",
        source: "jwt",
        runId: "manager-run-1",
      }),
    ).post(`/api/issues/${existing.id}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith(existing.id, "manager-agent", "manager-run-1", {
      allowAssigneeOverride: true,
    });
  });
});
