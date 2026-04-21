import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

const originalDevServerStatusFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;

function resetHealthRouteModules() {
  vi.resetModules();
  vi.doUnmock("../routes/health.js");
  vi.doUnmock("../routes/health.ts");
  vi.doUnmock("../dev-server-status.js");
  vi.doUnmock("../dev-server-status.ts");
  vi.doUnmock("../services/instance-settings.js");
  vi.doUnmock("../services/instance-settings.ts");
  vi.doUnmock("../version.js");
  vi.doUnmock("../version.ts");
}

async function createHealthApp(
  db?: Db,
  opts?: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  },
  actor?: Record<string, unknown>,
) {
  resetHealthRouteModules();
  const [{ serverVersion }, { healthRoutes }] = await Promise.all([
    vi.importActual<typeof import("../version.js")>("../version.js"),
    vi.importActual<typeof import("../routes/health.js")>("../routes/health.js"),
  ]);
  const app = express();
  if (actor) {
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
  }
  app.use("/health", healthRoutes(db, opts));
  return { app, serverVersion };
}

describe("GET /health", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (originalDevServerStatusFile === undefined) {
      delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    } else {
      process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = originalDevServerStatusFile;
    }
  });

  it("returns 200 with status ok", async () => {
    const { app, serverVersion } = await createHealthApp();

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const { app, serverVersion } = await createHealthApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const { app, serverVersion } = await createHealthApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const { app } = await createHealthApp(
      db,
      {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      },
      { type: "none", source: "none" },
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const { app } = await createHealthApp(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const { app, serverVersion } = await createHealthApp(
      db,
      {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      },
      { type: "board", userId: "user-1", source: "session" },
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });
});
