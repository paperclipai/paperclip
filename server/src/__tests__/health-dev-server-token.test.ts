import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import { clearRestartDrain, getRestartDrainStatus } from "../services/restart-drain.js";

const tempDirs: string[] = [];

function createDevServerStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-dev-server-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  clearRestartDrain();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDrainDbStub(input: {
  activeRunCount: number;
  oldestRunStartedAt?: Date | null;
  activeCompanyIds?: string[];
  bootstrapAdminCount?: number;
  experimental?: Record<string, unknown>;
}) {
  let countSelects = 0;
  const insertedActivities: unknown[] = [];
  return {
    _insertedActivities: insertedActivities,
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn((columns?: Record<string, unknown>) => {
      if (!columns) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                id: "settings-1",
                general: {},
                experimental: input.experimental ?? {},
                createdAt: new Date("2026-03-20T11:00:00.000Z"),
                updatedAt: new Date("2026-03-20T11:00:00.000Z"),
              },
            ]),
          })),
        };
      }
      const hasCompanyId = Boolean(columns && "companyId" in columns);
      if (!hasCompanyId && "count" in columns) {
        countSelects += 1;
      }
      const countValue = countSelects === 1 && input.bootstrapAdminCount !== undefined
        ? input.bootstrapAdminCount
        : input.activeRunCount;
      const whereResult = hasCompanyId
        ? Promise.resolve((input.activeCompanyIds ?? []).map((companyId) => ({ companyId })))
        : Object.assign(Promise.resolve([{ count: countValue }]), {
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => input.oldestRunStartedAt
              ? [{ startedAt: input.oldestRunStartedAt, createdAt: input.oldestRunStartedAt }]
              : []),
          })),
        });
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => whereResult),
        })),
      };
    }),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => (input.activeCompanyIds ?? []).map((companyId) => ({ companyId }))),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: unknown) => {
        insertedActivities.push(value);
        return [];
      }),
    })),
  } as unknown as Db;
}

describe("GET /health dev-server supervisor access", () => {
  it("exposes dev-server metadata to the supervising dev runner in authenticated mode", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
    process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = "dev-runner-token";

    const db = createDrainDbStub({
      activeRunCount: 0,
      bootstrapAdminCount: 1,
      experimental: { autoRestartDevServerWhenIdle: true },
    });

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app)
        .get("/health")
        .set("X-Paperclip-Dev-Server-Status-Token", "dev-runner-token");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
        devServer: {
          enabled: true,
          restartRequired: true,
          reason: "backend_changes",
          drainMode: "idle",
          drainStartedAt: null,
          drainReason: null,
          restartDeferred: false,
          restartDeferredAt: null,
          nextRestartCheckAt: null,
          oldestActiveRunStartedAt: null,
          oldestActiveRunAgeMs: null,
          emergencyOverrideAt: null,
          emergencyReasonPresent: false,
          emergencyReasonCategory: null,
          lastChangedAt: "2026-03-20T12:00:00.000Z",
          changedPathCount: 1,
          changedPathsSample: ["server/src/routes/health.ts"],
          pendingMigrations: [],
          autoRestartEnabled: true,
          activeRunCount: 0,
          waitingForIdle: false,
          lastRestartAt: "2026-03-20T11:30:00.000Z",
        },
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousToken === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = previousToken;
      }
    }
  });
});

describe("POST /health/dev-server/restart", () => {
  it("records a manual restart request for the dev runner", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    try {
      const app = express();
      app.use("/health", healthRoutes(undefined));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        status: "restart_requested",
        activeRunCount: 0,
        oldestRunStartedAt: null,
        oldestRunAgeMs: null,
      });

      const requestPath = path.join(
        path.dirname(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-restart-request.json",
      );
      expect(existsSync(requestPath)).toBe(true);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
        reason: "manual_restart_now",
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });

  it("defers a planned manual restart while active runs exist", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    try {
      const app = express();
      app.use("/health", healthRoutes(createDrainDbStub({
        activeRunCount: 2,
        oldestRunStartedAt: new Date("2026-03-20T11:45:00.000Z"),
      })));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: "restart_deferred",
        activeRunCount: 2,
        oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
      });

      const requestPath = path.join(
        path.dirname(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-restart-request.json",
      );
      expect(existsSync(requestPath)).toBe(false);
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });

  it("requires a reason for emergency restart override", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });

    try {
      const app = express();
      app.use(express.json());
      app.use("/health", healthRoutes(createDrainDbStub({ activeRunCount: 1 })));

      const res = await request(app)
        .post("/health/dev-server/restart")
        .send({ emergency: true });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "emergency_reason_required" });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });

  it("records an emergency restart request when an override reason is provided", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });

    try {
      const db = createDrainDbStub({
        activeRunCount: 1,
        oldestRunStartedAt: new Date("2026-03-20T11:45:00.000Z"),
        activeCompanyIds: ["company-1"],
      }) as Db & { _insertedActivities: Array<{ details?: Record<string, unknown> }> };
      const app = express();
      app.use(express.json());
      app.use("/health", healthRoutes(db));

      const res = await request(app)
        .post("/health/dev-server/restart")
        .send({
          emergency: true,
          emergencyReason: "operator accepted active-run interruption",
          emergencyReasonCategory: "service_recovery",
        });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: "restart_requested_emergency",
        activeRunCount: 1,
        oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
      });

      const requestPath = path.join(
        path.dirname(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-restart-request.json",
      );
      expect(existsSync(requestPath)).toBe(true);
      expect(db._insertedActivities).toHaveLength(1);
      expect(db._insertedActivities[0].details).toMatchObject({
        activeRunCount: 1,
        oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
        emergencyReasonPresent: true,
        emergencyReasonCategory: "service_recovery",
      });
      expect(db._insertedActivities[0].details).not.toHaveProperty("reason");
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });

  it("rejects unauthenticated manual restarts in authenticated mode", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
    });

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "board_access_required" });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });
});

describe("POST /health/service-restart/check", () => {
  it("defers a planned service restart while active runs exist", async () => {
    const app = express();
    app.use(express.json());
    app.use("/health", healthRoutes(createDrainDbStub({
      activeRunCount: 2,
      oldestRunStartedAt: new Date("2026-03-20T11:45:00.000Z"),
    })));

    const res = await request(app).post("/health/service-restart/check");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "restart_deferred",
      activeRunCount: 2,
      oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
    });
  });

  it("allows a planned service restart and activates drain when no active runs exist", async () => {
    const app = express();
    app.use(express.json());
    app.use("/health", healthRoutes(createDrainDbStub({ activeRunCount: 0 })));

    const res = await request(app).post("/health/service-restart/check");
    const drain = getRestartDrainStatus();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "restart_allowed",
      activeRunCount: 0,
      oldestRunStartedAt: null,
      oldestRunAgeMs: null,
    });
    expect(drain).toMatchObject({
      mode: "draining",
      source: "operator",
      reason: "planned_restart",
      deferredCount: 0,
    });
  });

  it("allows emergency service restart without storing free-form reason text", async () => {
    const db = createDrainDbStub({
      activeRunCount: 1,
      oldestRunStartedAt: new Date("2026-03-20T11:45:00.000Z"),
      activeCompanyIds: ["company-1"],
    }) as Db & { _insertedActivities: Array<{ details?: Record<string, unknown> }> };
    const app = express();
    app.use(express.json());
    app.use("/health", healthRoutes(db));

    const res = await request(app)
      .post("/health/service-restart/check")
      .send({
        emergency: true,
        emergencyReasonProvided: true,
        emergencyReasonCategory: "security_update",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "restart_allowed_emergency",
      activeRunCount: 1,
      oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
    });
    expect(db._insertedActivities).toHaveLength(1);
    expect(db._insertedActivities[0].details).toMatchObject({
      activeRunCount: 1,
      oldestRunStartedAt: "2026-03-20T11:45:00.000Z",
      emergencyReasonPresent: true,
      emergencyReasonCategory: "security_update",
    });
    expect(JSON.stringify(db._insertedActivities[0].details)).not.toContain("operator accepted");
    expect(db._insertedActivities[0].details).not.toHaveProperty("reason");
  });
});
