import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
}));

const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => ({}),
    accessService: () => ({}),
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    issueTreeControlService: () => mockIssueTreeControlService,
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 100,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
    }),
  }));

  vi.doMock("../adapters/index.js", () => ({
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    findServerAdapter: vi.fn(),
    listAdapterModelProfiles: vi.fn(),
    listAdapterModels: vi.fn(),
    refreshAdapterModels: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent inbox-lite route parity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("marks dependencyReady false when checkout is blocked by active pause hold", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Blocked lane",
        status: "blocked",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        updatedAt: new Date("2026-05-04T10:00:00.000Z").toISOString(),
        activeRun: null,
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map([["issue-1", {
      isDependencyReady: true,
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
    }]]));
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue({
      holdId: "hold-1",
      rootIssueId: "root-1",
      mode: "subtree",
    });

    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "issue-1",
        dependencyReady: false,
        checkoutBlocked: true,
        checkoutBlockReason: "active_subtree_pause_hold",
        activePauseHold: {
          holdId: "hold-1",
          rootIssueId: "root-1",
          mode: "subtree",
        },
      }),
    ]);
  });
});
