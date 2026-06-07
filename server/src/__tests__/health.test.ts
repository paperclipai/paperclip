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
      processStartedAt: expect.any(String),
      localAgentJwt: {
        configured: expect.any(Boolean),
        secretLengthOk: expect.any(Boolean),
      },
    });
    expect(Object.keys(res.body)).toEqual(["status", "version", "processStartedAt", "localAgentJwt"]);
  }, 15_000);

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
      deploymentExposure: "public",
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
      deploymentExposure: "public",
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

  describe("processStartedAt", () => {
    it("returns a valid ISO timestamp derived from process.uptime()", async () => {
      const before = Date.now();
      const app = createApp();
      const res = await request(app).get("/health");
      const after = Date.now();

      expect(res.status).toBe(200);
      const ts = new Date(res.body.processStartedAt as string).getTime();
      expect(ts).toBeGreaterThan(0);
      // processStartedAt must be in the past relative to the request
      expect(ts).toBeLessThanOrEqual(before);
      // and within the process lifetime window
      expect(ts).toBeGreaterThan(before - process.uptime() * 1000 - 5000);
      void after;
    });

    it("is present in the full-details DB response", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      } as unknown as Db;
      const app = createApp(db);
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ processStartedAt: expect.any(String) });
    });

    it("is absent from the limited response for anonymous users in authenticated mode", async () => {
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
      app.use("/health", healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }));

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("processStartedAt");
    });
  });

  describe("localAgentJwt", () => {
    const SECRET_ENV_VARS = ["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"] as const;

    function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
      const saved: Record<string, string | undefined> = {};
      for (const key of SECRET_ENV_VARS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      return fn().finally(() => {
        for (const key of SECRET_ENV_VARS) {
          if (saved[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = saved[key];
          }
        }
      });
    }

    it("reports configured=false and secretLengthOk=false when no secret is set", async () => {
      await withEnv({}, async () => {
        const app = createApp();
        const res = await request(app).get("/health");
        expect(res.body.localAgentJwt).toEqual({ configured: false, secretLengthOk: false });
      });
    });

    it("reports configured=true and secretLengthOk=false when PAPERCLIP_AGENT_JWT_SECRET is too short", async () => {
      await withEnv({ PAPERCLIP_AGENT_JWT_SECRET: "short" }, async () => {
        const app = createApp();
        const res = await request(app).get("/health");
        expect(res.body.localAgentJwt).toEqual({ configured: true, secretLengthOk: false });
      });
    });

    it("reports configured=true and secretLengthOk=true when PAPERCLIP_AGENT_JWT_SECRET meets minimum length", async () => {
      await withEnv({ PAPERCLIP_AGENT_JWT_SECRET: "a".repeat(32) }, async () => {
        const app = createApp();
        const res = await request(app).get("/health");
        expect(res.body.localAgentJwt).toEqual({ configured: true, secretLengthOk: true });
      });
    });

    it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", async () => {
      await withEnv({ BETTER_AUTH_SECRET: "b".repeat(32) }, async () => {
        const app = createApp();
        const res = await request(app).get("/health");
        expect(res.body.localAgentJwt).toEqual({ configured: true, secretLengthOk: true });
      });
    });

    it("is absent from the limited response for anonymous users in authenticated mode", async () => {
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
      app.use("/health", healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }));

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("localAgentJwt");
    });
  });
});
