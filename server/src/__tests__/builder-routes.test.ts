import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

const mockBuilderService = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSessionDetail: vi.fn(),
  createSession: vi.fn(),
  abortSession: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  sendMessage: vi.fn(),
  getSettings: vi.fn(),
  upsertSettings: vi.fn(),
  getToolCatalog: vi.fn(),
  listProposals: vi.fn(),
  getProposal: vi.fn(),
  applyProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  normalizeSecretRefBindingForPersistence: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/builder/index.js", () => ({
    builderService: () => mockBuilderService,
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { builderRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/builder.js")>("../routes/builder.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: typeof actor }).actor = actor;
    next();
  });
  app.use("/api", builderRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("builder routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/builder/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      builderEnabled: true,
    });
    mockBuilderService.listSessions.mockResolvedValue([]);
    mockBuilderService.listProposals.mockResolvedValue([]);
    mockBuilderService.getSettings.mockResolvedValue(null);
    mockBuilderService.getToolCatalog.mockReturnValue({ tools: [] });
    mockSecretService.create.mockResolvedValue({ id: "secret-1" });
    mockSecretService.rotate.mockResolvedValue(undefined);
    mockSecretService.normalizeSecretRefBindingForPersistence.mockImplementation(
      async (_companyId, value) => value,
    );
    mockBuilderService.createSession.mockResolvedValue({
      id: sessionId,
      companyId,
      title: "test",
      model: "gpt-test",
      adapterType: "claude_local",
      state: "active",
      archivedAt: null,
      createdByUserId: "board-user",
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      costCentsTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockBuilderService.sendMessage.mockResolvedValue({
      userMessage: { id: "u1" },
      newMessages: [{ id: "a1" }],
      usage: { inputTokens: 1, outputTokens: 2, costCents: 0 },
      truncated: false,
    });
    mockBuilderService.archiveSession.mockResolvedValue({
      id: sessionId,
      companyId,
      title: "test",
      model: "gpt-test",
      adapterType: "claude_local",
      state: "active",
      archivedAt: new Date(),
      createdByUserId: "board-user",
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      costCentsTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockBuilderService.restoreSession.mockResolvedValue({
      id: sessionId,
      companyId,
      title: "test",
      model: "gpt-test",
      adapterType: "claude_local",
      state: "active",
      archivedAt: null,
      createdByUserId: "board-user",
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      costCentsTotal: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects agents", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
    });
    const res = await request(app).get(`/api/companies/${companyId}/builder/sessions`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/board-only/i);
    expect(mockBuilderService.listSessions).not.toHaveBeenCalled();
  });

  it("allows board with company access to list sessions", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }],
    });
    const res = await request(app).get(`/api/companies/${companyId}/builder/sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
    expect(mockBuilderService.listSessions).toHaveBeenCalledWith(companyId, {
      includeArchived: false,
    });
  });

  it("passes includeArchived through when requested", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }],
    });
    const res = await request(app).get(
      `/api/companies/${companyId}/builder/sessions?includeArchived=true`,
    );
    expect(res.status).toBe(200);
    expect(mockBuilderService.listSessions).toHaveBeenCalledWith(companyId, {
      includeArchived: true,
    });
  });

  it("rejects board users without company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "stranger",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["other-company"],
      memberships: [],
    });
    const res = await request(app).get(`/api/companies/${companyId}/builder/sessions`);
    expect(res.status).toBe(403);
    expect(mockBuilderService.listSessions).not.toHaveBeenCalled();
  });

  it("creates a session and writes an activity entry", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/builder/sessions`)
      .send({ title: "test" });
    expect(res.status).toBe(201);
    expect(mockBuilderService.createSession).toHaveBeenCalledWith({
      companyId,
      createdByUserId: "board-user",
      title: "test",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "builder.session.created",
        entityType: "builder_session",
        entityId: sessionId,
      }),
    );
  });

  it("validates message body", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/builder/sessions/${sessionId}/messages`)
      .send({ text: "" });
    expect(res.status).toBe(400);
    expect(mockBuilderService.sendMessage).not.toHaveBeenCalled();
  });

  it("forwards a valid message and logs activity", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/builder/sessions/${sessionId}/messages`)
      .send({ text: "hello" });
    expect(res.status).toBe(200);
    expect(mockBuilderService.sendMessage).toHaveBeenCalledWith({
      companyId,
      sessionId,
      actor: { type: "user", id: "board-user" },
      text: "hello",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "builder.session.message_sent",
      }),
    );
  });

  it("archives a session and logs activity", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/builder/sessions/${sessionId}/archive`);
    expect(res.status).toBe(200);
    expect(mockBuilderService.archiveSession).toHaveBeenCalledWith(companyId, sessionId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "builder.session.archived",
        entityId: sessionId,
      }),
    );
  });

  it("restores a session and logs activity", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/builder/sessions/${sessionId}/restore`);
    expect(res.status).toBe(200);
    expect(mockBuilderService.restoreSession).toHaveBeenCalledWith(companyId, sessionId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "builder.session.restored",
        entityId: sessionId,
      }),
    );
  });

  it("validates settings update payload", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .put(`/api/companies/${companyId}/builder/settings`)
      .send({ adapterType: "", adapterConfig: {} });
    expect(res.status).toBe(400);
    expect(mockBuilderService.upsertSettings).not.toHaveBeenCalled();
  });

  it("persists OpenClaw Builder tokens as authTokenRef instead of plaintext", async () => {
    mockBuilderService.getSettings.mockResolvedValue(null);
    mockBuilderService.upsertSettings.mockResolvedValue({
      companyId,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "wss://gateway.example",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .put(`/api/companies/${companyId}/builder/settings`)
      .send({
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "wss://gateway.example",
          authToken: "gateway-token",
        },
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.create).toHaveBeenCalled();
    expect(mockBuilderService.upsertSettings).toHaveBeenCalledWith(companyId, {
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "wss://gateway.example",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
    });
  });

  it("preserves stored Otto apiKeyRef when the user leaves the field blank", async () => {
    mockBuilderService.getSettings.mockResolvedValue({
      companyId,
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockBuilderService.upsertSettings.mockResolvedValue({
      companyId,
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .put(`/api/companies/${companyId}/builder/settings`)
      .send({
        adapterType: "otto_agent",
        adapterConfig: {
          url: "https://otto.example/api/paperclip",
        },
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockSecretService.rotate).not.toHaveBeenCalled();
    expect(mockBuilderService.upsertSettings).toHaveBeenCalledWith(companyId, {
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
    });
  });

  it("rotates the stored Otto secret when a replacement apiKey is provided", async () => {
    mockBuilderService.getSettings.mockResolvedValue({
      companyId,
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockBuilderService.upsertSettings.mockResolvedValue({
      companyId,
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .put(`/api/companies/${companyId}/builder/settings`)
      .send({
        adapterType: "otto_agent",
        adapterConfig: {
          url: "https://otto.example/api/paperclip",
          apiKey: "replacement-key",
        },
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.rotate).toHaveBeenCalledWith(
      "secret-otto",
      { value: "replacement-key" },
      { userId: "board-user" },
    );
    expect(mockBuilderService.upsertSettings).toHaveBeenCalledWith(companyId, {
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
      },
    });
  });

  it("lists proposals with additive handoff metadata", async () => {
    mockBuilderService.listProposals.mockResolvedValue([
      {
        id: "proposal-1",
        companyId,
        sessionId,
        messageId: "message-1",
        kind: "hire_agent",
        payload: { name: "Carmen" },
        status: "pending",
        appliedActivityId: null,
        approvalId: "approval-1",
        decidedByUserId: null,
        decidedAt: null,
        failureReason: null,
        handoff: {
          kind: "approval",
          label: "Review approval",
          href: "/approvals/approval-1",
          approvalId: "approval-1",
        },
        createdAt: new Date("2026-05-06T10:00:00.000Z"),
        updatedAt: new Date("2026-05-06T10:00:00.000Z"),
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app).get(
      `/api/companies/${companyId}/builder/proposals?sessionId=${sessionId}`,
    );

    expect(res.status).toBe(200);
    expect(mockBuilderService.listProposals).toHaveBeenCalledWith(companyId, {
      sessionId,
      status: undefined,
    });
    expect(res.body.proposals[0]).toEqual(
      expect.objectContaining({
        id: "proposal-1",
        handoff: expect.objectContaining({
          kind: "approval",
          href: "/approvals/approval-1",
        }),
      }),
    );
  });
});
