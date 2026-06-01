import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCgroupManager } from "../services/plugin-cgroup-manager.js";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  buildIssueGraphLivenessAutoRecoveryPreview: vi.fn(),
  reconcileIssueGraphLiveness: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
}

function makeMockCgroupManager(isSupported: boolean): PluginCgroupManager {
  return {
    isSupported: vi.fn().mockResolvedValue(isSupported),
    setup: vi.fn().mockResolvedValue(undefined),
    enterCgroup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    checkOomKill: vi.fn().mockResolvedValue(false),
    cgroupPath: vi.fn().mockReturnValue("/mock/cgroup"),
    effectiveLimits: vi.fn().mockReturnValue({}),
  };
}

async function createApp(actor: unknown, cgroupManager?: PluginCgroupManager) {
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any, { cgroupManager }));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
};

describe("instance settings routes — cgroup active flag", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      pluginCgroupDefaults: {},
      pluginCgroupOverrides: {},
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([]);
  });

  it("GET /instance/settings/experimental includes pluginCgroupActive=false when no manager provided", async () => {
    const app = await createApp(boardActor, undefined);
    const res = await request(app).get("/api/instance/settings/experimental");
    expect(res.status).toBe(200);
    expect(res.body.pluginCgroupActive).toBe(false);
  });

  it("GET /instance/settings/experimental includes pluginCgroupActive=true when manager isSupported=true", async () => {
    const manager = makeMockCgroupManager(true);
    const app = await createApp(boardActor, manager);
    const res = await request(app).get("/api/instance/settings/experimental");
    expect(res.status).toBe(200);
    expect(res.body.pluginCgroupActive).toBe(true);
    expect(manager.isSupported).toHaveBeenCalledOnce();
  });

  it("GET /instance/settings/experimental includes pluginCgroupActive=false when manager isSupported=false", async () => {
    const manager = makeMockCgroupManager(false);
    const app = await createApp(boardActor, manager);
    const res = await request(app).get("/api/instance/settings/experimental");
    expect(res.status).toBe(200);
    expect(res.body.pluginCgroupActive).toBe(false);
  });
});

describe("instance settings routes — cgroup PATCH (Tier 3 E2E)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([]);
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "inst-1",
      experimental: {
        enableEnvironments: false,
        enableIsolatedWorkspaces: false,
        autoRestartDevServerWhenIdle: false,
        enableIssueGraphLivenessAutoRecovery: false,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
        pluginCgroupDefaults: { pidsMax: 64 },
        pluginCgroupOverrides: {},
      },
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("PATCH with pluginCgroupDefaults calls updateExperimental with correct payload", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ pluginCgroupDefaults: { pidsMax: 64 } });
    expect(res.status).toBe(200);
    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      pluginCgroupDefaults: { pidsMax: 64 },
    });
  });

  it("PATCH rejects invalid pluginCgroupDefaults (pidsMax below minimum)", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ pluginCgroupDefaults: { pidsMax: 1 } });
    expect(res.status).toBe(400);
    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });

  it("PATCH rejects invalid pluginCgroupDefaults (memoryMaxBytes < memoryHighBytes)", async () => {
    const app = await createApp(boardActor);
    const res = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({
        pluginCgroupDefaults: {
          memoryHighBytes: 134217728,
          memoryMaxBytes: 67108864,
        },
      });
    expect(res.status).toBe(400);
    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });
});

describe("instance settings routes — cgroup RBAC (Tier 4)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/instance-settings.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      pluginCgroupDefaults: {},
      pluginCgroupOverrides: {},
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("GET experimental settings allowed for org member (board, non-admin)", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app).get("/api/instance/settings/experimental");
    expect(res.status).toBe(200);
    expect(res.body.pluginCgroupActive).toBe(false);
  });

  it("GET experimental settings denied for agent actor", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1" });
    const res = await request(app).get("/api/instance/settings/experimental");
    expect(res.status).toBe(403);
  });

  it("PATCH experimental settings denied for non-instance-admin board member", async () => {
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "inst-1",
      experimental: {},
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ pluginCgroupDefaults: { pidsMax: 64 } });
    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });
});
