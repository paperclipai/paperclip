import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  ensure: vi.fn(),
  reset: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function allowDecision() {
  return {
    allowed: true,
    action: "agents:create",
    reason: "allow_explicit_grant",
    explanation: "Allowed.",
  };
}

function denyDecision() {
  return {
    allowed: false,
    action: "agents:create",
    reason: "deny_missing_grant",
    explanation: "Missing permission: agents:create.",
  };
}

function builtInState(overrides: Record<string, unknown> = {}) {
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares concise operational briefs.",
      defaultInstructions: "Write briefs.",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
    },
    status: "ready",
    agentId,
    agent: {
      id: agentId,
      companyId,
      name: "Briefs Agent",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    },
    pauseReason: null,
    ...overrides,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/built-in-agents.js", () => ({
    builtInAgentService: () => mockBuiltInAgentService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ builtInAgentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/built-in-agents.js")>("../routes/built-in-agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", builtInAgentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("built-in agent routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue(allowDecision());
    mockBuiltInAgentService.list.mockResolvedValue([builtInState()]);
    mockBuiltInAgentService.ensure.mockResolvedValue(builtInState());
    mockBuiltInAgentService.reset.mockResolvedValue(builtInState());
  });

  it("lists built-in agent state for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.list).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([expect.objectContaining({ status: "ready", agentId })]);
  });

  it("denies list requests outside the actor company boundary", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["33333333-3333-4333-8333-333333333333"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBuiltInAgentService.list).not.toHaveBeenCalled();
  });

  it("provisions through the agents:create gate and passes optional adapter overrides", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith({
      actor: expect.objectContaining({ type: "board" }),
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    expect(mockBuiltInAgentService.ensure).toHaveBeenCalledWith(companyId, "briefs", {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "built_in_agent.provision_requested",
      entityId: agentId,
    }));
  });

  it("denies provision when agents:create is not allowed", async () => {
    mockAccessService.decide.mockResolvedValue(denyDecision());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details).toMatchObject({ reason: "deny_missing_grant" });
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
  });

  it("rejects provision bodies with unknown fields", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", unexpected: true });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
  });

  it("resets registry defaults through the same agents:create gate", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.reset).toHaveBeenCalledWith(companyId, "briefs");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: "manager-agent",
      agentId: "manager-agent",
      action: "built_in_agent.reset",
      entityId: agentId,
    }));
  });

  it("denies agent actors from provisioning across company boundaries", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId: "33333333-3333-4333-8333-333333333333",
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.reset).not.toHaveBeenCalled();
  });
});
