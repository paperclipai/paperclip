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

// Large enough to clear the minimum-plausible-size backup check.
const plausibleBackupContent = "x".repeat(4096);

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(
  db?: Db,
  serverInfo = testServerInfo,
  databaseBackupHealth?: Parameters<typeof healthRoutes>[1]["databaseBackupHealth"],
  runtimeEnv?: Parameters<typeof healthRoutes>[1]["runtimeEnv"],
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
      runtimeEnv,
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
    vi.unstubAllEnvs();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion, serverVersion: serverVersion, commit: testServerInfo.git.fullSha, serverInfo: testServerInfo });
  }, 15_000);

  it("keeps the self-hosted health response byte-identical and omits cloud", async () => {
    const app = createApp(undefined, testServerInfo, undefined, {});

    const res = await request(app).get("/health");

    const baseline = {
      status: "ok",
      version: serverVersion,
      serverVersion,
      commit: testServerInfo.git.fullSha,
      serverInfo: testServerInfo,
    };
    expect(res.text).toBe(JSON.stringify(baseline));
    expect(Object.prototype.hasOwnProperty.call(res.body, "cloud")).toBe(false);
  });

  it("exposes public stack metadata on cloud-simulated health", async () => {
    const app = createApp(undefined, testServerInfo, undefined, {
      PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
      PAPERCLIP_CLOUD_STACK_ID: "stack-1",
      PAPERCLIP_STACK_SLUG: "acme",
      PAPERCLIP_CLOUD_ACCOUNT_GROUP_ID: "account-group-1",
      PAPERCLIP_PRIMARY_HOST: "acme.paperclip.app",
      PAPERCLIP_CLOUD_API_ORIGIN: "https://app.paperclip.app",
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.cloud).toEqual({
      managed: true,
      managedBy: "paperclip-cloud",
      stackSlug: "acme",
      cloudBaseUrl: "https://app.paperclip.app",
    });
  });

  it("lists operator-hidden settings and drops unknown keys", async () => {
    const app = createApp(undefined, testServerInfo, undefined, {
      PAPERCLIP_HIDDEN_SETTINGS: "instance.plugins,instance.adapters,instance.bogus",
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.hiddenSettings).toEqual(["instance.plugins", "instance.adapters"]);
  });

  it("omits hiddenSettings entirely when nothing is hidden", async () => {
    const app = createApp(undefined, testServerInfo, undefined, {});

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, "hiddenSettings")).toBe(false);
  });

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
      commit: testServerInfo.git.fullSha,
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
    // With no git metadata baked in, the exposed commit is null (not omitted).
    expect(res.body.commit).toBeNull();
  });

  it("surfaces a stale database backup warning in full health details", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260705-031702.sql.gz");
    fs.writeFileSync(backupFile, plausibleBackupContent);
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
    fs.writeFileSync(backupFile, plausibleBackupContent);
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
    fs.writeFileSync(backupFile, plausibleBackupContent);
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

  it("warns when the latest database backup is implausibly small", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-tiny-backup-"));
    const backupFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    fs.writeFileSync(backupFile, Buffer.alloc(20));
    fs.utimesSync(
      backupFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    // Fresh enough to pass the age check, so only the size check fires.
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      latestBackup: {
        name: "paperclip-20260706-031702.sql.gz",
        sizeBytes: 20,
      },
      warnings: [
        {
          code: "database_backup_too_small",
        },
      ],
    });
    expect(res.body.databaseBackup.warnings[0].message).toContain("20 bytes");
  });

  it("warns when the latest backup collapses versus the recent median size", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-median-backup-"));
    for (let day = 1; day <= 4; day += 1) {
      const prior = path.join(backupDir, `paperclip-2026070${day}-031702.sql.gz`);
      fs.writeFileSync(prior, Buffer.alloc(100_000));
      fs.utimesSync(
        prior,
        new Date(`2026-07-0${day}T03:17:02.000Z`),
        new Date(`2026-07-0${day}T03:17:02.000Z`),
      );
    }
    const latestFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    fs.writeFileSync(latestFile, Buffer.alloc(5_000));
    fs.utimesSync(
      latestFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    // 5 KB clears the absolute floor but is under 10% of the 100 KB median.
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      warnings: [
        {
          code: "database_backup_too_small",
        },
      ],
    });
    expect(res.body.databaseBackup.warnings[0].message).toContain("median");
  });

  it("keeps database backup status ok when the latest backup shrinks moderately", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-shrunk-backup-"));
    for (let day = 1; day <= 4; day += 1) {
      const prior = path.join(backupDir, `paperclip-2026070${day}-031702.sql.gz`);
      fs.writeFileSync(prior, Buffer.alloc(100_000));
      fs.utimesSync(
        prior,
        new Date(`2026-07-0${day}T03:17:02.000Z`),
        new Date(`2026-07-0${day}T03:17:02.000Z`),
      );
    }
    const latestFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    fs.writeFileSync(latestFile, Buffer.alloc(60_000));
    fs.utimesSync(
      latestFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.databaseBackup).toMatchObject({
      status: "ok",
      warnings: [],
    });
  });

  it("ignores other filename prefixes when judging the latest backup against the median", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-mixed-prefix-"));
    // A foreign stream of much larger backups sharing the directory — a
    // directory-wide median would flag the healthy paperclip stream below.
    for (let day = 1; day <= 4; day += 1) {
      const other = path.join(backupDir, `other-2026070${day}-120000.sql.gz`);
      fs.writeFileSync(other, Buffer.alloc(10_000_000));
      fs.utimesSync(
        other,
        new Date(`2026-07-0${day}T12:00:00.000Z`),
        new Date(`2026-07-0${day}T12:00:00.000Z`),
      );
      const prior = path.join(backupDir, `paperclip-2026070${day}-031702.sql.gz`);
      fs.writeFileSync(prior, Buffer.alloc(100_000));
      fs.utimesSync(
        prior,
        new Date(`2026-07-0${day}T03:17:02.000Z`),
        new Date(`2026-07-0${day}T03:17:02.000Z`),
      );
    }
    const latestFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    fs.writeFileSync(latestFile, Buffer.alloc(60_000));
    fs.utimesSync(
      latestFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    // 60 KB vs the paperclip-stream median of 100 KB is a moderate shrink,
    // not a collapse; the 10 MB foreign stream must not change that call.
    expect(res.body.databaseBackup).toMatchObject({
      status: "ok",
      warnings: [],
    });
  });

  it("still detects a collapsed backup when tiny foreign-prefix files share the directory", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-mixed-collapse-"));
    // Tiny foreign files would drag a directory-wide median down far enough
    // to hide the paperclip stream's collapse.
    for (let day = 1; day <= 4; day += 1) {
      const other = path.join(backupDir, `other-2026070${day}-120000.sql.gz`);
      fs.writeFileSync(other, Buffer.alloc(2_000));
      fs.utimesSync(
        other,
        new Date(`2026-07-0${day}T12:00:00.000Z`),
        new Date(`2026-07-0${day}T12:00:00.000Z`),
      );
      const prior = path.join(backupDir, `paperclip-2026070${day}-031702.sql.gz`);
      fs.writeFileSync(prior, Buffer.alloc(100_000));
      fs.utimesSync(
        prior,
        new Date(`2026-07-0${day}T03:17:02.000Z`),
        new Date(`2026-07-0${day}T03:17:02.000Z`),
      );
    }
    const latestFile = path.join(backupDir, "paperclip-20260706-031702.sql.gz");
    fs.writeFileSync(latestFile, Buffer.alloc(5_000));
    fs.utimesSync(
      latestFile,
      new Date("2026-07-06T03:17:02.000Z"),
      new Date("2026-07-06T03:17:02.000Z"),
    );
    const app = createApp(createHealthyDb(), testServerInfo, {
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date("2026-07-06T04:00:00.000Z"),
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    // 5 KB is under 10% of the paperclip-stream median of 100 KB.
    expect(res.body.databaseBackup).toMatchObject({
      status: "warning",
      warnings: [
        {
          code: "database_backup_too_small",
        },
      ],
    });
    expect(res.body.databaseBackup.warnings[0].message).toContain("median");
  });

  it("surfaces redacted database backup warnings for anonymous authenticated probes", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-redacted-backups-"));
    const backupFile = path.join(backupDir, "paperclip-20260705-031702.sql.gz");
    fs.writeFileSync(backupFile, plausibleBackupContent);
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
      commit: testServerInfo.git.fullSha,
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
      commit: testServerInfo.git.fullSha,
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
      commit: testServerInfo.git.fullSha,
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

  it("reports bootstrap_pending in authenticated mode when no instance admin exists", async () => {
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
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
    expect(res.body).toMatchObject({
      status: "ok",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
  });

  it("reports bootstrapStatus ready for cloud-managed instances regardless of instance admin count", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-tenant-server-token");
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
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
    expect(res.body).toMatchObject({
      status: "ok",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });
});
