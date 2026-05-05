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
  sendMessage: vi.fn(),
  getSettings: vi.fn(),
  upsertSettings: vi.fn(),
  getToolCatalog: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

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
    mockBuilderService.getSettings.mockResolvedValue(null);
    mockBuilderService.getToolCatalog.mockReturnValue({ tools: [] });
    mockBuilderService.createSession.mockResolvedValue({
      id: sessionId,
      companyId,
      title: "test",
      model: "gpt-test",
      providerType: "openai_compat",
      state: "active",
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
    expect(mockBuilderService.listSessions).toHaveBeenCalledWith(companyId);
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

  it("validates settings update payload", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .put(`/api/companies/${companyId}/builder/settings`)
      .send({ providerType: "not_a_real_provider", model: "x" });
    expect(res.status).toBe(400);
    expect(mockBuilderService.upsertSettings).not.toHaveBeenCalled();
  });
});
