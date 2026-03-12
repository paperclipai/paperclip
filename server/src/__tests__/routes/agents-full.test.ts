import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../../routes/agents.js";
import { errorHandler } from "../../middleware/index.js";

const AGENT_ID = "a0000000-0000-4000-8000-000000000001";
const AGENT_ID_2 = "a0000000-0000-4000-8000-000000000002";
const COMPANY_ID = "company-1";

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  pause: vi.fn(),
  terminate: vi.fn(),
  resume: vi.fn(),
  resolveByReference: vi.fn(),
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  listKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  getChainOfCommand: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfig: vi.fn(),
  getRuntimeState: vi.fn(),
  getTaskSessions: vi.fn(),
  resetSession: vi.fn(),
  getOrgChart: vi.fn(),
  listConfigurations: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  invoke: vi.fn(),
  listRuns: vi.fn(),
  listLiveRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelActiveForAgent: vi.fn(),
  getRunEvents: vi.fn(),
  getRunLog: vi.fn(),
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn().mockImplementation((_, config) => config),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../../adapters/index.js", () => ({
  findServerAdapter: vi.fn().mockReturnValue(null),
  listAdapterModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../redaction.js", () => ({
  redactEventPayload: (p: unknown) => p,
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@paperclipai/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "codex-mini-latest",
}));

vi.mock("@paperclipai/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "claude-3.5-sonnet",
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn().mockResolvedValue(undefined),
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agentRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
  });

  describe("GET /companies/:companyId/agents", () => {
    it("lists agents for company", async () => {
      mockAgentService.list.mockResolvedValue([{ id: AGENT_ID, name: "Agent 1" }]);
      const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/agents`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/agents");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /agents/me", () => {
    it("returns current agent", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, name: "MyAgent" });
      const res = await request(createApp({
        type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID,
      })).get("/api/agents/me");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("MyAgent");
    });

    it("returns 401 for board user", async () => {
      const res = await request(createApp()).get("/api/agents/me");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /agents/:id", () => {
    it("returns an agent by id", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, name: "Agent" });
      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Agent");
    });

    it("returns 404 for nonexistent agent", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:companyId/agents (direct create)", () => {
    it("creates an agent for instance admin board user", async () => {
      mockAgentService.create.mockResolvedValue({ id: AGENT_ID_2, companyId: COMPANY_ID, name: "New Agent" });
      mockAccessService.ensureMembership.mockResolvedValue(undefined);
      mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);
      const res = await request(createApp({ isInstanceAdmin: true }))
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "New Agent",
          role: "general",
          adapterType: "process",
          adapterConfig: {},
        });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Agent");
    });

    it("allows non-admin board user to create directly", async () => {
      mockAgentService.create.mockResolvedValue({ id: AGENT_ID_2, companyId: COMPANY_ID, name: "New Agent" });
      const res = await request(createApp())
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "New Agent",
          role: "general",
          adapterType: "process",
          adapterConfig: {},
        });
      expect(res.status).toBe(201);
    });

    it("returns 403 for agent actor without agents:create permission", async () => {
      mockAgentService.getById.mockResolvedValue({
        id: AGENT_ID, companyId: COMPANY_ID, role: "general",
        permissions: null,
      });
      mockAccessService.hasPermission.mockResolvedValue({ granted: false });
      const res = await request(createApp({
        type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID,
      }))
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "New Agent",
          role: "general",
          adapterType: "process",
          adapterConfig: {},
        });
      expect(res.status).toBe(403);
    });

    it("returns 403 for agent from wrong company", async () => {
      const res = await request(createApp({
        type: "agent", agentId: AGENT_ID, companyId: "other-company",
      }))
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "New Agent",
          role: "general",
          adapterType: "process",
          adapterConfig: {},
        });
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /agents/:id", () => {
    it("updates an agent for board user", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, name: "Old" });
      mockAgentService.update.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, name: "New" });
      const res = await request(createApp())
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ name: "New" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for nonexistent agent", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const res = await request(createApp())
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ name: "New" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /agents/:id", () => {
    it("deletes an agent", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID });
      mockAgentService.remove.mockResolvedValue({ id: AGENT_ID });
      const res = await request(createApp()).delete(`/api/agents/${AGENT_ID}`);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /agents/:id/pause", () => {
    it("pauses an agent", async () => {
      mockAgentService.pause.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, status: "paused" });
      mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
      const res = await request(createApp()).post(`/api/agents/${AGENT_ID}/pause`);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /agents/:id/terminate", () => {
    it("terminates an agent", async () => {
      mockAgentService.terminate.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" });
      mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
      const res = await request(createApp()).post(`/api/agents/${AGENT_ID}/terminate`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /agents/:id/keys", () => {
    it("lists api keys for an agent", async () => {
      mockAgentService.listKeys.mockResolvedValue([{ id: "k1" }]);
      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}/keys`);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /agents/:id/wakeup", () => {
    it("wakes up an agent", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID });
      mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });
      const res = await request(createApp())
        .post(`/api/agents/${AGENT_ID}/wakeup`)
        .send({ reason: "test" });
      expect(res.status).toBe(202);
      expect(res.body.id).toBe("run-1");
    });

    it("returns 202 when wakeup is skipped", async () => {
      mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID });
      mockHeartbeatService.wakeup.mockResolvedValue(null);
      const res = await request(createApp())
        .post(`/api/agents/${AGENT_ID}/wakeup`)
        .send({ reason: "test" });
      expect(res.status).toBe(202);
    });
  });
});
