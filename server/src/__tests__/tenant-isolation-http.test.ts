/**
 * Tenant Isolation HTTP Tests
 *
 * Comprehensive HTTP-level tests verifying that multi-tenant isolation is
 * enforced at the API layer. Every company-scoped route is tested to ensure
 * User A (member of Company A only) cannot read, mutate, or enumerate
 * Company B resources.
 *
 * These tests protect real customer data in a shared-instance deployment.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ─── Mock IDs ────────────────────────────────────────────────────────────────

const COMPANY_A_ID = randomUUID();
const COMPANY_B_ID = randomUUID();
const COMPANY_C_ID = randomUUID();

const USER_A_ID = randomUUID();
const USER_B_ID = randomUUID();
const USER_MULTI_ID = randomUUID();
const ADMIN_USER_ID = randomUUID();

const AGENT_A_ID = randomUUID();
const AGENT_B_ID = randomUUID();

const PROJECT_A_ID = randomUUID();
const PROJECT_B_ID = randomUUID();

const ISSUE_A_ID = randomUUID();
const ISSUE_B_ID = randomUUID();

const GOAL_A_ID = randomUUID();
const GOAL_B_ID = randomUUID();

const KB_PAGE_A_ID = randomUUID();
const KB_PAGE_B_ID = randomUUID();

const ROUTINE_A_ID = randomUUID();
const ROUTINE_B_ID = randomUUID();

const SECRET_A_ID = randomUUID();
const SECRET_B_ID = randomUUID();

// ─── Mock data stores ────────────────────────────────────────────────────────

const AGENTS: Record<string, any> = {
  [AGENT_A_ID]: { id: AGENT_A_ID, companyId: COMPANY_A_ID, name: "Agent A", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  [AGENT_B_ID]: { id: AGENT_B_ID, companyId: COMPANY_B_ID, name: "Agent B", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
};

const PROJECTS: Record<string, any> = {
  [PROJECT_A_ID]: { id: PROJECT_A_ID, companyId: COMPANY_A_ID, name: "Project A", status: "in_progress" },
  [PROJECT_B_ID]: { id: PROJECT_B_ID, companyId: COMPANY_B_ID, name: "Project B", status: "in_progress" },
};

const ISSUES: Record<string, any> = {
  [ISSUE_A_ID]: { id: ISSUE_A_ID, companyId: COMPANY_A_ID, identifier: "CA-1", title: "Issue A", status: "backlog", goalId: null },
  [ISSUE_B_ID]: { id: ISSUE_B_ID, companyId: COMPANY_B_ID, identifier: "CB-1", title: "Issue B", status: "backlog", goalId: null },
};

const GOALS: Record<string, any> = {
  [GOAL_A_ID]: { id: GOAL_A_ID, companyId: COMPANY_A_ID, title: "Goal A", status: "active" },
  [GOAL_B_ID]: { id: GOAL_B_ID, companyId: COMPANY_B_ID, title: "Goal B", status: "active" },
};

const KB_PAGES: Record<string, any> = {
  [KB_PAGE_A_ID]: { id: KB_PAGE_A_ID, companyId: COMPANY_A_ID, title: "KB A", slug: "kb-a", body: "Page A" },
  [KB_PAGE_B_ID]: { id: KB_PAGE_B_ID, companyId: COMPANY_B_ID, title: "KB B", slug: "kb-b", body: "Page B" },
};

const ROUTINES: Record<string, any> = {
  [ROUTINE_A_ID]: { id: ROUTINE_A_ID, companyId: COMPANY_A_ID, title: "Routine A", assigneeAgentId: AGENT_A_ID, triggers: [], recentRuns: [] },
  [ROUTINE_B_ID]: { id: ROUTINE_B_ID, companyId: COMPANY_B_ID, title: "Routine B", assigneeAgentId: AGENT_B_ID, triggers: [], recentRuns: [] },
};

const SECRETS: Record<string, any> = {
  [SECRET_A_ID]: { id: SECRET_A_ID, companyId: COMPANY_A_ID, name: "API_KEY_A", provider: "local_encrypted" },
  [SECRET_B_ID]: { id: SECRET_B_ID, companyId: COMPANY_B_ID, name: "API_KEY_B", provider: "local_encrypted" },
};

// ─── Service mocks ───────────────────────────────────────────────────────────

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(AGENTS).filter((a: any) => a.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => AGENTS[id] ?? null),
  create: vi.fn(),
  update: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  getAccessState: vi.fn().mockResolvedValue({ permissions: [], membership: null }),
  listKeys: vi.fn().mockResolvedValue([]),
}));

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(PROJECTS).filter((p: any) => p.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => PROJECTS[id] ?? null),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listByIds: vi.fn().mockResolvedValue([]),
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(ISSUES).filter((i: any) => i.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => ISSUES[id] ?? null),
  getByIdentifier: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockImplementation((_companyId: string, data: any) => ({
    id: randomUUID(),
    ...data,
    companyId: _companyId,
    status: "backlog",
  })),
  update: vi.fn(),
  remove: vi.fn(),
  getAncestors: vi.fn().mockResolvedValue([]),
  findMentionedProjectIds: vi.fn().mockResolvedValue([]),
}));

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(GOALS).filter((g: any) => g.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => GOALS[id] ?? null),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getDefaultCompanyGoal: vi.fn().mockResolvedValue(null),
}));

const mockKnowledgeService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(KB_PAGES).filter((p: any) => p.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => KB_PAGES[id] ?? null),
  getBySlug: vi.fn(),
  create: vi.fn().mockImplementation((companyId: string, data: any) => ({
    id: randomUUID(),
    companyId,
    ...data,
    slug: data.title.toLowerCase().replace(/\s+/g, "-"),
  })),
  update: vi.fn(),
  remove: vi.fn(),
  seedDefaults: vi.fn(),
  listRevisions: vi.fn().mockResolvedValue([]),
  getRevision: vi.fn(),
  revertToRevision: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(ROUTINES).filter((r: any) => r.companyId === companyId),
  ),
  getDetail: vi.fn().mockImplementation((id: string) => ROUTINES[id] ?? null),
  create: vi.fn(),
  update: vi.fn(),
  seedDefaults: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) =>
    Object.values(SECRETS).filter((s: any) => s.companyId === companyId),
  ),
  getById: vi.fn().mockImplementation((id: string) => SECRETS[id] ?? null),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  listProviders: vi.fn().mockReturnValue([]),
}));

const mockCostService = vi.hoisted(() => ({
  summary: vi.fn().mockResolvedValue({}),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  createEvent: vi.fn(),
}));

const mockFinanceService = vi.hoisted(() => ({
  summary: vi.fn().mockResolvedValue({}),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  createEvent: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((filters: any) => []),
  create: vi.fn(),
  forIssue: vi.fn().mockResolvedValue([]),
  runsForIssue: vi.fn().mockResolvedValue([]),
  issuesForRun: vi.fn().mockResolvedValue([]),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn().mockResolvedValue(true),
  ensureMembership: vi.fn(),
  setMemberPermissions: vi.fn(),
  setPrincipalPermission: vi.fn(),
  listMembers: vi.fn().mockResolvedValue([]),
  listPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: vi.fn().mockResolvedValue(false),
  getMembership: vi.fn().mockResolvedValue(null),
  listPrincipalPermissions: vi.fn().mockResolvedValue([]),
  listPrincipalGrants: vi.fn().mockResolvedValue([]),
}));

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  stats: vi.fn().mockResolvedValue({}),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn().mockImplementation((companyId: string) => []),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  scan: vi.fn(),
  import: vi.fn(),
  getFile: vi.fn(),
  updateFile: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  approvalService: () => ({
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addComment: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
  }),
  assetService: () => ({}),
  budgetService: () => ({ upsertPolicy: vi.fn(), getPolicy: vi.fn(), listPolicies: vi.fn().mockResolvedValue([]), listIncidents: vi.fn().mockResolvedValue([]), resolveIncident: vi.fn() }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  companyService: () => mockCompanyService,
  companySkillService: () => mockCompanySkillService,
  costService: () => mockCostService,
  dashboardService: () => ({ getSummary: vi.fn().mockResolvedValue({}) }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn().mockResolvedValue({}) }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  financeService: () => mockFinanceService,
  goalService: () => mockGoalService,
  heartbeatService: () => ({
    cancelBudgetScopeWork: vi.fn(),
    wakeup: vi.fn(),
    getActiveRun: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
  }),
  instanceSettingsService: () => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn() }),
  issueApprovalService: () => ({
    list: vi.fn().mockResolvedValue([]),
    link: vi.fn(),
    unlink: vi.fn(),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  playbookService: () => ({ seedDefaults: vi.fn(), list: vi.fn().mockResolvedValue([]) }),
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  secretService: () => mockSecretService,
  sidebarBadgeService: () => ({ getBadges: vi.fn().mockResolvedValue({}) }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workProductService: () => ({
    listForIssue: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/knowledge.js", () => ({
  knowledgeService: () => mockKnowledgeService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/equivalent-spend.js", () => ({
  calculateTotalEquivalentSpend: vi.fn().mockReturnValue(0),
  getRateCard: vi.fn().mockReturnValue({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

vi.mock("../services/playbook-execution.js", () => ({
  playbookExecutionService: () => ({ execute: vi.fn() }),
  ensureLibraryAgentFolder: vi.fn(),
}));

vi.mock("../services/goal-progress.js", () => ({
  recalculateGoalProgress: vi.fn(),
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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn() }),
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

// ─── App builder ─────────────────────────────────────────────────────────────

type ActorOverrides = Record<string, unknown>;

async function createApp(actor: ActorOverrides) {
  const { companyRoutes } = await import("../routes/companies.js");
  const { agentRoutes } = await import("../routes/agents.js");
  const { projectRoutes } = await import("../routes/projects.js");
  const { issueRoutes } = await import("../routes/issues.js");
  const { goalRoutes } = await import("../routes/goals.js");
  const { secretRoutes } = await import("../routes/secrets.js");
  const { costRoutes } = await import("../routes/costs.js");
  const { activityRoutes } = await import("../routes/activity.js");
  const { routineRoutes } = await import("../routes/routines.js");
  const { knowledgeRoutes } = await import("../routes/knowledge.js");
  const { companySkillRoutes } = await import("../routes/company-skills.js");
  const { errorHandler } = await import("../middleware/index.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  const fakeDb = {} as any;
  const fakeStorage = {
    putFile: vi.fn(),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn().mockResolvedValue([]),
    getSignedUrl: vi.fn(),
  } as any;

  app.use("/api/companies", companyRoutes(fakeDb, fakeStorage));
  app.use("/api", agentRoutes(fakeDb));
  app.use("/api", projectRoutes(fakeDb));
  app.use("/api", issueRoutes(fakeDb, fakeStorage));
  app.use("/api", goalRoutes(fakeDb));
  app.use("/api", secretRoutes(fakeDb));
  app.use("/api", costRoutes(fakeDb));
  app.use("/api", activityRoutes(fakeDb));
  app.use("/api", routineRoutes(fakeDb));
  app.use("/api", knowledgeRoutes(fakeDb));
  app.use("/api", companySkillRoutes(fakeDb));
  app.use(errorHandler);

  return app;
}

// ─── Actor factories ─────────────────────────────────────────────────────────

function boardUser(userId: string, companyIds: string[]) {
  return {
    type: "board",
    userId,
    companyIds,
    isInstanceAdmin: false,
    source: "session",
  };
}

function instanceAdmin(userId: string) {
  return {
    type: "board",
    userId,
    companyIds: [],
    isInstanceAdmin: true,
    source: "session",
  };
}

function agentActor(agentId: string, companyId: string) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: randomUUID(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Tenant Isolation — HTTP-level cross-company access", () => {
  let appA: express.Express;
  let appB: express.Express;
  let appMulti: express.Express;
  let appAdmin: express.Express;
  let appAgentA: express.Express;
  let appAgentB: express.Express;

  beforeAll(async () => {
    appA = await createApp(boardUser(USER_A_ID, [COMPANY_A_ID]));
    appB = await createApp(boardUser(USER_B_ID, [COMPANY_B_ID]));
    appMulti = await createApp(boardUser(USER_MULTI_ID, [COMPANY_A_ID, COMPANY_B_ID]));
    appAdmin = await createApp(instanceAdmin(ADMIN_USER_ID));
    appAgentA = await createApp(agentActor(AGENT_A_ID, COMPANY_A_ID));
    appAgentB = await createApp(agentActor(AGENT_B_ID, COMPANY_B_ID));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Company-scoped LIST endpoints — User A cannot list Company B resources
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Company-scoped GET list endpoints", () => {
    const listEndpoints = [
      { path: "agents", label: "agents" },
      { path: "issues", label: "issues" },
      { path: "projects", label: "projects" },
      { path: "goals", label: "goals" },
      { path: "knowledge", label: "knowledge" },
      { path: "routines", label: "routines" },
      { path: "costs/summary", label: "costs summary" },
      { path: "activity", label: "activity" },
      { path: "secrets", label: "secrets" },
      { path: "org", label: "org chart" },
    ];

    for (const { path, label } of listEndpoints) {
      it(`User A cannot list Company B ${label} (GET /companies/:companyB/${path})`, async () => {
        const res = await request(appA)
          .get(`/api/companies/${COMPANY_B_ID}/${path}`)
          .expect((r) => {
            expect([401, 403]).toContain(r.status);
          });
        expect(res.body.error).toMatch(/access|forbidden|unauthorized/i);
      });

      it(`User B cannot list Company A ${label} (GET /companies/:companyA/${path})`, async () => {
        const res = await request(appB)
          .get(`/api/companies/${COMPANY_A_ID}/${path}`)
          .expect((r) => {
            expect([401, 403]).toContain(r.status);
          });
        expect(res.body.error).toMatch(/access|forbidden|unauthorized/i);
      });
    }

    it("User A CAN list Company A agents", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/agents`)
        .expect(200);
      const ids = res.body.map((a: any) => a.id);
      expect(ids).toContain(AGENT_A_ID);
      expect(ids).not.toContain(AGENT_B_ID);
    });

    it("User A CAN list Company A issues", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/issues`)
        .expect(200);
      const ids = res.body.map((i: any) => i.id);
      expect(ids).toContain(ISSUE_A_ID);
      expect(ids).not.toContain(ISSUE_B_ID);
    });

    it("User A CAN list Company A projects", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/projects`)
        .expect(200);
      const ids = res.body.map((p: any) => p.id);
      expect(ids).toContain(PROJECT_A_ID);
      expect(ids).not.toContain(PROJECT_B_ID);
    });

    it("User A CAN list Company A goals", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/goals`)
        .expect(200);
      const ids = res.body.map((g: any) => g.id);
      expect(ids).toContain(GOAL_A_ID);
      expect(ids).not.toContain(GOAL_B_ID);
    });

    it("User A CAN list Company A knowledge pages", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/knowledge`)
        .expect(200);
      const ids = res.body.map((p: any) => p.id);
      expect(ids).toContain(KB_PAGE_A_ID);
      expect(ids).not.toContain(KB_PAGE_B_ID);
    });

    it("User A CAN list Company A routines", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/routines`)
        .expect(200);
      const ids = res.body.map((r: any) => r.id);
      expect(ids).toContain(ROUTINE_A_ID);
      expect(ids).not.toContain(ROUTINE_B_ID);
    });

    it("User A CAN list Company A secrets", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/secrets`)
        .expect(200);
      const ids = res.body.map((s: any) => s.id);
      expect(ids).toContain(SECRET_A_ID);
      expect(ids).not.toContain(SECRET_B_ID);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Resource-by-ID endpoints — ID guessing attack prevention
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Resource-by-ID GET endpoints (ID guessing attack)", () => {
    it("User A cannot access Company B agent by ID", async () => {
      const res = await request(appA).get(`/api/agents/${AGENT_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B issue by ID", async () => {
      const res = await request(appA).get(`/api/issues/${ISSUE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B project by ID", async () => {
      const res = await request(appA).get(`/api/projects/${PROJECT_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B goal by ID", async () => {
      const res = await request(appA).get(`/api/goals/${GOAL_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B KB page by ID", async () => {
      const res = await request(appA).get(`/api/knowledge/${KB_PAGE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B routine by ID", async () => {
      const res = await request(appA).get(`/api/routines/${ROUTINE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A CAN access Company A agent by ID", async () => {
      const res = await request(appA).get(`/api/agents/${AGENT_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(AGENT_A_ID);
    });

    it("User A CAN access Company A issue by ID", async () => {
      const res = await request(appA).get(`/api/issues/${ISSUE_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(ISSUE_A_ID);
    });

    it("User A CAN access Company A project by ID", async () => {
      const res = await request(appA).get(`/api/projects/${PROJECT_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(PROJECT_A_ID);
    });

    it("User A CAN access Company A goal by ID", async () => {
      const res = await request(appA).get(`/api/goals/${GOAL_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(GOAL_A_ID);
    });

    it("User A CAN access Company A KB page by ID", async () => {
      const res = await request(appA).get(`/api/knowledge/${KB_PAGE_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(KB_PAGE_A_ID);
    });

    it("User A CAN access Company A routine by ID", async () => {
      const res = await request(appA).get(`/api/routines/${ROUTINE_A_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(ROUTINE_A_ID);
    });

    it("Non-existent resource IDs return 404", async () => {
      const fakeId = randomUUID();
      const endpoints = [
        `/api/agents/${fakeId}`,
        `/api/issues/${fakeId}`,
        `/api/projects/${fakeId}`,
        `/api/goals/${fakeId}`,
        `/api/knowledge/${fakeId}`,
        `/api/routines/${fakeId}`,
      ];
      for (const endpoint of endpoints) {
        const res = await request(appA).get(endpoint);
        expect(res.status).toBe(404);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Mutation endpoints — cross-tenant writes blocked
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Mutation endpoints (POST/PATCH/DELETE) — cross-tenant writes", () => {
    it("User A cannot create an issue in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/issues`)
        .send({ title: "Cross-tenant issue", status: "backlog" });
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot create a project in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/projects`)
        .send({ name: "Cross-tenant project" });
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot create a goal in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/goals`)
        .send({ title: "Cross-tenant goal" });
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot create a KB page in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/knowledge`)
        .send({ title: "Cross-tenant KB page", body: "Stolen data" });
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot create a secret in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/secrets`)
        .send({ name: "STOLEN_KEY", value: "secret123" });
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot update Company B's agent", async () => {
      const res = await request(appA)
        .patch(`/api/agents/${AGENT_B_ID}`)
        .send({ name: "Hijacked Agent" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot update Company B's issue", async () => {
      const res = await request(appA)
        .patch(`/api/issues/${ISSUE_B_ID}`)
        .send({ title: "Hijacked Issue" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot update Company B's project", async () => {
      const res = await request(appA)
        .patch(`/api/projects/${PROJECT_B_ID}`)
        .send({ name: "Hijacked Project" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot update Company B's goal", async () => {
      const res = await request(appA)
        .patch(`/api/goals/${GOAL_B_ID}`)
        .send({ title: "Hijacked Goal" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot update Company B's KB page", async () => {
      const res = await request(appA)
        .patch(`/api/knowledge/${KB_PAGE_B_ID}`)
        .send({ title: "Hijacked KB" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot delete Company B's issue", async () => {
      const res = await request(appA)
        .delete(`/api/issues/${ISSUE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot delete Company B's project", async () => {
      const res = await request(appA)
        .delete(`/api/projects/${PROJECT_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot delete Company B's goal", async () => {
      const res = await request(appA)
        .delete(`/api/goals/${GOAL_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot delete Company B's KB page", async () => {
      const res = await request(appA)
        .delete(`/api/knowledge/${KB_PAGE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot delete Company B's secret", async () => {
      const res = await request(appA)
        .delete(`/api/secrets/${SECRET_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot rotate Company B's secret", async () => {
      const res = await request(appA)
        .post(`/api/secrets/${SECRET_B_ID}/rotate`)
        .send({ value: "new-secret-value" });
      expect([403, 404]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Agent API key isolation — agent from Company A cannot hit Company B
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Agent API key cross-company isolation", () => {
    it("Agent A key cannot list Company B agents", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/agents`);
      expect([401, 403]).toContain(res.status);
      expect(res.body.error).toMatch(/agent key cannot access another company/i);
    });

    it("Agent A key cannot list Company B issues", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/issues`);
      expect([401, 403]).toContain(res.status);
    });

    it("Agent A key cannot list Company B projects", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/projects`);
      expect([401, 403]).toContain(res.status);
    });

    it("Agent A key cannot list Company B goals", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/goals`);
      expect([401, 403]).toContain(res.status);
    });

    it("Agent A key cannot list Company B knowledge", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/knowledge`);
      expect([401, 403]).toContain(res.status);
    });

    it("Agent A key cannot access Company B agent by ID", async () => {
      const res = await request(appAgentA)
        .get(`/api/agents/${AGENT_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("Agent A key cannot access Company B issue by ID", async () => {
      const res = await request(appAgentA)
        .get(`/api/issues/${ISSUE_B_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("Agent A key CAN access its own company's agents", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_A_ID}/agents`);
      expect(res.status).toBe(200);
    });

    it("Agent A key CAN access its own company's issues", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_A_ID}/issues`);
      expect(res.status).toBe(200);
    });

    it("Agent B key cannot access Company A resources", async () => {
      const res = await request(appAgentB)
        .get(`/api/companies/${COMPANY_A_ID}/agents`);
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Multi-company user can access both companies
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-company user valid access", () => {
    it("Multi-company user CAN list Company A agents", async () => {
      const res = await request(appMulti)
        .get(`/api/companies/${COMPANY_A_ID}/agents`)
        .expect(200);
      expect(res.body.map((a: any) => a.id)).toContain(AGENT_A_ID);
    });

    it("Multi-company user CAN list Company B agents", async () => {
      const res = await request(appMulti)
        .get(`/api/companies/${COMPANY_B_ID}/agents`)
        .expect(200);
      expect(res.body.map((a: any) => a.id)).toContain(AGENT_B_ID);
    });

    it("Multi-company user CAN access Company A agent by ID", async () => {
      const res = await request(appMulti)
        .get(`/api/agents/${AGENT_A_ID}`)
        .expect(200);
      expect(res.body.id).toBe(AGENT_A_ID);
    });

    it("Multi-company user CAN access Company B agent by ID", async () => {
      const res = await request(appMulti)
        .get(`/api/agents/${AGENT_B_ID}`)
        .expect(200);
      expect(res.body.id).toBe(AGENT_B_ID);
    });

    it("Multi-company user CANNOT access Company C (not a member)", async () => {
      const res = await request(appMulti)
        .get(`/api/companies/${COMPANY_C_ID}/agents`);
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Instance admin can access any company
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Instance admin bypasses company scoping", () => {
    it("Instance admin CAN list Company A agents", async () => {
      const res = await request(appAdmin)
        .get(`/api/companies/${COMPANY_A_ID}/agents`)
        .expect(200);
      expect(res.body.map((a: any) => a.id)).toContain(AGENT_A_ID);
    });

    it("Instance admin CAN list Company B agents", async () => {
      const res = await request(appAdmin)
        .get(`/api/companies/${COMPANY_B_ID}/agents`)
        .expect(200);
      expect(res.body.map((a: any) => a.id)).toContain(AGENT_B_ID);
    });

    it("Instance admin CAN access Company B agent by ID", async () => {
      const res = await request(appAdmin)
        .get(`/api/agents/${AGENT_B_ID}`)
        .expect(200);
      expect(res.body.id).toBe(AGENT_B_ID);
    });

    it("Instance admin CAN list Company A issues", async () => {
      const res = await request(appAdmin)
        .get(`/api/companies/${COMPANY_A_ID}/issues`)
        .expect(200);
    });

    it("Instance admin CAN list Company B goals", async () => {
      const res = await request(appAdmin)
        .get(`/api/companies/${COMPANY_B_ID}/goals`)
        .expect(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Empty/revoked membership blocks access
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Empty or revoked membership", () => {
    it("User with empty companyIds cannot access any company", async () => {
      const appEmpty = await createApp(boardUser(randomUUID(), []));
      const res = await request(appEmpty)
        .get(`/api/companies/${COMPANY_A_ID}/agents`);
      expect([401, 403]).toContain(res.status);
    });

    it("User with no matching companyId cannot access Company A", async () => {
      const otherCompanyId = randomUUID();
      const appOther = await createApp(boardUser(randomUUID(), [otherCompanyId]));
      const res = await request(appOther)
        .get(`/api/companies/${COMPANY_A_ID}/agents`);
      expect([401, 403]).toContain(res.status);
    });

    it("User with no matching companyId cannot access Company B", async () => {
      const otherCompanyId = randomUUID();
      const appOther = await createApp(boardUser(randomUUID(), [otherCompanyId]));
      const res = await request(appOther)
        .get(`/api/companies/${COMPANY_B_ID}/issues`);
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Data leak detection — response body contains only authorized data
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Data leak detection — response only contains authorized data", () => {
    it("Company A agents list contains zero Company B agent IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/agents`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(AGENT_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A issues list contains zero Company B issue IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/issues`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(ISSUE_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A projects list contains zero Company B project IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/projects`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PROJECT_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A goals list contains zero Company B goal IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/goals`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(GOAL_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A KB list contains zero Company B KB IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/knowledge`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(KB_PAGE_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A routines list contains zero Company B routine IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/routines`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(ROUTINE_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Company A secrets list contains zero Company B secret IDs", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}/secrets`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(SECRET_B_ID);
      expect(body).not.toContain(COMPANY_B_ID);
    });

    it("Agent detail for Company A agent does not leak Company B data", async () => {
      const res = await request(appA)
        .get(`/api/agents/${AGENT_A_ID}`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(COMPANY_B_ID);
      expect(body).not.toContain(AGENT_B_ID);
    });

    it("Issue detail for Company A issue does not leak Company B data", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_A_ID}`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(COMPANY_B_ID);
      expect(body).not.toContain(ISSUE_B_ID);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Cost/Finance endpoint isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cost and finance endpoint isolation", () => {
    const costPaths = [
      "costs/summary",
      "costs/by-agent",
      "costs/by-agent-model",
      "costs/by-provider",
      "costs/by-biller",
      "costs/finance-summary",
      "costs/finance-by-biller",
      "costs/finance-by-kind",
    ];

    for (const path of costPaths) {
      it(`User A cannot access Company B ${path}`, async () => {
        const res = await request(appA)
          .get(`/api/companies/${COMPANY_B_ID}/${path}`);
        expect([401, 403]).toContain(res.status);
      });
    }

    it("User A cannot post cost events to Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/cost-events`)
        .send({
          agentId: AGENT_B_ID,
          model: "gpt-4",
          provider: "openai",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
          occurredAt: new Date().toISOString(),
        });
      // 400 (validation before authz) or 403 both prevent data access
      expect([400, 401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Activity log isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Activity log cross-tenant isolation", () => {
    it("User A cannot read Company B activity", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_B_ID}/activity`);
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot access Company B issue activity by ID", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/activity`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot access Company B issue runs by ID", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/runs`);
      expect([403, 404]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. Secret isolation (board-only routes)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Secret management cross-tenant isolation", () => {
    it("User A cannot list Company B secret providers", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_B_ID}/secret-providers`);
      expect([401, 403]).toContain(res.status);
    });

    it("User A cannot update Company B's secret", async () => {
      const res = await request(appA)
        .patch(`/api/secrets/${SECRET_B_ID}`)
        .send({ name: "HIJACKED_KEY" });
      expect([403, 404]).toContain(res.status);
    });

    it("Agent A cannot list Company B secrets (agents blocked from secrets)", async () => {
      const res = await request(appAgentA)
        .get(`/api/companies/${COMPANY_B_ID}/secrets`);
      // Agents should hit either the agent-company check (403) or the board-only check (403)
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. Issue sub-resource isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Issue sub-resource cross-tenant isolation", () => {
    it("User A cannot list Company B issue comments", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/comments`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot post comments on Company B issue", async () => {
      const res = await request(appA)
        .post(`/api/issues/${ISSUE_B_ID}/comments`)
        .send({ body: "Cross-tenant comment" });
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot list Company B issue work products", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/work-products`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot list Company B issue documents", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/documents`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot list Company B issue approvals", async () => {
      const res = await request(appA)
        .get(`/api/issues/${ISSUE_B_ID}/approvals`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot checkout Company B issue", async () => {
      const res = await request(appA)
        .post(`/api/issues/${ISSUE_B_ID}/checkout`)
        .send({ agentId: AGENT_A_ID });
      // 400 (validation before authz) or 403/404 all prevent cross-tenant access
      expect([400, 403, 404]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. Knowledge sub-resource isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Knowledge sub-resource cross-tenant isolation", () => {
    it("User A cannot list Company B KB page revisions", async () => {
      const res = await request(appA)
        .get(`/api/knowledge/${KB_PAGE_B_ID}/revisions`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot revert Company B KB page revision", async () => {
      const res = await request(appA)
        .post(`/api/knowledge/${KB_PAGE_B_ID}/revisions/1/revert`);
      expect([403, 404]).toContain(res.status);
    });

    it("User A cannot seed KB in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/knowledge/seed`);
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. Routine sub-resource isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Routine sub-resource cross-tenant isolation", () => {
    it("User A cannot seed routines in Company B", async () => {
      const res = await request(appA)
        .post(`/api/companies/${COMPANY_B_ID}/routines/seed`);
      expect([401, 403]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. Company-level isolation (company detail endpoint)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Company detail endpoint isolation", () => {
    it("User A cannot read Company B detail", async () => {
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_B_ID}`);
      expect([401, 403]).toContain(res.status);
    });

    it("User A CAN read Company A detail", async () => {
      mockCompanyService.getById.mockResolvedValueOnce({
        id: COMPANY_A_ID,
        name: "Company A",
      });
      const res = await request(appA)
        .get(`/api/companies/${COMPANY_A_ID}`);
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. Symmetry check — User B blocked from Company A (reverse direction)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Symmetry — User B blocked from Company A resources", () => {
    it("User B cannot access Company A agent by ID", async () => {
      const res = await request(appB).get(`/api/agents/${AGENT_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User B cannot access Company A issue by ID", async () => {
      const res = await request(appB).get(`/api/issues/${ISSUE_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User B cannot access Company A project by ID", async () => {
      const res = await request(appB).get(`/api/projects/${PROJECT_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User B cannot access Company A goal by ID", async () => {
      const res = await request(appB).get(`/api/goals/${GOAL_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User B cannot access Company A KB page by ID", async () => {
      const res = await request(appB).get(`/api/knowledge/${KB_PAGE_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });

    it("User B cannot create an issue in Company A", async () => {
      const res = await request(appB)
        .post(`/api/companies/${COMPANY_A_ID}/issues`)
        .send({ title: "Reverse cross-tenant issue", status: "backlog" });
      expect([401, 403]).toContain(res.status);
    });

    it("User B cannot delete Company A's goal", async () => {
      const res = await request(appB)
        .delete(`/api/goals/${GOAL_A_ID}`);
      expect([403, 404]).toContain(res.status);
    });
  });
});
