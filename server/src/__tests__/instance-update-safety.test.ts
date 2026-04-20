import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceUpdateStatus } from "@paperclipai/shared";

const mockRunDatabaseBackup = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateUpdateSettings: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockListAdapterPlugins = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/db", () => ({
  runDatabaseBackup: mockRunDatabaseBackup,
  plugins: {
    id: "id",
    pluginKey: "pluginKey",
    packageName: "packageName",
    version: "version",
    status: "status",
    packagePath: "packagePath",
    updatedAt: "updatedAt",
  },
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: mockListAdapterPlugins,
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/db", () => ({
    runDatabaseBackup: mockRunDatabaseBackup,
    plugins: {
      id: "id",
      pluginKey: "pluginKey",
      packageName: "packageName",
      version: "version",
      status: "status",
      packagePath: "packagePath",
      updatedAt: "updatedAt",
    },
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/index.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/adapter-plugin-store.js", () => ({
    listAdapterPlugins: mockListAdapterPlugins,
  }));
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.js")>("../routes/authz.js"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.js")>("../middleware/validate.js"),
  );
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-update-safety-"));
}

function createDb(pluginRows: unknown[] = []) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockResolvedValue(pluginRows),
    })),
  };
}

function createFetch(version: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
}

async function createOptions(root: string, fetchImpl: typeof fetch) {
  const instanceRoot = path.join(root, "instance");
  const backupDir = path.join(instanceRoot, "data", "backups");
  const storageDir = path.join(instanceRoot, "data", "storage");
  const configPath = path.join(instanceRoot, "config.json");
  const envPath = path.join(instanceRoot, ".env");
  const secretsKeyFilePath = path.join(instanceRoot, "secrets", "master.key");

  await fsp.mkdir(path.dirname(secretsKeyFilePath), { recursive: true });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ ok: true }) + "\n");
  await fsp.writeFile(envPath, "PAPERCLIP_TEST=true\n");
  await fsp.writeFile(secretsKeyFilePath, "secret-key");
  await fsp.writeFile(path.join(storageDir, "asset.txt"), "asset");

  return {
    currentVersion: "0.3.1",
    connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
    backupDir,
    instanceRoot,
    configPath,
    envPath,
    secretsKeyFilePath,
    storageProvider: "local_disk" as const,
    storageLocalDiskBaseDir: storageDir,
    cwd: root,
    fetchImpl,
    now: () => new Date("2026-04-19T12:00:00.000Z"),
  };
}

describe("instance update safety service", () => {
  let tempRoots: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tempRoots = [];
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      updateSettings: {
        channel: "stable",
        updateChecksEnabled: true,
        dismissedVersion: null,
        dismissedAt: null,
      },
    });
    mockInstanceSettingsService.updateUpdateSettings.mockResolvedValue({});
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockListAdapterPlugins.mockReturnValue([
      {
        packageName: "@henkey/hermes-paperclip-adapter",
        type: "hermes_local",
        installedAt: "2026-04-19T00:00:00.000Z",
      },
    ]);
    mockRunDatabaseBackup.mockImplementation(async (opts: { backupDir: string }) => {
      await fsp.mkdir(opts.backupDir, { recursive: true });
      const backupFile = path.join(opts.backupDir, "paperclip-pre-update.sql.gz");
      await fsp.writeFile(backupFile, "database");
      return { backupFile, sizeBytes: 8, prunedCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  });

  it("compares stable and prerelease versions", async () => {
    const { compareVersions } = await import("../services/instance-update-safety.js");

    expect(compareVersions("2026.411.0", "0.3.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-canary.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("uses cached stable release checks inside the TTL", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const fetchImpl = createFetch("0.3.2");
    const opts = await createOptions(root, fetchImpl);
    const { instanceUpdateSafetyService } = await import("../services/instance-update-safety.js");
    const svc = instanceUpdateSafetyService(createDb() as any, opts);

    const first = await svc.getUpdateStatus(false);
    const second = await svc.getUpdateStatus(false);

    expect(first.updateAvailable).toBe(true);
    expect(second.checkSource).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates a valid local pre-update backup manifest for the target version", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const opts = await createOptions(root, createFetch("0.3.2"));
    const pluginRows = [{
      id: "plugin-1",
      pluginKey: "paperclip.hello-world",
      packageName: "@paperclipai/plugin-hello-world-example",
      version: "0.1.0",
      status: "ready",
      packagePath: "/tmp/plugin",
      updatedAt: new Date("2026-04-19T00:00:00.000Z"),
    }];
    const { instanceUpdateSafetyService } = await import("../services/instance-update-safety.js");
    const svc = instanceUpdateSafetyService(createDb(pluginRows) as any, opts);

    const backup = await svc.createPreUpdateBackup({ targetVersion: "0.3.2" });
    const status = await svc.getPreUpdateBackupStatus("0.3.2");
    const manifest = JSON.parse(await fsp.readFile(backup.manifestPath, "utf8"));

    expect(backup.status).toBe("succeeded");
    expect(status.valid).toBe(true);
    expect(manifest.included.database).toBe(true);
    expect(manifest.included.localStorage).toBe(true);
    expect(manifest.counts.pluginCount).toBe(1);
    expect(manifest.counts.externalAdapterCount).toBe(1);
    expect(Object.keys(manifest.checksums).length).toBeGreaterThan(0);
  });

  it("requires explicit acknowledgement before recording an external storage pre-update backup", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const opts = {
      ...(await createOptions(root, createFetch("0.3.2"))),
      storageProvider: "s3" as const,
      storageLocalDiskBaseDir: undefined,
      storageS3Bucket: "paperclip-assets",
      storageS3Region: "us-east-1",
      storageS3Prefix: "instance/default",
    };
    const { instanceUpdateSafetyService } = await import("../services/instance-update-safety.js");
    const svc = instanceUpdateSafetyService(createDb() as any, opts);

    await expect(svc.createPreUpdateBackup({ targetVersion: "0.3.2" })).rejects.toThrow(
      "External storage backup acknowledgement is required",
    );

    const backup = await svc.createPreUpdateBackup({
      targetVersion: "0.3.2",
      acknowledgeExternalStorage: true,
    });
    const status = await svc.getPreUpdateBackupStatus("0.3.2");

    expect(backup.status).toBe("succeeded");
    expect(status.valid).toBe(true);
    expect(status.externalStorageRequiresAcknowledgement).toBe(true);
  });
});

describe("instance update safety routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
  });

  async function createRouteApp(actor: Record<string, unknown>, service: Record<string, unknown>) {
    vi.resetModules();
    registerModuleMocks();
    const [{ instanceUpdateSafetyRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/instance-update-safety.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as any;
      next();
    });
    app.use("/api", instanceUpdateSafetyRoutes({} as any, service as any));
    app.use(errorHandler);
    return app;
  }

  function status(overrides: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
    return {
      status: "update_available",
      currentVersion: "0.3.1",
      latestVersion: "0.3.2",
      updateAvailable: true,
      releaseUrl: "https://github.com/paperclipai/paperclip/releases/tag/v0.3.2",
      checkedAt: "2026-04-19T12:00:00.000Z",
      nextCheckAt: "2026-04-19T18:00:00.000Z",
      checkSource: "npm",
      error: null,
      settings: {
        channel: "stable",
        updateChecksEnabled: true,
        dismissedVersion: null,
        dismissedAt: null,
      },
      install: {
        currentVersion: "0.3.1",
        gitRepositoryRoot: null,
        gitBranch: null,
        gitSha: null,
        gitDirty: null,
      },
      backup: {
        required: true,
        valid: false,
        reason: "missing",
        targetVersion: "0.3.2",
        expiresAt: null,
        latest: null,
        externalStorageRequiresAcknowledgement: false,
      },
      banner: {
        shouldShow: true,
        tone: "warn",
        reasons: ["backup_required"],
      },
      ...overrides,
    };
  }

  it("requires instance admin access", async () => {
    const service = {
      getUpdateStatus: vi.fn().mockResolvedValue(status()),
      checkNow: vi.fn(),
      dismissUpdate: vi.fn(),
      getPreUpdateBackupStatus: vi.fn(),
      createPreUpdateBackup: vi.fn(),
    };
    const app = await createRouteApp({
      type: "board",
      source: "session",
      isInstanceAdmin: false,
    }, service);

    const res = await request(app).get("/api/instance/update-status");

    expect(res.status).toBe(403);
    expect(service.getUpdateStatus).not.toHaveBeenCalled();
  });

  it("returns status and logs manual checks", async () => {
    const service = {
      getUpdateStatus: vi.fn().mockResolvedValue(status()),
      checkNow: vi.fn().mockResolvedValue(status()),
      dismissUpdate: vi.fn(),
      getPreUpdateBackupStatus: vi.fn(),
      createPreUpdateBackup: vi.fn(),
    };
    const app = await createRouteApp({
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    }, service);

    const getRes = await request(app).get("/api/instance/update-status");
    const checkRes = await request(app).post("/api/instance/update-status/check").send({});

    expect(getRes.status).toBe(200);
    expect(checkRes.status).toBe(200);
    expect(service.checkNow).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("dismisses the detected update version and logs the action", async () => {
    const dismissed = status({
      settings: {
        channel: "stable",
        updateChecksEnabled: true,
        dismissedVersion: "0.3.2",
        dismissedAt: "2026-04-19T12:01:00.000Z",
      },
      banner: {
        shouldShow: false,
        tone: "warn",
        reasons: ["backup_required"],
      },
    });
    const service = {
      getUpdateStatus: vi.fn(),
      checkNow: vi.fn(),
      dismissUpdate: vi.fn().mockResolvedValue(dismissed),
      getPreUpdateBackupStatus: vi.fn(),
      createPreUpdateBackup: vi.fn(),
    };
    const app = await createRouteApp({
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    }, service);

    const res = await request(app)
      .patch("/api/instance/update-status/dismiss")
      .send({ version: "0.3.2" });

    expect(res.status).toBe(200);
    expect(service.dismissUpdate).toHaveBeenCalledWith("0.3.2");
    expect(res.body.settings.dismissedVersion).toBe("0.3.2");
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("creates a pre-update backup and logs the manifest summary", async () => {
    const backup = {
      id: "backup-1",
      status: "succeeded",
      createdAt: "2026-04-19T12:01:00.000Z",
      currentVersion: "0.3.1",
      targetVersion: "0.3.2",
      backupDir: "/tmp/pre-update",
      manifestPath: "/tmp/pre-update/manifest.json",
      databaseBackupFile: "/tmp/pre-update/database/paperclip.sql.gz",
      externalStorageAcknowledged: false,
      storageProvider: "local_disk",
      warnings: [],
      error: null,
    };
    const service = {
      getUpdateStatus: vi.fn(),
      checkNow: vi.fn(),
      dismissUpdate: vi.fn(),
      getPreUpdateBackupStatus: vi.fn(),
      createPreUpdateBackup: vi.fn().mockResolvedValue(backup),
    };
    const app = await createRouteApp({
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    }, service);

    const res = await request(app)
      .post("/api/instance/backups/pre-update")
      .send({ targetVersion: "0.3.2" });

    expect(res.status).toBe(201);
    expect(service.createPreUpdateBackup).toHaveBeenCalledWith({
      targetVersion: "0.3.2",
    });
    expect(res.body.manifestPath).toBe("/tmp/pre-update/manifest.json");
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });
});
