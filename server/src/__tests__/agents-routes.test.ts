import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  resolveByReference: vi.fn(),
  getChainOfCommand: vi.fn(),
  listConfigRevisions: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  logActivity: mockLogActivity,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../redaction.js", () => ({
  redactEventPayload: (v: unknown) => v,
  REDACTED_EVENT_VALUE: "***REDACTED***",
}));

vi.mock("../log-redaction.js", () => ({
  redactCurrentUserValue: (v: unknown) => v,
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@paperclipai/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "codex-mini",
}));

vi.mock("@paperclipai/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "cursor-small",
}));

vi.mock("@paperclipai/adapter-gemini-local", () => ({
  DEFAULT_GEMINI_LOCAL_MODEL: "gemini-2.0-flash",
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

// Valid UUID-format IDs — router.param("id") calls isUuidLike() which rejects non-UUID strings
const AGENT_ID = "a0000000-0000-1000-8000-000000000001";
const AGENT_ID_2 = "a0000000-0000-1000-8000-000000000002";
const CEO_ID = "c0000000-0000-1000-8000-0000000000c0";
const COMPANY_ID = "c0000000-0000-1000-8000-00000000c001";
const COMPANY_OTHER = "c0000000-0000-1000-8000-00000000c002";
const USER_ID = "a0000000-0000-1000-8000-000000000b01";
const USER_OTHER = "a0000000-0000-1000-8000-000000000b02";
const NONEXISTENT_ID = "f0000000-0000-1000-8000-ffffffffffff";

const BOARD_ACTOR = {
  type: "board",
  userId: USER_ID,
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};

const OTHER_COMPANY_ACTOR = {
  type: "board",
  userId: USER_OTHER,
  companyIds: [COMPANY_OTHER],
  source: "session",
  isInstanceAdmin: false,
};

function createApp(actor: any = BOARD_ACTOR) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "TestAgent",
    role: "worker",
    title: "Developer",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {
      cwd: "/workspace",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-secret-value",
        SAFE_REF: { type: "secret_ref", secretId: "sec-1" },
      },
    },
    runtimeConfig: {},
    permissions: null,
    reportsTo: null,
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    ...overrides,
  };
}

describe("agents routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
  });

  describe("GET /api/companies/:companyId/agents", () => {
    it("returns agents list for authorized company", async () => {
      const agents = [makeAgent(), makeAgent({ id: AGENT_ID_2, name: "Agent2" })];
      mockAgentService.list.mockResolvedValue(agents);

      const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/agents`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(mockAgentService.list).toHaveBeenCalledWith(COMPANY_ID);
    });

    it("redacts plain env vars in adapter config (no secret leaks)", async () => {
      const agent = makeAgent({
        adapterConfig: {
          cwd: "/workspace",
          env: {
            ANTHROPIC_API_KEY: "sk-ant-secret-value",
            SAFE_REF: { type: "secret_ref", secretId: "sec-1" },
            PLAIN_BINDING: { type: "plain", value: "real-secret" },
          },
        },
      });
      mockAgentService.list.mockResolvedValue([agent]);

      const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/agents`);

      expect(res.status).toBe(200);
      const returnedEnv = res.body[0].adapterConfig.env;
      // Plain string env vars should be redacted
      expect(returnedEnv.ANTHROPIC_API_KEY).toBe("***REDACTED***");
      // secret_ref bindings should be kept as-is (only reference, not value)
      expect(returnedEnv.SAFE_REF).toEqual({ type: "secret_ref", secretId: "sec-1" });
      // Plain type bindings should have value redacted
      expect(returnedEnv.PLAIN_BINDING).toEqual({ type: "plain", value: "***REDACTED***" });
    });

    it("rejects access for user not in company", async () => {
      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        `/api/companies/${COMPANY_ID}/agents`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/agents/:id", () => {
    it("returns agent with chain of command", async () => {
      const agent = makeAgent();
      mockAgentService.getById.mockResolvedValue(agent);
      mockAgentService.getChainOfCommand.mockResolvedValue([
        { id: CEO_ID, name: "CEO" },
      ]);

      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(AGENT_ID);
      expect(res.body.chainOfCommand).toEqual([{ id: CEO_ID, name: "CEO" }]);
    });

    it("returns 404 for non-existent agent", async () => {
      mockAgentService.getById.mockResolvedValue(null);

      const res = await request(createApp()).get(`/api/agents/${NONEXISTENT_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Agent not found");
    });

    it("rejects access for user not in the agent's company", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgent());

      const res = await request(createApp(OTHER_COMPANY_ACTOR)).get(
        `/api/agents/${AGENT_ID}`,
      );

      expect(res.status).toBe(403);
    });

    it("redacts env vars in the returned agent", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgent());

      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(200);
      const env = res.body.adapterConfig.env;
      expect(env.ANTHROPIC_API_KEY).toBe("***REDACTED***");
      expect(env.SAFE_REF).toEqual({ type: "secret_ref", secretId: "sec-1" });
    });
  });

  describe("PATCH /api/agents/:id", () => {
    it("updates agent and returns sanitized response", async () => {
      const existing = makeAgent();
      const updated = makeAgent({ title: "Senior Dev" });
      mockAgentService.getById.mockResolvedValue(existing);
      mockAgentService.update.mockResolvedValue(updated);

      const res = await request(createApp())
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ title: "Senior Dev" });

      expect(res.status).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        AGENT_ID,
        { title: "Senior Dev" },
        expect.objectContaining({ recordRevision: expect.any(Object) }),
      );
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 when agent does not exist", async () => {
      mockAgentService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .patch(`/api/agents/${NONEXISTENT_ID}`)
        .send({ title: "New" });

      expect(res.status).toBe(404);
    });

    it("rejects direct permission changes via PATCH", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgent());

      const res = await request(createApp())
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ permissions: { canCreateAgents: true } });

      // Schema validation rejects the `permissions` field before the handler
      expect(res.status).toBe(400);
    });

    it("rejects updates from user not in the agent's company", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgent());

      const res = await request(createApp(OTHER_COMPANY_ACTOR))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ title: "Hacked" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/agents/:id/pause", () => {
    it("pauses an agent and cancels active heartbeats", async () => {
      const agent = makeAgent({ status: "paused" });
      mockAgentService.pause.mockResolvedValue(agent);

      const res = await request(createApp()).post(`/api/agents/${AGENT_ID}/pause`);

      expect(res.status).toBe(200);
      expect(mockAgentService.pause).toHaveBeenCalledWith(AGENT_ID);
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(AGENT_ID);
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 when agent does not exist", async () => {
      mockAgentService.pause.mockResolvedValue(null);

      const res = await request(createApp()).post(`/api/agents/${NONEXISTENT_ID}/pause`);

      expect(res.status).toBe(404);
    });

    it("rejects non-board actors", async () => {
      const agentActor = {
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_ID,
      };

      const res = await request(createApp(agentActor)).post(
        `/api/agents/${AGENT_ID}/pause`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/agents/:id/resume", () => {
    it("resumes a paused agent", async () => {
      const agent = makeAgent({ status: "active" });
      mockAgentService.resume.mockResolvedValue(agent);

      const res = await request(createApp()).post(`/api/agents/${AGENT_ID}/resume`);

      expect(res.status).toBe(200);
      expect(mockAgentService.resume).toHaveBeenCalledWith(AGENT_ID);
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 404 when agent does not exist", async () => {
      mockAgentService.resume.mockResolvedValue(null);

      const res = await request(createApp()).post(`/api/agents/${NONEXISTENT_ID}/resume`);

      expect(res.status).toBe(404);
    });

    it("rejects non-board actors", async () => {
      const agentActor = {
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_ID,
      };

      const res = await request(createApp(agentActor)).post(
        `/api/agents/${AGENT_ID}/resume`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe("adapter env var redaction", () => {
    it("redacts all plain string env values in list response", async () => {
      const agent = makeAgent({
        adapterConfig: {
          env: {
            SECRET_KEY: "should-not-appear",
            ANOTHER_SECRET: { type: "plain", value: "also-secret" },
            REF: { type: "secret_ref", secretId: "ref-1" },
          },
        },
      });
      mockAgentService.list.mockResolvedValue([agent]);

      const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/agents`);

      const env = res.body[0].adapterConfig.env;
      expect(env.SECRET_KEY).toBe("***REDACTED***");
      expect(env.ANOTHER_SECRET).toEqual({ type: "plain", value: "***REDACTED***" });
      expect(env.REF).toEqual({ type: "secret_ref", secretId: "ref-1" });
    });

    it("redacts env values in single agent response", async () => {
      mockAgentService.getById.mockResolvedValue(
        makeAgent({
          adapterConfig: {
            env: { API_KEY: "super-secret" },
          },
        }),
      );

      const res = await request(createApp()).get(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.adapterConfig.env.API_KEY).toBe("***REDACTED***");
    });
  });
});
