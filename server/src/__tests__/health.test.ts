import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_RECORD_IO;
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      observability: {
        langfuse: {
          configured: false,
          public_key: false,
          secret_key: false,
          base_url: "https://us.cloud.langfuse.com",
          record_io: false,
        },
      },
    });
  }, 15_000);

  it("reports redacted Langfuse readiness when configured", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";

    const app = createApp();
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.observability.langfuse).toMatchObject({
      configured: true,
      public_key: true,
      secret_key: true,
      base_url: "https://us.cloud.langfuse.com",
      record_io: false,
    });
    expect(JSON.stringify(res.body)).not.toContain("sk-test");
    expect(JSON.stringify(res.body)).not.toContain("pk-test");
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
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
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
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

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
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
