import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());
const testServerInfo = {
  processStartedAt: "2026-06-26T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    branchName: "master",
    subject: "Add server info debug view",
    committedAt: "2026-06-25T23:00:00.000Z",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  },
} as const;

function createHealthyDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  } as unknown as Db;
}

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(
  db?: Db,
  serverInfo = testServerInfo,
  databaseBackupHealth?: Parameters<typeof healthRoutes>[1]["databaseBackupHealth"],
) {
  const app = express();
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      serverInfo,
      databaseBackupHealth,
    }),
  );
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
    expect(res.body).toEqual({ status: "ok", version: serverVersion, serverVersion: serverVersion, serverInfo: testServerInfo });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      serverInfo: testServerInfo,
    });
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
      serverVersion,
      error: "database_unreachable",
      serverInfo: testServerInfo,
    });
  });

  it("returns safe server info fallbacks when git metadata is unavailable", async () => {
    const app = createApp(undefined, {
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.serverInfo).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });

  it("surfaces a stale database backup warning in full health details", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260705-031702.sql.gz");
    fs.writeFileSync(backupFile, "backup");
    fs.utimesSync(
      backupFile,
      new Date("2026-07-05T03:17:02.000Z"),
      new Date("2026-07-05T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T13:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      backupDir,
      maxAgeHours: 26,
      latestBackup: {
        name: "paperclip-20260705-031702.sql.gz",
        ageHours: 33.7,
      },
      warnings: [
        {
          code: "database_backup_stale",
        },
      ],
    });
    expect(res.body.warnings).toEqual(res.body.databaseBackup.warnings);
  });

  it("surfaces database backup failure markers in full health details", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    const alertFile = path.join(backupDir, "db-backup-to-s3.failure");
    fs.writeFileSync(backupFile, "backup");
    fs.writeFileSync(alertFile, "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1\n");
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      alertFile,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      lastFailure: {
        path: alertFile,
        message: "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1",
      },
      warnings: [
        {
          code: "database_backup_last_failure",
          message: "db-backup-to-s3 failed at 2026-07-06T03:17:00.000Z exit=1",
        },
      ],
    });
  });

  it("finds conventional database backup failure markers without an explicit alert file", async () => {
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-root-"));
    const backupDir = path.join(backupRoot, "backups");
    fs.mkdirSync(backupDir);
    const backupFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    const alertFile = path.join(backupRoot, "db-backup-to-s3.failure");
    fs.writeFileSync(backupFile, "backup");
    fs.writeFileSync(alertFile, "db-backup-to-s3 failed beside backups\n");
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      lastFailure: {
        path: alertFile,
        message: "db-backup-to-s3 failed beside backups",
      },
      warnings: [
        {
          code: "database_backup_last_failure",
          message: "db-backup-to-s3 failed beside backups",
        },
      ],
    });
  });

  it("surfaces redacted database backup warnings for anonymous authenticated probes", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-redacted-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260705-031702.sql.gz");
    fs.writeFileSync(backupFile, "backup");
    fs.utimesSync(
      backupFile,
      new Date("2026-07-05T03:17:02.000Z"),
      new Date("2026-07-05T03:17:02.000Z"),
    );
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
        serverInfo: testServerInfo,
        databaseBackupHealth: {
          enabled: true,
          backupDir,
          maxAgeHours: 26,
          now: new Date("2026-07-06T13:00:00.000Z"),
        },
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
      databaseBackup: {
        enabled: true,
        status: "warning",
        warnings: [
          {
            code: "database_backup_stale",
            message: "Latest database backup is stale.",
          },
        ],
      },
      warnings: [
        {
          code: "database_backup_stale",
          message: "Latest database backup is stale.",
        },
      ],
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
        serverInfo: testServerInfo,
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
    expect(res.body.serverInfo).toBeUndefined();
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
        serverInfo: testServerInfo,
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
    expect(res.body.serverInfo).toBeUndefined();
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
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
      serverInfo: testServerInfo,
    });
  });
});
