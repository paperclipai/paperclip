import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { backupRoutes } from "../routes/backups.js";
import type { BackupManager } from "../services/backups.js";

let tempHome: string;
let previousHome: string | undefined;
let previousCloudToken: string | undefined;
let previousManagedConfig: string | undefined;

function createManager() {
  return {
    getOverview: vi.fn(async () => ({ enabled: true })),
  } as unknown as BackupManager;
}

function createApp(actor: Record<string, unknown>, manager: BackupManager) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", backupRoutes(manager));
  app.post("/api/tool-gateway/sessions", (_req, res) => {
    res.status(201).json({ reached: true });
  });
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  previousHome = process.env.PAPERCLIP_HOME;
  previousCloudToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  previousManagedConfig = process.env.PAPERCLIP_MANAGED_CONFIG;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-routes-"));
  process.env.PAPERCLIP_HOME = tempHome;
  delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  delete process.env.PAPERCLIP_MANAGED_CONFIG;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
  if (previousCloudToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = previousCloudToken;
  if (previousManagedConfig === undefined) delete process.env.PAPERCLIP_MANAGED_CONFIG;
  else process.env.PAPERCLIP_MANAGED_CONFIG = previousManagedConfig;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("portable backup routes", () => {
  const instanceAdmin = {
    type: "board",
    userId: "admin-1",
    source: "session",
    isInstanceAdmin: true,
  };

  it("serves the overview to a self-hosted instance admin", async () => {
    const manager = createManager();
    const app = createApp(instanceAdmin, manager);

    await request(app).get("/api/backups").expect(200, { enabled: true });
    expect(manager.getOverview).toHaveBeenCalledTimes(1);
  });

  it("floors portable backup operations off on cloud-managed instances", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "tenant-server-token");
    const manager = createManager();
    const app = createApp(instanceAdmin, manager);

    const response = await request(app).get("/api/backups");

    expect(response.status).toBe(403);
    expect(response.body.details).toMatchObject({ code: "portable_backups_platform_managed" });
    expect(manager.getOverview).not.toHaveBeenCalled();
  });

  it("does not intercept an agent request outside the backup route namespace", async () => {
    const manager = createManager();
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
    }, manager);

    await request(app).post("/api/tool-gateway/sessions").expect(201, { reached: true });
    expect(manager.getOverview).not.toHaveBeenCalled();
  });

  it("sanitizes unsafe archive names before placing them in the download header", async () => {
    const bundleName = "bundle";
    fs.mkdirSync(path.join(tempHome, bundleName));
    fs.writeFileSync(path.join(tempHome, bundleName, "manifest.json"), "{}", "utf8");
    const manager = {
      ...createManager(),
      getDownloadDescriptor: vi.fn(async () => ({
        bundleDirectory: tempHome,
        bundleName,
        archiveName: 'backup"\r\nX-Injected: true.tar.gz',
      })),
    } as unknown as BackupManager;
    const app = createApp(instanceAdmin, manager);

    const response = await request(app).get("/api/backups/backup-1/download").buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="backup__X-Injected: true.tar.gz"');
    expect(response.headers["content-disposition"]).not.toContain("\r");
    expect(response.headers["content-disposition"]).not.toContain("\n");
  });

  it("keeps a normal archive name unchanged in the download header", async () => {
    const bundleName = "bundle";
    fs.mkdirSync(path.join(tempHome, bundleName));
    fs.writeFileSync(path.join(tempHome, bundleName, "manifest.json"), "{}", "utf8");
    const manager = {
      ...createManager(),
      getDownloadDescriptor: vi.fn(async () => ({
        bundleDirectory: tempHome,
        bundleName,
        archiveName: "portable-backup.tar.gz",
      })),
    } as unknown as BackupManager;
    const app = createApp(instanceAdmin, manager);

    const response = await request(app).get("/api/backups/backup-1/download").buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="portable-backup.tar.gz"');
  });
});
