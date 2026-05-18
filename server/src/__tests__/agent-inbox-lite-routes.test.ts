import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const issueA = "33333333-3333-4333-8333-333333333333";
const issueB = "44444444-4444-4444-8444-444444444444";
const interactionA1 = "55555555-5555-4555-8555-555555555555";
const interactionB1 = "66666666-6666-4666-8666-666666666666";
const interactionB2 = "77777777-7777-4777-8777-777777777777";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  listPendingForIssues: vi.fn(),
}));

const mockRecoveryActionService = vi.hoisted(() => ({
  listActiveForIssues: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ canUser: vi.fn(async () => true), hasPermission: vi.fn(async () => true) }),
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    approvalService: () => ({}),
    budgetService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(async () => []) }),
    heartbeatService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => mockRecoveryActionService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockInteractionService,
    logActivity: vi.fn(async () => undefined),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn(),
    workspaceOperationService: () => ({}),
    environmentService: () => ({}),
  }));
}

function createDbStub() {
  return {} as any;
}

async function createApp(actor: Record<string, unknown>) {
  const { agentRoutes } = await import("../routes/agents.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub()));
  app.use(errorHandler);
  return app;
}

describe("GET /api/agents/me/inbox-lite", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    mockIssueService.list.mockReset();
    mockIssueService.listDependencyReadiness.mockReset();
    mockInteractionService.listPendingForIssues.mockReset();
    mockRecoveryActionService.listActiveForIssues.mockReset();
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("includes pendingInteractions per issue from issueThreadInteractionService", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: issueA,
        identifier: "TST-1",
        title: "Issue A",
        status: "in_progress",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-05-18T10:00:00.000Z"),
        activeRun: null,
      },
      {
        id: issueB,
        identifier: "TST-2",
        title: "Issue B",
        status: "blocked",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-05-18T11:00:00.000Z"),
        activeRun: null,
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map([
      [issueA, { isDependencyReady: true, unresolvedBlockerCount: 0, unresolvedBlockerIssueIds: [] }],
      [issueB, { isDependencyReady: false, unresolvedBlockerCount: 1, unresolvedBlockerIssueIds: ["blk-1"] }],
    ]));
    mockInteractionService.listPendingForIssues.mockResolvedValue(new Map([
      [issueA, [{
        id: interactionA1,
        kind: "request_confirmation",
        title: "Approve plan?",
        summary: null,
        createdAt: new Date("2026-05-18T09:00:00.000Z"),
        createdByAgentId: "creator-agent",
        createdByUserId: null,
      }]],
      [issueB, [
        {
          id: interactionB2,
          kind: "suggest_tasks",
          title: "Decompose",
          summary: null,
          createdAt: new Date("2026-05-18T08:30:00.000Z"),
          createdByAgentId: "creator-agent",
          createdByUserId: null,
        },
        {
          id: interactionB1,
          kind: "ask_user_questions",
          title: "Pick variant",
          summary: "Need input",
          createdAt: new Date("2026-05-18T08:00:00.000Z"),
          createdByAgentId: null,
          createdByUserId: "creator-user",
        },
      ]],
    ]));

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });

    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: issueA,
      pendingInteractionCount: 1,
      pendingInteractions: [{
        id: interactionA1,
        kind: "request_confirmation",
        title: "Approve plan?",
        createdByAgentId: "creator-agent",
      }],
    });
    expect(res.body[1]).toMatchObject({
      id: issueB,
      pendingInteractionCount: 2,
      pendingInteractions: [
        expect.objectContaining({ id: interactionB2, kind: "suggest_tasks" }),
        expect.objectContaining({ id: interactionB1, kind: "ask_user_questions", createdByUserId: "creator-user" }),
      ],
      unresolvedBlockerCount: 1,
    });
    expect(mockInteractionService.listPendingForIssues).toHaveBeenCalledWith(companyId, [issueA, issueB]);
  });

  it("returns empty pendingInteractions when service returns an empty Map", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: issueA,
        identifier: "TST-1",
        title: "Issue A",
        status: "in_progress",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-05-18T10:00:00.000Z"),
        activeRun: null,
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockInteractionService.listPendingForIssues.mockResolvedValue(new Map());

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });

    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: issueA,
      pendingInteractionCount: 0,
      pendingInteractions: [],
    });
  });
});
