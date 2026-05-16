import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { getDefaultSkillsForRole } from "../services/role-skill-defaults.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
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

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => ({})),
  findActiveServerAdapter: vi.fn(() => null),
  requireServerAdapter: vi.fn(() => ({})),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CEO_AGENT_ID = "ceo-00000000-0000-4000-8000-000000000001";
const COMPANY_ID = "company-1";

function makeCeoAgent() {
  return {
    id: CEO_AGENT_ID,
    companyId: COMPANY_ID,
    name: "CEO",
    urlKey: "ceo",
    role: "ceo",
    title: "Chief Executive Officer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: { canCreateAgents: true },
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCreatedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "new-agent-0000-0000-4000-8000-000000000002",
    companyId: COMPANY_ID,
    name: "Engineer",
    urlKey: "engineer",
    role: "engineer",
    title: "Engineer",
    status: "idle",
    reportsTo: CEO_AGENT_ID,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: null,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          { id: COMPANY_ID, requireBoardApprovalForNewAgents: false },
        ]),
      })),
    })),
  };
}

/** Create app with CEO agent as the authenticated actor. */
function createAgentApp(db: Record<string, unknown> = createDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: CEO_AGENT_ID,
      companyId: COMPANY_ID,
      companyIds: [COMPANY_ID],
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

/** Create app with board user as the authenticated actor. */
function createBoardApp(db: Record<string, unknown> = createDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CEO agent hire — auto-assign skills by role", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue(null);

    // CEO agent is the authenticated actor for most tests
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === CEO_AGENT_ID) return makeCeoAgent();
      return null;
    });
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: null,
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => makeCreatedAgent(input),
    );
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...makeCreatedAgent(),
        ...patch,
      }),
    );

    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: {} },
    });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);

    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown>) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
        },
      }),
    );
  });

  it("auto-assigns default skills when CEO hires an engineer without explicit desiredSkills", async () => {
    const expectedSkills = getDefaultSkillsForRole("engineer");
    expect(expectedSkills.length).toBeGreaterThan(0);

    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Backend Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        // no desiredSkills
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // resolveRequestedSkillKeys should have been called with the role defaults
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith(
      COMPANY_ID,
      expectedSkills,
    );
  });

  it("logs autoAssignedSkills: true in activity when role defaults are applied", async () => {
    await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Backend Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    const hireActivityCall = mockLogActivity.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.action === "agent.hire_created",
    );
    expect(hireActivityCall).toBeDefined();
    const details = (hireActivityCall![1] as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.autoAssignedSkills).toBe(true);
  });

  it("does NOT auto-assign skills when explicit desiredSkills are provided", async () => {
    const explicitSkills = ["my-custom-skill"];

    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Backend Engineer",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: explicitSkills,
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Should use the explicit skills, not the role defaults
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith(
      COMPANY_ID,
      explicitSkills,
    );

    const hireActivityCall = mockLogActivity.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.action === "agent.hire_created",
    );
    const details = (hireActivityCall![1] as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.autoAssignedSkills).toBe(false);
  });

  it("does NOT auto-assign skills when a board user creates an agent-hire", async () => {
    const res = await request(createBoardApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Backend Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Board user → assertCanCreateAgentsForCompany returns null → no auto-assign
    // resolveRequestedSkillKeys should NOT have been called (no skills at all)
    expect(mockCompanySkillService.resolveRequestedSkillKeys).not.toHaveBeenCalled();
  });

  it("does NOT auto-assign skills for roles without defaults (general)", async () => {
    const defaults = getDefaultSkillsForRole("general");
    expect(defaults).toEqual([]);

    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Utility Agent",
        role: "general",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // No defaults for "general" role → no skill resolution
    expect(mockCompanySkillService.resolveRequestedSkillKeys).not.toHaveBeenCalled();

    const hireActivityCall = mockLogActivity.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.action === "agent.hire_created",
    );
    const details = (hireActivityCall![1] as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.autoAssignedSkills).toBe(false);
  });

  it("auto-assigns different skills per role (qa vs designer)", async () => {
    for (const role of ["qa", "designer"] as const) {
      vi.clearAllMocks();
      // Re-setup mocks cleared by clearAllMocks
      mockGetTelemetryClient.mockReturnValue(null);
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === CEO_AGENT_ID) return makeCeoAgent();
        return null;
      });
      mockAgentService.create.mockImplementation(
        async (_companyId: string, input: Record<string, unknown>) =>
          makeCreatedAgent({ ...input, role }),
      );
      mockAgentService.update.mockImplementation(
        async (_id: string, patch: Record<string, unknown>) => ({
          ...makeCreatedAgent({ role }),
          ...patch,
        }),
      );
      mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
      mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
        async (_companyId: string, config: Record<string, unknown>) => config,
      );
      mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
      mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
        async (_companyId: string, requested: string[]) => requested,
      );
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.hasPermission.mockResolvedValue(true);
      mockAccessService.getMembership.mockResolvedValue(null);
      mockAccessService.listPrincipalGrants.mockResolvedValue([]);
      mockAccessService.ensureMembership.mockResolvedValue(undefined);
      mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
      mockLogActivity.mockResolvedValue(undefined);
      mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
        async (agent: Record<string, unknown>) => ({
          bundle: null,
          adapterConfig: {
            ...((agent.adapterConfig as Record<string, unknown>) ?? {}),
            instructionsBundleMode: "managed",
          },
        }),
      );

      const expectedSkills = getDefaultSkillsForRole(role);
      expect(expectedSkills.length, `expected defaults for role ${role}`).toBeGreaterThan(0);

      const res = await request(createAgentApp())
        .post(`/api/companies/${COMPANY_ID}/agent-hires`)
        .send({
          name: `${role} Agent`,
          role,
          adapterType: "claude_local",
          adapterConfig: {},
        });

      expect(res.status, `${role}: ${JSON.stringify(res.body)}`).toBe(201);
      expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith(
        COMPANY_ID,
        expectedSkills,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// applyCreateDefaultsByAdapterType — dangerouslySkipPermissions
// ---------------------------------------------------------------------------

describe("agent-hires — dangerouslySkipPermissions defaults", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue(null);

    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: null,
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => makeCreatedAgent(input),
    );
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...makeCreatedAgent(),
        ...patch,
      }),
    );

    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: {} },
    });
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);

    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown>) ?? {}),
          instructionsBundleMode: "managed",
        },
      }),
    );
  });

  it("sets dangerouslySkipPermissions=true for claude_local when not provided", async () => {
    const res = await request(createBoardApp())
      .post(`/api/companies/${COMPANY_ID}/agents`)
      .send({
        name: "Test Agent",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const createCall = mockAgentService.create.mock.calls[0];
    const storedConfig = (createCall[1] as Record<string, unknown>).adapterConfig as Record<string, unknown>;
    expect(storedConfig.dangerouslySkipPermissions).toBe(true);
  });

  it("sets dangerouslySkipPermissions=true for claude_local via agent-hires endpoint", async () => {
    // Also verify the agent-hires path (not just /agents)
    const res = await request(createBoardApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({
        name: "Test Hire Agent",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const createCall = mockAgentService.create.mock.calls[0];
    const storedConfig = (createCall[1] as Record<string, unknown>).adapterConfig as Record<string, unknown>;
    expect(storedConfig.dangerouslySkipPermissions).toBe(true);
  });

  it("does not override explicit dangerouslySkipPermissions=false", async () => {
    const res = await request(createBoardApp())
      .post(`/api/companies/${COMPANY_ID}/agents`)
      .send({
        name: "Restricted Agent",
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: false },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const createCall = mockAgentService.create.mock.calls[0];
    const storedConfig = (createCall[1] as Record<string, unknown>).adapterConfig as Record<string, unknown>;
    expect(storedConfig.dangerouslySkipPermissions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for getDefaultSkillsForRole
// ---------------------------------------------------------------------------

describe("getDefaultSkillsForRole", () => {
  it("returns skills for known roles", () => {
    expect(getDefaultSkillsForRole("engineer")).toEqual(["code-review", "git-workflow"]);
    expect(getDefaultSkillsForRole("cto")).toEqual(["paperclip-create-agent", "paperclip-manage-skills"]);
    expect(getDefaultSkillsForRole("qa")).toEqual(["test-automation"]);
  });

  it("returns empty array for roles without defaults", () => {
    expect(getDefaultSkillsForRole("ceo")).toEqual([]);
    expect(getDefaultSkillsForRole("general")).toEqual([]);
    expect(getDefaultSkillsForRole("cfo")).toEqual([]);
    expect(getDefaultSkillsForRole("unknown-role")).toEqual([]);
  });
});
