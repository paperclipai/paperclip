import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const actorAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: peerAgentId,
    companyId,
    name: "Peer",
    urlKey: "peer",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: { cwd: "/repo", model: "gpt-5", env: { API_KEY: "secret-value" } },
    runtimeConfig: { heartbeat: { enabled: true } },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    ...overrides,
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
  instanceSettingsService: {},
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([
            { id: companyId, name: "Paperclip", requireBoardApprovalForNewAgents: false },
          ]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
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

const peerActor = {
  type: "agent",
  agentId: actorAgentId,
  companyId,
};

describe("agent configuration redaction is observable (AI-574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const peer = makeAgent();
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === peerAgentId ? peer : { ...peer, id: actorAgentId, name: "Actor", urlKey: "actor" },
    );
    mockAgentService.list.mockResolvedValue([peer]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(false);
  });

  it("marks a restricted peer read as redacted and still reports config key names", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(res.status).toBe(200);
    expect(res.body.configurationAccess).toBe("redacted");
    // Values stay hidden...
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
    // ...but the caller can tell "redacted" from "genuinely empty" and can still
    // answer "is this agent configured?".
    expect(res.body.adapterConfigKeys).toEqual(["cwd", "env", "model"]);
    expect(res.body.runtimeConfigKeys).toEqual(["heartbeat"]);
  });

  it("never leaks config values through the key-name fields", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(JSON.stringify(res.body.adapterConfigKeys)).not.toContain("secret-value");
    expect(JSON.stringify(res.body.runtimeConfigKeys)).not.toContain("secret-value");
  });

  it("reports configurationAccess full on an unrestricted read", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${actorAgentId}`);

    expect(res.status).toBe(200);
    expect(res.body.configurationAccess).toBe("full");
    expect(res.body.adapterConfig).toEqual(makeAgent().adapterConfig);
    expect(res.body.adapterConfigKeys).toEqual(["cwd", "env", "model"]);
  });

  it("marks restricted entries in the agent list too", async () => {
    const res = await request(createApp(peerActor)).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].configurationAccess).toBe("redacted");
    expect(res.body[0].adapterConfigKeys).toEqual(["cwd", "env", "model"]);
    expect(res.body[0].adapterConfig).toEqual({});
  });

  it("distinguishes a genuinely empty config from a redacted one", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {},
      runtimeConfig: {},
    });

    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(res.status).toBe(200);
    // Both read as an empty object, which is exactly the ambiguity this issue
    // reported -- the marker is what disambiguates them.
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.configurationAccess).toBe("redacted");
    expect(res.body.adapterConfigKeys).toEqual([]);
  });
});