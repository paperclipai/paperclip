import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentInstructionsService: () => ({}),
  agentService: () => ({ getChainOfCommand: vi.fn(async () => []), getById: vi.fn(async () => null) }),
  approvalService: () => ({}),
  budgetService: () => ({}),
  companySkillService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(async () => undefined),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

async function createApp() {
  vi.resetModules();
  const [{ agentRoutes }, { errorHandler }, { notFound }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
    import("../errors.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return { app, notFound };
}

describe("heartbeat log route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns pending log state for runs that exist before log initialization", async () => {
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      status: "running",
      logStore: null,
      logRef: null,
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: null,
      logRef: null,
      pending: true,
      content: "",
    });

    const { app } = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-1/log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runId: "run-1",
      store: null,
      logRef: null,
      pending: true,
      content: "",
    });
  });

  it("returns 404 when the heartbeat run does not exist", async () => {
    mockHeartbeatService.getRunLogAccess.mockResolvedValue(null);

    const { app } = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-missing/log");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
  });

  it("keeps persisted log read failures noisy", async () => {
    const { app, notFound } = await createApp();
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      status: "done",
      logStore: "local_file",
      logRef: "run-1.log",
    });
    mockHeartbeatService.readLog.mockRejectedValue(notFound("Run log not found"));

    const res = await request(app).get("/api/heartbeat-runs/run-1/log");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run log not found" });
  });
});
