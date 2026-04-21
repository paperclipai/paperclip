import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/agents.js", async () =>
    vi.importActual<typeof import("../routes/agents.ts")>("../routes/agents.ts"),
  );
  vi.doMock("../routes/agents.ts", async () =>
    vi.importActual<typeof import("../routes/agents.ts")>("../routes/agents.ts"),
  );
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../errors.js", async () =>
    vi.importActual<typeof import("../errors.ts")>("../errors.ts"),
  );
  vi.doMock("../errors.ts", async () =>
    vi.importActual<typeof import("../errors.ts")>("../errors.ts"),
  );
  const servicesIndexMock = () => ({
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
  });
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
}

function resetAgentRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/agents.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../errors.js");
  vi.doUnmock("../errors.ts");
}

let routeImportSeq = 0;

async function createApp() {
  resetAgentRouteModules();
  registerModuleMocks();
  routeImportSeq += 1;
  const routeModulePath = `../routes/agents.ts?heartbeat-log-route-${routeImportSeq}`;
  const [{ agentRoutes }, { errorHandler }, { notFound }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/agents.ts")>,
    import("../middleware/index.ts"),
    import("../errors.ts"),
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

  afterEach(() => {
    resetAgentRouteModules();
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
