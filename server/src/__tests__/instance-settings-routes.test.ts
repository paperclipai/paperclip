import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPersistedDevServerControl } from "../dev-server-control.js";

function createMockInstanceSettingsService() {
  return {
    getGeneral: vi.fn(),
    getExperimental: vi.fn(),
    updateGeneral: vi.fn(),
    updateExperimental: vi.fn(),
    listCompanyIds: vi.fn(),
  };
}

let mockInstanceSettingsService = createMockInstanceSettingsService();
let mockLogActivity = vi.fn();
let instanceSettingsRoutesFactory!: typeof import("../routes/instance-settings.js").instanceSettingsRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutesFactory({} as any));
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

async function sendInstanceSettingsRequest(
  app: express.Express,
  action: (agent: request.SuperTest<request.Test>) => Promise<request.Response>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await action(request(server));
  } finally {
    await closeServer(server);
  }
}

describe.sequential("instance settings routes", () => {
  const originalControlFile = process.env.PAPERCLIP_DEV_SERVER_CONTROL_FILE;
  const tempDirs: string[] = [];

  function createTempControlFilePath() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-instance-settings-"));
    tempDirs.push(dir);
    return path.join(dir, "dev-server-control.json");
  }

  beforeEach(async () => {
    vi.resetModules();
    mockInstanceSettingsService = createMockInstanceSettingsService();
    mockLogActivity = vi.fn(async () => undefined);
    delete process.env.PAPERCLIP_DEV_SERVER_CONTROL_FILE;
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      dailyExecutiveSummarySendHour: 8,
      dailyExecutiveSummarySendMinute: 0,
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        keyboardShortcuts: true,
        feedbackDataSharingPreference: "allowed",
        dailyExecutiveSummarySendHour: 9,
        dailyExecutiveSummarySendMinute: 30,
      },
    });
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "instance-settings-1",
      experimental: {
        enableIsolatedWorkspaces: true,
        autoRestartDevServerWhenIdle: false,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);

    vi.doMock("../services/index.js", () => ({
      instanceSettingsService: () => mockInstanceSettingsService,
      logActivity: mockLogActivity,
    }));
    ({ instanceSettingsRoutes: instanceSettingsRoutesFactory } = await import("../routes/instance-settings.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  });

  afterEach(() => {
    if (originalControlFile) {
      process.env.PAPERCLIP_DEV_SERVER_CONTROL_FILE = originalControlFile;
    } else {
      delete process.env.PAPERCLIP_DEV_SERVER_CONTROL_FILE;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.sequential("allows local board users to read and update experimental settings", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await sendInstanceSettingsRequest(app, (agent) =>
      agent.get("/api/instance/settings/experimental"),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
    });

    const patchRes = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .patch("/api/instance/settings/experimental")
        .send({ enableIsolatedWorkspaces: true }),
    );

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableIsolatedWorkspaces: true,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("allows local board users to update guarded dev-server auto-restart", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .patch("/api/instance/settings/experimental")
        .send({ autoRestartDevServerWhenIdle: true }),
    );

    expect(res.status).toBe(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      autoRestartDevServerWhenIdle: true,
    });
  });

  it.sequential("accepts explicit dev-server restart requests when managed dev control is available", async () => {
    const controlFilePath = createTempControlFilePath();
    process.env.PAPERCLIP_DEV_SERVER_CONTROL_FILE = controlFilePath;

    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .post("/api/instance/dev-server/restart")
        .send({}),
    );

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true });
    expect(readPersistedDevServerControl({ PAPERCLIP_DEV_SERVER_CONTROL_FILE: controlFilePath })).toMatchObject({
      action: "restart",
      requestedBy: "local-board",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("rejects dev-server restart requests when managed dev control is unavailable", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .post("/api/instance/dev-server/restart")
        .send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Managed dev-server restart is not available in this runtime" });
  });

  it.sequential("allows local board users to read and update general settings", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await sendInstanceSettingsRequest(app, (agent) =>
      agent.get("/api/instance/settings/general"),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      dailyExecutiveSummarySendHour: 8,
      dailyExecutiveSummarySendMinute: 0,
    });

    const patchRes = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .patch("/api/instance/settings/general")
        .send({
          censorUsernameInLogs: true,
          keyboardShortcuts: true,
          feedbackDataSharingPreference: "allowed",
          dailyExecutiveSummarySendHour: 9,
          dailyExecutiveSummarySendMinute: 30,
        }),
    );

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "allowed",
      dailyExecutiveSummarySendHour: 9,
      dailyExecutiveSummarySendMinute: 30,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("allows non-admin board users to read general settings", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent.get("/api/instance/settings/general"),
    );

    expect(res.status).toBe(200);
    expect(mockInstanceSettingsService.getGeneral).toHaveBeenCalled();
  });

  it.sequential("rejects non-admin board users from updating general settings", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true, keyboardShortcuts: true }),
    );

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });

  it.sequential("rejects agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await sendInstanceSettingsRequest(app, (agent) =>
      agent
        .patch("/api/instance/settings/general")
        .send({ feedbackDataSharingPreference: "not_allowed" }),
    );

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });
});
