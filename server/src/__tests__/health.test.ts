import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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

const completeGzipArchive = () => gzipSync(Buffer.from("-- PostgreSQL database dump\n"));
const truncatedGzipArchive = () => completeGzipArchive().subarray(0, 12);

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
    expect(res.body).toEqual({ status: "ok", version: serverVersion, serverInfo: testServerInfo });
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
    fs.writeFileSync(backupFile, completeGzipArchive());
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

  it("ignores zero-byte and in-progress .partial archives when picking the latest backup", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const goodBackup = path.join(backupDir, "paperclip-20260705-031702.sql.gz");
    fs.writeFileSync(goodBackup, completeGzipArchive());
    fs.utimesSync(
      goodBackup,
      new Date("2026-07-05T03:17:02.000Z"),
      new Date("2026-07-05T03:17:02.000Z"),
    );
    const emptyBackup = path.join(backupDir, "paperclip-20260706-120000.sql.gz");
    fs.writeFileSync(emptyBackup, "");
    fs.utimesSync(
      emptyBackup,
      new Date("2026-07-06T12:00:00.000Z"),
      new Date("2026-07-06T12:00:00.000Z"),
    );
    const partialBackup = path.join(backupDir, "paperclip-20260706-123000.sql.gz.partial");
    fs.writeFileSync(partialBackup, "in-progress dump");
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
      latestBackup: {
        name: "paperclip-20260705-031702.sql.gz",
      },
      warnings: [
        {
          code: "database_backup_stale",
        },
      ],
    });
  });

  it("skips a truncated newest archive, warns, and falls back to the previous complete backup", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const completeBackup = path.join(backupDir, "paperclip-20260706-120000.sql.gz");
    fs.writeFileSync(completeBackup, completeGzipArchive());
    fs.utimesSync(
      completeBackup,
      new Date("2026-07-06T12:00:00.000Z"),
      new Date("2026-07-06T12:00:00.000Z"),
    );
    const truncatedBackup = path.join(backupDir, "paperclip-20260706-124500.sql.gz");
    fs.writeFileSync(truncatedBackup, truncatedGzipArchive());
    fs.utimesSync(
      truncatedBackup,
      new Date("2026-07-06T12:45:00.000Z"),
      new Date("2026-07-06T12:45:00.000Z"),
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
      latestBackup: {
        name: "paperclip-20260706-120000.sql.gz",
      },
      warnings: [
        {
          code: "database_backup_corrupt",
          message: expect.stringContaining("paperclip-20260706-124500.sql.gz"),
        },
      ],
    });
  });

  it("reports backups missing when every archive is an incomplete gzip stream", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const truncatedBackup = path.join(backupDir, "paperclip-20260706-124500.sql.gz");
    fs.writeFileSync(truncatedBackup, truncatedGzipArchive());
    fs.utimesSync(
      truncatedBackup,
      new Date("2026-07-06T12:45:00.000Z"),
      new Date("2026-07-06T12:45:00.000Z"),
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
      latestBackup: null,
      warnings: [
        {
          code: "database_backup_missing",
        },
        {
          code: "database_backup_corrupt",
        },
      ],
    });
  });

  it("honors sub-hour max age thresholds", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260706-121500.sql.gz");
    fs.writeFileSync(backupFile, completeGzipArchive());
    fs.utimesSync(
      backupFile,
      new Date("2026-07-06T12:15:00.000Z"),
      new Date("2026-07-06T12:15:00.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 0.5,
      now: new Date("2026-07-06T13:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      maxAgeHours: 0.5,
      latestBackup: {
        ageHours: 0.8,
      },
      warnings: [
        {
          code: "database_backup_stale",
        },
      ],
    });
  });

  it("warns instead of reporting fresh when the latest backup mtime is in the future", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260707-120000.sql.gz");
    fs.writeFileSync(backupFile, completeGzipArchive());
    fs.utimesSync(
      backupFile,
      new Date("2026-07-07T12:00:00.000Z"),
      new Date("2026-07-07T12:00:00.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T12:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      latestBackup: {
        name: "paperclip-20260707-120000.sql.gz",
        ageHours: -24,
      },
      warnings: [
        {
          code: "database_backup_clock_skew",
        },
      ],
    });
  });

  it("surfaces database backup failure markers in full health details", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    const alertFile = path.join(backupDir, "db-backup-to-s3.failure");
    fs.writeFileSync(backupFile, completeGzipArchive());
    fs.utimesSync(
      backupFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
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
