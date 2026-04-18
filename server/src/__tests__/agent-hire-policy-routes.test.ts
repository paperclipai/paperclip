import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tooManyRequests, unprocessable } from "../errors.js";

const ceoAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const managerAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workerAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const outsiderAgentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const companyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const agentById: Record<string, {
  id: string;
  companyId: string;
  name: string;
  role: string;
  urlKey: string;
  title: null;
  icon: null;
  status: string;
  reportsTo: string | null;
  capabilities: null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: null;
  pausedAt: null;
  permissions: Record<string, unknown>;
  lastHeartbeatAt: null;
  metadata: null;
  createdAt: Date;
  updatedAt: Date;
}> = {};

function seedAgents() {
  const base = {
    companyId,
    urlKey: "",
    title: null as null,
    icon: null as null,
    status: "idle",
    capabilities: null as null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null as null,
    pausedAt: null as null,
    permissions: {},
    lastHeartbeatAt: null as null,
    metadata: null as null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
  agentById[ceoAgentId] = { ...base, id: ceoAgentId, name: "CEO", role: "ceo", reportsTo: null };
  agentById[managerAgentId] = { ...base, id: managerAgentId, name: "Manager", role: "engineering_lead", reportsTo: ceoAgentId };
  agentById[workerAgentId] = { ...base, id: workerAgentId, name: "Worker", role: "engineer", reportsTo: managerAgentId };
  agentById[outsiderAgentId] = { ...base, id: outsiderAgentId, name: "Outsider", role: "engineer", reportsTo: null };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
  updatePermissions: vi.fn(),
}));

const mockHirePolicyService = vi.hoisted(() => ({
  getByAgentId: vi.fn(),
  upsert: vi.fn(),
  enforce: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(async (agent: Record<string, unknown>) => ({
    bundle: null,
    adapterConfig: (agent.adapterConfig as Record<string, unknown>) ?? {},
  })),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn().mockReturnValue({ track: vi.fn() }),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentHirePolicyService: () => mockHirePolicyService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn().mockResolvedValue([]),
    resolveRequestedSkillKeys: vi.fn().mockResolvedValue([]),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_c: string, cfg: Record<string, unknown>) => cfg),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, cfg: Record<string, unknown>) => cfg),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent hire-policy admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAgents();
    mockAgentService.getById.mockImplementation(async (id: string) => agentById[id] ?? null);
    mockAgentService.getChainOfCommand.mockImplementation(async (id: string) => {
      const chain: Array<{ id: string; name: string; role: string; title: null }> = [];
      let current = agentById[id]?.reportsTo ?? null;
      const visited = new Set<string>([id]);
      while (current && !visited.has(current)) {
        visited.add(current);
        const mgr = agentById[current];
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: null });
        current = mgr.reportsTo ?? null;
      }
      return chain;
    });
    mockHirePolicyService.getByAgentId.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
  });

  it("GET allows the agent itself to read its own policy (null)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: workerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app).get(`/api/agents/${workerAgentId}/hire-policy`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ agentId: workerAgentId, policy: null });
  });

  it("PUT rejects the agent itself (cannot self-author policy)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: workerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .put(`/api/agents/${workerAgentId}/hire-policy`)
      .send({ allowedCombinations: [] });
    expect(res.status).toBe(403);
  });

  it("PUT allows an ancestor-manager", async () => {
    mockHirePolicyService.upsert.mockResolvedValue({
      id: "policy-1",
      agentId: workerAgentId,
      companyId,
      allowedCombinations: [{ adapterType: "claude_local", role: "account_manager", parent: "self" }],
      maxHiresPerMinute: 5,
      maxHiresPerHour: 50,
      notes: null,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .put(`/api/agents/${workerAgentId}/hire-policy`)
      .send({
        allowedCombinations: [{ adapterType: "claude_local", role: "account_manager", parent: "self" }],
        maxHiresPerMinute: 5,
        maxHiresPerHour: 50,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHirePolicyService.upsert).toHaveBeenCalledWith(
      companyId,
      workerAgentId,
      expect.objectContaining({ maxHiresPerMinute: 5, maxHiresPerHour: 50 }),
      null,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.hire_policy_updated" }),
    );
  });

  it("PUT rejects an outsider agent (not in chain, not CEO)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: outsiderAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .put(`/api/agents/${workerAgentId}/hire-policy`)
      .send({ allowedCombinations: [] });
    expect(res.status).toBe(403);
  });

  it("PUT allows CEO to set any agent's policy", async () => {
    mockHirePolicyService.upsert.mockResolvedValue({
      id: "policy-2",
      agentId: outsiderAgentId,
      companyId,
      allowedCombinations: [],
      maxHiresPerMinute: null,
      maxHiresPerHour: null,
      notes: null,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .put(`/api/agents/${outsiderAgentId}/hire-policy`)
      .send({ allowedCombinations: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHirePolicyService.upsert).toHaveBeenCalled();
  });

  it("returns 404 when target agent does not exist", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app).get(`/api/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/hire-policy`);
    expect(res.status).toBe(404);
  });
});

describe("agent hire-policy enforcement on /agent-hires", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAgents();
    mockAgentService.getById.mockImplementation(async (id: string) => agentById[id] ?? null);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "99999999-9999-4999-8999-999999999999",
      companyId,
      name: String(input.name ?? "Hire"),
      urlKey: "hire",
      role: String(input.role ?? "general"),
      title: null,
      icon: null,
      status: "idle",
      reportsTo: (input.reportsTo as string | null) ?? null,
      capabilities: null,
      adapterType: String(input.adapterType ?? "claude_local"),
      adapterConfig: (input.adapterConfig as Record<string, unknown>) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown>) ?? {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("denies hire when policy service throws 422", async () => {
    mockHirePolicyService.enforce.mockRejectedValue(
      unprocessable("Hire policy: combination not allowed", {
        code: "hire_policy_denied",
      }),
    );
    agentById[managerAgentId].permissions = { canCreateAgents: true };

    const app = await createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Blocked Hire",
        adapterType: "claude_local",
        role: "engineer",
        reportsTo: managerAgentId,
      });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "Hire policy: combination not allowed",
      details: expect.objectContaining({ code: "hire_policy_denied" }),
    });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate-limit triggers", async () => {
    mockHirePolicyService.enforce.mockRejectedValue(
      tooManyRequests("Hire rate limit exceeded (per minute)", 17, {
        code: "hire_rate_limit",
        window: "minute",
        limit: 5,
      }),
    );
    agentById[managerAgentId].permissions = { canCreateAgents: true };

    const app = await createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Rate Hire",
        adapterType: "claude_local",
        role: "engineer",
        reportsTo: managerAgentId,
      });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("17");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("calls enforce with the hire shape on successful hire", async () => {
    mockHirePolicyService.enforce.mockResolvedValue(undefined);
    agentById[managerAgentId].permissions = { canCreateAgents: true };

    const app = await createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
      source: "agent_api_key",
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "OK Hire",
        adapterType: "process",
        role: "engineer",
        reportsTo: managerAgentId,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockHirePolicyService.enforce).toHaveBeenCalledWith(
      managerAgentId,
      companyId,
      expect.objectContaining({
        adapterType: "process",
        role: "engineer",
        reportsTo: managerAgentId,
      }),
    );
  });

  it("skips enforcement when caller is board (non-agent)", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Board Hire",
        adapterType: "process",
        role: "engineer",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockHirePolicyService.enforce).not.toHaveBeenCalled();
  });
});
