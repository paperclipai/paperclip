import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const userId = "user-1";
const messageId = "33333333-3333-4333-8333-333333333333";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "codex_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentThreadService = vi.hoisted(() => ({
  getActiveThread: vi.fn(),
  ensureActiveThread: vi.fn(),
  listMessages: vi.fn(),
  markRead: vi.fn(),
  postUserMessage: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/agent-threads.js", () => ({
    agentThreadService: () => mockAgentThreadService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentThreadService: () => mockAgentThreadService,
    agentInstructionsService: () => ({}),
    accessService: () => ({}),
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent thread routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/agent-threads.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();

    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockAgentThreadService.postUserMessage.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      },
      message: {
        id: messageId,
        threadId: "thread-1",
        companyId,
        role: "user",
        authorUserId: userId,
        authorAgentId: null,
        producingHeartbeatRunId: null,
        body: "hello from board",
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      },
    });
    mockAgentThreadService.getActiveThread.mockResolvedValue({
      id: "thread-1",
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
      lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      updatedAt: new Date("2026-05-04T09:00:00.000Z"),
    });
    mockAgentThreadService.ensureActiveThread.mockResolvedValue({
      id: "thread-1",
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
      lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
      createdAt: new Date("2026-05-04T09:00:00.000Z"),
      updatedAt: new Date("2026-05-04T09:00:00.000Z"),
    });
    mockAgentThreadService.listMessages.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      },
      messages: [
        {
          id: messageId,
          threadId: "thread-1",
          companyId,
          role: "user",
          authorUserId: userId,
          authorAgentId: null,
          producingHeartbeatRunId: null,
          body: "hello from board",
          createdAt: new Date("2026-05-04T09:00:00.000Z"),
          updatedAt: new Date("2026-05-04T09:00:00.000Z"),
        },
      ],
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });
    mockAgentThreadService.markRead.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      },
      readState: {
        id: "read-1",
        threadId: "thread-1",
        companyId,
        userId,
        lastReadMessageId: messageId,
        lastReadAt: new Date("2026-05-04T09:01:00.000Z"),
        createdAt: new Date("2026-05-04T09:01:00.000Z"),
        updatedAt: new Date("2026-05-04T09:01:00.000Z"),
      },
    });
  });

  it("returns the active thread for an agent", async () => {
    const app = await createApp();

    const res = await request(app).get(`/api/agents/${agentId}/thread`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentThreadService.getActiveThread).toHaveBeenCalledWith({
      companyId,
      agentId,
    });
    expect(res.body).toEqual({
      id: "thread-1",
      companyId,
      agentId,
      status: "active",
      archivedAt: null,
      lastActivityAt: "2026-05-04T09:00:00.000Z",
      createdAt: "2026-05-04T09:00:00.000Z",
      updatedAt: "2026-05-04T09:00:00.000Z",
    });
  });

  it("returns messages from the active thread for an agent", async () => {
    const app = await createApp();

    const res = await request(app).get(`/api/agents/${agentId}/thread/messages`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentThreadService.listMessages).toHaveBeenCalledWith({
      companyId,
      agentId,
    });
    expect(res.body).toEqual({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: "2026-05-04T09:00:00.000Z",
        createdAt: "2026-05-04T09:00:00.000Z",
        updatedAt: "2026-05-04T09:00:00.000Z",
      },
      messages: [
        {
          id: messageId,
          threadId: "thread-1",
          companyId,
          role: "user",
          authorUserId: userId,
          authorAgentId: null,
          producingHeartbeatRunId: null,
          body: "hello from board",
          createdAt: "2026-05-04T09:00:00.000Z",
          updatedAt: "2026-05-04T09:00:00.000Z",
        },
      ],
    });
  });

  it("posts a human message through the agent endpoint and wakes the target agent", async () => {
    const app = await createApp();

    const res = await request(app)
      .post(`/api/agents/${agentId}/thread/messages`)
      .send({ body: "hello from board" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentThreadService.postUserMessage).toHaveBeenCalledWith({
      companyId,
      agentId,
      authorUserId: userId,
      body: "hello from board",
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "agent_thread_message",
      requestedByActorType: "user",
      requestedByActorId: userId,
      payload: expect.objectContaining({
        agentThreadId: "thread-1",
        agentThreadMessageId: messageId,
      }),
      contextSnapshot: expect.objectContaining({
        agentThreadId: "thread-1",
        agentThreadMessageId: messageId,
        agentThreadMessageBody: "hello from board",
        wakeReason: "agent_thread_message",
      }),
    }));
    expect(res.body).toEqual({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: "2026-05-04T09:00:00.000Z",
        createdAt: "2026-05-04T09:00:00.000Z",
        updatedAt: "2026-05-04T09:00:00.000Z",
      },
      message: {
        id: messageId,
        threadId: "thread-1",
        companyId,
        role: "user",
        authorUserId: userId,
        authorAgentId: null,
        producingHeartbeatRunId: null,
        body: "hello from board",
        createdAt: "2026-05-04T09:00:00.000Z",
        updatedAt: "2026-05-04T09:00:00.000Z",
      },
    });
  });

  it("rejects message body exceeding 10000 characters", async () => {
    const app = await createApp();
    const oversizedBody = "x".repeat(10_001);

    const res = await request(app)
      .post(`/api/agents/${agentId}/thread/messages`)
      .send({ body: oversizedBody });

    expect(res.status).toBe(400);
  });

  it("updates per-user read state for the active thread", async () => {
    const app = await createApp();

    const res = await request(app)
      .post(`/api/agents/${agentId}/thread/read`)
      .send({ lastReadMessageId: messageId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentThreadService.markRead).toHaveBeenCalledWith({
      companyId,
      agentId,
      userId,
      lastReadMessageId: messageId,
    });
    expect(res.body).toEqual({
      thread: {
        id: "thread-1",
        companyId,
        agentId,
        status: "active",
        archivedAt: null,
        lastActivityAt: "2026-05-04T09:00:00.000Z",
        createdAt: "2026-05-04T09:00:00.000Z",
        updatedAt: "2026-05-04T09:00:00.000Z",
      },
      readState: {
        id: "read-1",
        threadId: "thread-1",
        companyId,
        userId,
        lastReadMessageId: messageId,
        lastReadAt: "2026-05-04T09:01:00.000Z",
        createdAt: "2026-05-04T09:01:00.000Z",
        updatedAt: "2026-05-04T09:01:00.000Z",
      },
    });
  });

  it("returns 404 when markRead finds no active thread", async () => {
    mockAgentThreadService.markRead.mockResolvedValue(null);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/agents/${agentId}/thread/read`)
      .send({ lastReadMessageId: messageId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No active thread found for this agent");
  });

  it("rejects agent actors from GET thread messages with 403", async () => {
    const [{ agentRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "other-agent-id",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "member" }],
        source: "api_key",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", agentRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app).get(`/api/agents/${agentId}/thread/messages`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });
});
