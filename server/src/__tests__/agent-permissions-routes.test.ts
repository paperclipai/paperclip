import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockAgentHeartbeatModel = vi.hoisted(() => ({
  ensureCompanyHasQaReleaseEngineer: vi.fn(),
}));
const mockRoleRequiresQaCoverage = vi.hoisted(() => vi.fn(() => false));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNormalizeRuntimeConfigForCooHeartbeatModel = vi.hoisted(() =>
  vi.fn(({ runtimeConfig }: { runtimeConfig?: Record<string, unknown> }) => runtimeConfig ?? {}),
);
const mockResolveRoleForCooCoordinatorModel = vi.hoisted(() =>
  vi.fn(({ role }: { role?: string }) => role ?? "general"),
);

let agentRoutesFactory!: typeof import("../routes/agents.js").agentRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  agentHeartbeatModelService: () => mockAgentHeartbeatModel,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  normalizeRuntimeConfigForCooHeartbeatModel: mockNormalizeRuntimeConfigForCooHeartbeatModel,
  roleRequiresQaCoverage: mockRoleRequiresQaCoverage,
  resolveRoleForCooCoordinatorModel: mockResolveRoleForCooCoordinatorModel,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "PrivateClip",
            requireBoardApprovalForNewAgents: false,
          }]),
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
  app.use("/api", agentRoutesFactory(createDbStub() as any));
  app.use(errorHandlerMiddleware);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

function resetMockObject(mockObject: Record<string, { mockReset: () => unknown }>) {
  for (const value of Object.values(mockObject)) {
    value.mockReset();
  }
}

describe.sequential("agent permission routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetMockObject(mockAgentService);
    resetMockObject(mockAccessService);
    resetMockObject(mockApprovalService);
    resetMockObject(mockBudgetService);
    resetMockObject(mockHeartbeatService);
    resetMockObject(mockIssueApprovalService);
    resetMockObject(mockIssueService);
    resetMockObject(mockAgentHeartbeatModel);
    mockRoleRequiresQaCoverage.mockReset();
    resetMockObject(mockSecretService);
    resetMockObject(mockAgentInstructionsService);
    resetMockObject(mockCompanySkillService);
    mockLogActivity.mockReset();
    mockNormalizeRuntimeConfigForCooHeartbeatModel.mockReset();
    mockResolveRoleForCooCoordinatorModel.mockReset();
    mockRoleRequiresQaCoverage.mockReturnValue(false);
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
    ({ agentRoutes: agentRoutesFactory } = await import("../routes/agents.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  });

  it.sequential("grants tasks:assign by default when board creates a new agent", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestWithApp(app, (agent) =>
      agent.post(`/api/companies/${companyId}/agents`).send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }),
    );

    expect(res.status).toBe(201);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
  });

  it.sequential("exposes explicit task assignment access on agent detail", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
        grantedByUserId: "board-user",
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestWithApp(app, (agent) => agent.get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("explicit_grant");
  });

  it.sequential("keeps task assignment enabled when agent creation privilege is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true },
    });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestWithApp(app, (agent) =>
      agent.patch(`/api/agents/${agentId}/permissions`).send({ canCreateAgents: true, canAssignTasks: false }),
    );

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("agent_creator");
  });

  it.sequential("exposes a dedicated agent route for the inbox mine view", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);

    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await requestWithApp(app, (agent) =>
      agent.get("/api/agents/me/inbox/mine").query({ userId: "board-user" }),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      touchedByUserId: "board-user",
      inboxArchivedByUserId: "board-user",
      status: INBOX_MINE_ISSUE_STATUS_FILTER,
    });
    expect(res.body).toEqual([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);
  });
});
