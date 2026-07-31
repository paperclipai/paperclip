import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimEmbeddedPostgresHandoff,
  readEmbeddedPostgresProcessIdentity,
  writeEmbeddedPostgresHandoff,
  type EmbeddedPostgresProcessIdentity,
} from "./services/hot-restart.js";
import {
  adoptEmbeddedPostgres,
  coordinateEmbeddedPostgresShutdown,
  coordinateHeartbeatSchedulerShutdown,
  createShutdownLifecycleContext,
} from "./shutdown.js";

describe("coordinateEmbeddedPostgresShutdown", () => {
  const hotRestartRequestedAt = "2026-07-31T15:00:00.000Z";
  const shutdownSnapshotCapturedAt = "2026-07-31T15:00:04.000Z";
  const predecessorServerPid = 4242;

  async function withHandoffHome(
    run: (homeDir: string, postgres: EmbeddedPostgresProcessIdentity) => Promise<void>,
  ) {
    const homeDir = await fs.mkdtemp(resolve(os.tmpdir(), "paperclip-postgres-handoff-"));
    const postgres: EmbeddedPostgresProcessIdentity = {
      pid: 54321,
      startedAtEpochSeconds: 1_754_000_000,
      dataDir: resolve(homeDir, "postgres"),
      port: 5432,
    };
    try {
      await writeEmbeddedPostgresHandoff({
        hotRestartRequestedAt,
        shutdownSnapshotCapturedAt,
        predecessorServerPid,
        predecessorServerStartedAtEpochMs: 1_753_999_900_000,
        postgres,
        now: new Date("2026-07-31T15:00:05.000Z"),
        homeDir,
      });
      await run(homeDir, postgres);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  }

  it("prevents the dependency signal hook from stopping an application-owned database", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "const { default: EmbeddedPostgres } = await import('embedded-postgres');",
          "const instance = new EmbeddedPostgres({ autoShutdown: false });",
          "instance.stop = async () => console.log('UNCOMMANDED_DATABASE_STOP');",
          "process.emit('SIGTERM');",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      ],
      {
        cwd: resolve(process.cwd(), "server"),
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.stdout).not.toContain("UNCOMMANDED_DATABASE_STOP");
  });

  it("preserves the database and active work for a validated hot restart", async () => {
    const activeWork = { transactionOpen: true, childRunAlive: true };
    const stop = vi.fn(async () => {
      activeWork.transactionOpen = false;
      activeWork.childRunAlive = false;
    });
    const lifecycle = createShutdownLifecycleContext({
      signal: "SIGTERM",
      hotRestart: { skipDrain: true },
      parentPid: 4242,
      launcherIdentity: "node:paperclipai",
      uptimeMs: 15_000,
    });

    const result = await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: true,
      stop,
      lifecycle,
    });

    expect(result).toBe("preserved_for_hot_restart");
    expect(stop).not.toHaveBeenCalled();
    expect(activeWork).toEqual({ transactionOpen: true, childRunAlive: true });
    expect(lifecycle).toEqual({
      controlEvent: "SIGTERM",
      parentPid: 4242,
      launcherIdentity: "node:paperclipai",
      uptimeMs: 15_000,
      shutdownInitiator: "hot_restart_intent",
      preserveEmbeddedPostgres: true,
    });
  });

  it("stops an owned database during a normal graceful shutdown", async () => {
    const stop = vi.fn(async () => undefined);

    const result = await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: true,
      stop,
      lifecycle: createShutdownLifecycleContext({
        signal: "SIGINT",
        hotRestart: { skipDrain: false },
      }),
    });

    expect(result).toBe("stopped");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not stop a database owned by another server process", async () => {
    const stop = vi.fn(async () => undefined);

    const result = await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: false,
      stop,
      lifecycle: createShutdownLifecycleContext({
        signal: "SIGTERM",
        hotRestart: null,
      }),
    });

    expect(result).toBe("not_owned");
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not let an unrelated concurrent server acquire database stop authority", async () => {
    await withHandoffHome(async (homeDir, postgres) => {
      const replacement = {
        adopt: vi.fn(),
        stop: vi.fn(async () => undefined),
      };
      const claim = await claimEmbeddedPostgresHandoff({
        expectedHotRestartRequestedAt: hotRestartRequestedAt,
        expectedShutdownSnapshotCapturedAt: shutdownSnapshotCapturedAt,
        expectedPredecessorServerPid: predecessorServerPid,
        expectedPostgres: postgres,
        replacementServerPid: 4343,
        isProcessAlive: () => true,
        now: new Date("2026-07-31T15:00:06.000Z"),
        homeDir,
      });

      const stopAdoptedDatabase = adoptEmbeddedPostgres(replacement, claim);
      const result = await coordinateEmbeddedPostgresShutdown({
        ownedByThisProcess: stopAdoptedDatabase !== null,
        stop: stopAdoptedDatabase,
        lifecycle: createShutdownLifecycleContext({
          signal: "SIGTERM",
          hotRestart: null,
        }),
      });

      expect(claim).toBeNull();
      expect(replacement.adopt).not.toHaveBeenCalled();
      expect(replacement.stop).not.toHaveBeenCalled();
      expect(result).toBe("not_owned");
    });
  });

  it("reads the PostgreSQL PID, start time, canonical data directory, and port as one identity", async () => {
    const homeDir = await fs.mkdtemp(resolve(os.tmpdir(), "paperclip-postgres-identity-"));
    const dataDir = resolve(homeDir, "postgres");
    try {
      await fs.mkdir(dataDir);
      await fs.writeFile(
        resolve(dataDir, "postmaster.pid"),
        ["54321", dataDir, "1754000000", "5432", "", "127.0.0.1", "", "ready", ""].join("\n"),
        "utf8",
      );

      await expect(readEmbeddedPostgresProcessIdentity(dataDir)).resolves.toEqual({
        pid: 54321,
        startedAtEpochSeconds: 1_754_000_000,
        dataDir: await fs.realpath(dataDir),
        port: 5432,
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("binds a one-time claim to the intended PostgreSQL process identity", async () => {
    await withHandoffHome(async (homeDir, postgres) => {
      const mismatchedClaim = await claimEmbeddedPostgresHandoff({
        expectedHotRestartRequestedAt: hotRestartRequestedAt,
        expectedShutdownSnapshotCapturedAt: shutdownSnapshotCapturedAt,
        expectedPredecessorServerPid: predecessorServerPid,
        expectedPostgres: { ...postgres, startedAtEpochSeconds: postgres.startedAtEpochSeconds + 1 },
        replacementServerPid: 4343,
        isProcessAlive: () => false,
        now: new Date("2026-07-31T15:00:06.000Z"),
        homeDir,
      });
      expect(mismatchedClaim).toBeNull();

      const claim = await claimEmbeddedPostgresHandoff({
        expectedHotRestartRequestedAt: hotRestartRequestedAt,
        expectedShutdownSnapshotCapturedAt: shutdownSnapshotCapturedAt,
        expectedPredecessorServerPid: predecessorServerPid,
        expectedPostgres: postgres,
        replacementServerPid: 4343,
        isProcessAlive: () => false,
        now: new Date("2026-07-31T15:00:06.000Z"),
        homeDir,
      });
      const replay = await claimEmbeddedPostgresHandoff({
        expectedHotRestartRequestedAt: hotRestartRequestedAt,
        expectedShutdownSnapshotCapturedAt: shutdownSnapshotCapturedAt,
        expectedPredecessorServerPid: predecessorServerPid,
        expectedPostgres: postgres,
        replacementServerPid: 4444,
        isProcessAlive: () => false,
        now: new Date("2026-07-31T15:00:07.000Z"),
        homeDir,
      });

      expect(claim).toMatchObject({
        predecessorServerPid,
        replacementServerPid: 4343,
        postgres,
      });
      expect(replay).toBeNull();
    });
  });

  it("transfers ownership so a replacement can stop the preserved database", async () => {
    const originalStop = vi.fn(async () => undefined);
    const replacement = {
      adopt: vi.fn(),
      stop: vi.fn(async () => undefined),
    };

    await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: true,
      stop: originalStop,
      lifecycle: createShutdownLifecycleContext({
        signal: "SIGTERM",
        hotRestart: { skipDrain: true },
      }),
    });

    const stopAdoptedDatabase = adoptEmbeddedPostgres(replacement, {
      version: 1,
      transferToken: "test-transfer",
      createdAt: "2026-07-31T15:00:05.000Z",
      expiresAt: "2026-07-31T15:10:05.000Z",
      hotRestartRequestedAt,
      shutdownSnapshotCapturedAt,
      predecessorServerPid,
      predecessorServerStartedAtEpochMs: 1_753_999_900_000,
      postgres: {
        pid: 54321,
        startedAtEpochSeconds: 1_754_000_000,
        dataDir: "/paperclip/postgres",
        port: 5432,
      },
      replacementServerPid: 4343,
    });
    const result = await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: true,
      stop: stopAdoptedDatabase,
      lifecycle: createShutdownLifecycleContext({
        signal: "SIGTERM",
        hotRestart: null,
      }),
    });

    expect(originalStop).not.toHaveBeenCalled();
    expect(replacement.adopt).toHaveBeenCalledOnce();
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(result).toBe("stopped");
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("captures a hot-restart snapshot without waiting for active scheduler work", async () => {
    let snapshotCaptured = false;
    const waitForHeartbeatSchedulerIdle = vi.fn(() => new Promise<void>(() => undefined));

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(snapshotCaptured).toBe(true);
    expect(waitForHeartbeatSchedulerIdle).not.toHaveBeenCalled();
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: false,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
    });
  });
});
