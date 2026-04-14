import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock data ───────────────────────────────────────────────────────────────

const COMPANY_ID = randomUUID();
const USER_ID = randomUUID();
const AGENT_ID = randomUUID();

const MOCK_AGENT = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  name: "Test Agent",
  role: "engineer",
  title: "Software Engineer",
  status: "active",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  shortName: "test-agent",
};

// ── Service mocks ───────────────────────────────────────────────────────────

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  getAccessState: vi.fn().mockResolvedValue({ permissions: [], membership: null }),
  listKeys: vi.fn().mockResolvedValue([]),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn().mockResolvedValue(true),
  ensureMembership: vi.fn(),
  setMemberPermissions: vi.fn(),
  setPrincipalPermission: vi.fn(),
  listMembers: vi.fn().mockResolvedValue([]),
  listPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: vi.fn().mockResolvedValue(true),
  getMembership: vi.fn().mockResolvedValue(null),
  listPrincipalPermissions: vi.fn().mockResolvedValue([]),
  listPrincipalGrants: vi.fn().mockResolvedValue([]),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({ getBundle: vi.fn(), updateBundle: vi.fn(), listFiles: vi.fn().mockResolvedValue([]) }),
  approvalService: () => ({ list: vi.fn().mockResolvedValue([]) }),
  budgetService: () => ({ upsertPolicy: vi.fn(), getPolicy: vi.fn(), listPolicies: vi.fn().mockResolvedValue([]), listIncidents: vi.fn().mockResolvedValue([]), resolveIncident: vi.fn() }),
  companySkillService: () => ({ list: vi.fn().mockResolvedValue([]), scan: vi.fn() }),
  heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn(), cancelActiveForAgent: vi.fn(), wakeup: vi.fn(), getActiveRun: vi.fn(), listRuns: vi.fn().mockResolvedValue([]) }),
  issueApprovalService: () => ({ list: vi.fn().mockResolvedValue([]) }),
  issueService: () => ({ list: vi.fn().mockResolvedValue([]) }),
  logActivity: mockLogActivity,
  secretService: () => ({ list: vi.fn().mockResolvedValue([]) }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
  createAgentWorkspace: vi.fn(),
  archiveAgentWorkspace: vi.fn(),
  createHiringRecord: vi.fn(),
  createTerminationRecord: vi.fn(),
  createEmploymentHistoryEntry: vi.fn(),
  buildOnboardingPacket: vi.fn().mockResolvedValue({}),
  deduplicateAgentName: vi.fn().mockImplementation((_db: any, _cid: any, name: string) => name),
  notifyHireApproved: vi.fn(),
  boardAuthService: () => ({ getSession: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/performance-score.js", () => ({
  onboardingMetrics: vi.fn().mockResolvedValue({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../redaction.js", () => ({
  redactEventPayload: vi.fn((x: any) => x),
  sanitizeRecord: vi.fn((x: any) => x),
}));

vi.mock("../log-redaction.js", () => ({
  redactCurrentUserValue: vi.fn((x: any) => x),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@ironworksai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@ironworksai/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "codex-mini",
}));

vi.mock("@ironworksai/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "cursor-small",
}));

vi.mock("@ironworksai/adapter-gemini-local", () => ({
  DEFAULT_GEMINI_LOCAL_MODEL: "gemini-2.5-flash",
}));

vi.mock("@ironworksai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: vi.fn(),
  resolveDefaultAgentInstructionsBundleRole: vi.fn(),
}));

vi.mock("@ironworksai/adapter-utils/server-utils", () => ({
  readIronworksSkillSyncPreference: vi.fn(),
  writeIronworksSkillSyncPreference: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn() }),
}));

vi.mock("../services/channels.js", () => ({
  autoJoinAgentChannels: vi.fn(),
  findCompanyChannel: vi.fn().mockResolvedValue(null),
  postMessage: vi.fn(),
}));

vi.mock("../services/prompt-versions.js", () => ({
  listVersions: vi.fn().mockResolvedValue([]),
  rollback: vi.fn(),
  snapshotPromptVersion: vi.fn(),
}));

vi.mock("../services/playbook-execution.js", () => ({
  playbookExecutionService: () => ({ execute: vi.fn() }),
  ensureLibraryAgentFolder: vi.fn(),
}));

// ── App builder ─────────────────────────────────────────────────────────────

async function createApp(actor: Record<string, unknown>) {
  const { agentRoutes } = await import("../routes/agents.js");
  const { errorHandler } = await import("../middleware/error-handler.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const fakeDb = {} as any;
  app.use("/api", agentRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

function boardUser(userId: string, companyIds: string[]) {
  return { type: "board", userId, companyIds, isInstanceAdmin: false, source: "session" };
}

function noActor() {
  return { type: "none" };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("agent routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.list.mockResolvedValue([MOCK_AGENT]);
    mockAgentService.getById.mockResolvedValue(MOCK_AGENT);
  });

  describe("GET /api/companies/:companyId/agents", () => {
    it("lists agents for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ name: "Test Agent", status: "active" });
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = await createApp(noActor());
      const res = await request(app).get(`/api/companies/${COMPANY_ID}/agents`);
      expect(res.status).toBe(401);
    });

    it("rejects cross-company access with 403", async () => {
      const otherCompany = randomUUID();
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/companies/${otherCompany}/agents`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/agents/:id", () => {
    it("returns agent by ID for authorized user", async () => {
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: AGENT_ID, name: "Test Agent" });
    });

    it("returns 404 for non-existent agent", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).get(`/api/agents/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/agents/:id/pause", () => {
    it("pauses an active agent", async () => {
      mockAgentService.pause.mockResolvedValue({ ...MOCK_AGENT, status: "paused" });
      const app = await createApp(boardUser(USER_ID, [COMPANY_ID]));
      const res = await request(app).post(`/api/agents/${AGENT_ID}/pause`);

      expect(res.status).toBe(200);
      expect(mockAgentService.pause).toHaveBeenCalled();
    });

    it("rejects unauthenticated pause request with 403", async () => {
      // Route uses assertBoard which throws forbidden (403) for non-board actors
      // (including no-actor "none" type).
      const app = await createApp(noActor());
      const res = await request(app).post(`/api/agents/${AGENT_ID}/pause`);
      expect(res.status).toBe(403);
    });
  });
});
