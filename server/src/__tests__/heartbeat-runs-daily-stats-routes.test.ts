import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "11111111-1111-4111-8111-111111111111";

const mockHeartbeatService = vi.hoisted(() => ({
  listDailyStats: vi.fn(),
}));

function registerModuleMocks() {
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
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("heartbeat-runs daily stats route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it("returns the aggregated daily stats from the heartbeat service", async () => {
    mockHeartbeatService.listDailyStats.mockResolvedValue([
      { date: "2026-04-25", succeeded: 5, failed: 1, other: 0 },
      { date: "2026-04-26", succeeded: 7, failed: 0, other: 2 },
    ]);

    const res = await request(await createApp()).get(
      `/api/companies/${companyId}/heartbeat-runs/daily-stats?days=14`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.listDailyStats).toHaveBeenCalledWith(companyId, 14, undefined);
    expect(res.body).toEqual([
      { date: "2026-04-25", succeeded: 5, failed: 1, other: 0 },
      { date: "2026-04-26", succeeded: 7, failed: 0, other: 2 },
    ]);
  });

  it("defaults the day window to 14 when the query param is missing", async () => {
    mockHeartbeatService.listDailyStats.mockResolvedValue([]);

    await request(await createApp()).get(`/api/companies/${companyId}/heartbeat-runs/daily-stats`);

    expect(mockHeartbeatService.listDailyStats).toHaveBeenCalledWith(companyId, 14, undefined);
  });

  it("clamps the day window to a minimum of 1 and a maximum of 90", async () => {
    mockHeartbeatService.listDailyStats.mockResolvedValue([]);
    const app = await createApp();

    await request(app).get(`/api/companies/${companyId}/heartbeat-runs/daily-stats?days=0`);
    await request(app).get(`/api/companies/${companyId}/heartbeat-runs/daily-stats?days=999`);
    await request(app).get(`/api/companies/${companyId}/heartbeat-runs/daily-stats?days=abc`);

    expect(mockHeartbeatService.listDailyStats).toHaveBeenNthCalledWith(1, companyId, 1, undefined);
    expect(mockHeartbeatService.listDailyStats).toHaveBeenNthCalledWith(2, companyId, 90, undefined);
    expect(mockHeartbeatService.listDailyStats).toHaveBeenNthCalledWith(3, companyId, 14, undefined);
  });

  it("forwards an optional agentId filter to the service", async () => {
    mockHeartbeatService.listDailyStats.mockResolvedValue([]);
    const agentId = "22222222-2222-4222-8222-222222222222";

    await request(await createApp()).get(
      `/api/companies/${companyId}/heartbeat-runs/daily-stats?days=7&agentId=${agentId}`,
    );

    expect(mockHeartbeatService.listDailyStats).toHaveBeenCalledWith(companyId, 7, agentId);
  });
});
