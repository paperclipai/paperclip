import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  buildRunOutputSilence: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => ({}),
    accessService: () => ({}),
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
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
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const SAMPLE_RUN = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  invocationSource: "on_demand",
  resultJson: {
    adapterVersion: "1.2.3",
    toolCallCount: 4,
  },
  createdAt: new Date("2026-04-10T09:29:59.000Z"),
  startedAt: new Date("2026-04-10T09:30:00.000Z"),
  finishedAt: new Date("2026-04-10T09:31:00.000Z"),
};

describe("GET /heartbeat-runs/:runId — result_json projection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockHeartbeatService.getRun.mockResolvedValue(SAMPLE_RUN);
    mockHeartbeatService.getRetryExhaustedReason.mockResolvedValue(null);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
  });

  it("calls getRun without options by default (preserves the safe projection)", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-1").expect(200);

    expect(mockHeartbeatService.getRun).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1", undefined);
    expect(res.body.id).toBe("run-1");
  });

  it("passes { unsafeFullResultJson: true } when ?include=resultJson is set", async () => {
    const app = await createApp();
    await request(app).get("/api/heartbeat-runs/run-1?include=resultJson").expect(200);

    expect(mockHeartbeatService.getRun).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1", {
      unsafeFullResultJson: true,
    });
  });

  it("treats ?expand=full as equivalent to ?include=resultJson", async () => {
    const app = await createApp();
    await request(app).get("/api/heartbeat-runs/run-1?expand=full").expect(200);

    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1", {
      unsafeFullResultJson: true,
    });
  });

  it("treats arbitrary ?include values as absence and preserves the safe projection", async () => {
    const app = await createApp();
    await request(app).get("/api/heartbeat-runs/run-1?include=somethingElse").expect(200);

    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1", undefined);
  });

  it("preserves a 404 when getRun returns null, regardless of include flag", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app)
      .get("/api/heartbeat-runs/run-missing?include=resultJson")
      .expect(404);
    expect(res.body.error).toBe("Heartbeat run not found");
  });
});
