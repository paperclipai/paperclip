import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  goalService: () => ({}),
  projectService: () => ({}),
  issueApprovalService: () => ({}),
  documentService: () => ({}),
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    issueRoutes(
      {} as any,
      {
        deleteObject: vi.fn(),
        putObject: vi.fn(),
        getObjectStream: vi.fn(),
        getSignedDownloadUrl: vi.fn(),
      } as any,
    ),
  );
  app.use(errorHandler);
  return app;
}

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Issue title",
  description: null,
  status: "in_progress",
  priority: "medium",
  assigneeAgentId: "agent-subordinate",
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  projectId: null,
  goalId: null,
  parentId: null,
  requestDepth: 0,
  billingCode: null,
  hiddenAt: null,
  startedAt: new Date("2026-03-16T18:00:00.000Z"),
  completedAt: null,
  cancelledAt: null,
  checkoutRunId: null,
  executionRunId: "run-1",
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdAt: new Date("2026-03-16T18:00:00.000Z"),
  updatedAt: new Date("2026-03-16T18:00:00.000Z"),
};

describe("PATCH /issues/:id task control", () => {
  beforeEach(() => {
    mockAccessService.hasPermission.mockReset().mockResolvedValue(false);
    mockAccessService.canUser.mockReset().mockResolvedValue(false);
    mockAgentService.getById.mockReset();
    mockAgentService.getChainOfCommand.mockReset();
    mockHeartbeatService.getRun.mockReset().mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-subordinate",
      status: "running",
      contextSnapshot: { issueId: "issue-1" },
    });
    mockHeartbeatService.getActiveRunForAgent.mockReset().mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset().mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-subordinate",
      status: "cancelled",
    });
    mockHeartbeatService.wakeup.mockReset().mockResolvedValue(null);
    mockIssueService.getById.mockReset().mockResolvedValue(baseIssue);
    mockIssueService.getByIdentifier.mockReset().mockResolvedValue(null);
    mockIssueService.update.mockReset().mockImplementation(async (_id, patch) => ({
      ...baseIssue,
      ...patch,
      assigneeAgentId: patch.assigneeAgentId ?? baseIssue.assigneeAgentId,
      assigneeUserId: patch.assigneeUserId ?? baseIssue.assigneeUserId,
      status: patch.status ?? baseIssue.status,
    }));
    mockIssueService.addComment.mockReset().mockResolvedValue({
      id: "comment-1",
      body: "ok",
    });
    mockIssueService.findMentionedAgents.mockReset().mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockReset().mockResolvedValue({});
    mockLogActivity.mockReset().mockResolvedValue(undefined);
    mockLogger.warn.mockReset();
  });

  it("allows CEO agent to cancel a subordinate issue and interrupts the active run", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-ceo",
        companyId: "company-1",
        runId: "run-ceo",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: "run-1" }),
    );
  });

  it("allows an ancestor manager with task-management permission to reassign a subordinate issue and interrupts the active run", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-manager",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: false, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([
      { id: "agent-manager", name: "Manager", role: "manager", title: null },
    ]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-manager",
        companyId: "company-1",
        runId: "run-manager",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ assigneeAgentId: "00000000-0000-4000-8000-000000000002" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("00000000-0000-4000-8000-000000000002");
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: "00000000-0000-4000-8000-000000000002",
    });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
  });

  it("preserves legacy canCreateAgents-based task control for ancestor managers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-manager",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: true, canManageTasks: false },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([
      { id: "agent-manager", name: "Manager", role: "manager", title: null },
    ]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-manager",
        companyId: "company-1",
        runId: "run-manager",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ assigneeAgentId: "00000000-0000-4000-8000-000000000003" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: "00000000-0000-4000-8000-000000000003",
    });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
  });

  it("rejects reassignment attempts when the acting agent lacks task-management permission", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-manager",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: false, canManageTasks: false },
    });

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-manager",
        companyId: "company-1",
        runId: "run-manager",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ assigneeAgentId: "00000000-0000-4000-8000-000000000002" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.task_control_denied",
        entityType: "issue",
        entityId: "issue-1",
        details: expect.objectContaining({
          reason: "missing_permission",
          managedAgentId: "agent-subordinate",
          requestedStatus: undefined,
        }),
      }),
    );
  });

  it("rejects reassignment attempts outside the acting agent's chain of command", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-manager",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: false, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-manager",
        companyId: "company-1",
        runId: "run-manager",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only an ancestor manager can cancel or reassign another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.task_control_denied",
        entityType: "issue",
        entityId: "issue-1",
        details: expect.objectContaining({
          reason: "not_in_chain_of_command",
          managedAgentId: "agent-subordinate",
          requestedStatus: "cancelled",
        }),
      }),
    );
  });

  it("uses the active-run fallback when the issue has no executionRunId", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      executionRunId: null,
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue({
      id: "run-fallback",
      companyId: "company-1",
      agentId: "agent-subordinate",
      status: "running",
      contextSnapshot: { issueId: "issue-1" },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-fallback",
      companyId: "company-1",
      agentId: "agent-subordinate",
      status: "cancelled",
    });

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-ceo",
        companyId: "company-1",
        runId: "run-ceo",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getActiveRunForAgent).toHaveBeenCalledWith("agent-subordinate");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-fallback");
  });

  it("does not interrupt when an agent updates its own issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      assigneeAgentId: "agent-self",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-self",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: false, canManageTasks: false },
    });

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-self",
        companyId: "company-1",
        runId: "run-self",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("does not apply the manager-only cancellation gate to unrelated updates on already-cancelled issues", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      status: "cancelled",
      cancelledAt: new Date("2026-03-16T18:30:00.000Z"),
    });

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-manager",
        companyId: "company-1",
        runId: "run-manager",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { priority: "high" });
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.task_control_denied" }),
    );
  });

  it("still updates the issue when no active run exists", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-ceo",
        companyId: "company-1",
        runId: "run-ceo",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("still updates the issue when cancelling the managed run throws", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);
    mockHeartbeatService.cancelRun.mockRejectedValue(new Error("db unavailable"));

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-ceo",
        companyId: "company-1",
        runId: "run-ceo",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "cancelled" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-1", err: expect.any(Error) }),
      "failed to cancel managed run during issue update",
    );
  });

  it("does not enforce chain-of-command or interrupt runs for assigneeUserId-only updates", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-outsider",
      companyId: "company-1",
      role: "manager",
      permissions: { canCreateAgents: false, canManageTasks: true },
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([{ id: "agent-ceo", name: "CEO", role: "ceo", title: null }]);

    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-outsider",
        companyId: "company-1",
        runId: "run-outsider",
        source: "agent_key",
      }),
    )
      .patch("/api/issues/issue-1")
      .send({ assigneeUserId: "user-2" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { assigneeUserId: "user-2" });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.task_control_denied" }),
    );
  });
});
