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
  createEmbeddedPostgresHandoffLogContext,
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

  it.each(["SIGINT", "SIGTERM", "SIGBREAK"] as const)(
    "leaves %s exclusively coordinated by the application when autoShutdown is false",
    (signal) => {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "const { default: EmbeddedPostgres } = await import('embedded-postgres');",
          "const instance = new EmbeddedPostgres({ autoShutdown: false });",
          "instance.stop = async () => console.log('UNCOMMANDED_DATABASE_STOP');",
          `process.once(${JSON.stringify(signal)}, async () => {`,
          "  console.log('APP_HANDLER_STARTED');",
          "  await new Promise((resolve) => setTimeout(resolve, 50));",
          "  console.log('APP_HANDLER_COMPLETED');",
          "  process.exit(0);",
          "});",
          `process.emit(${JSON.stringify(signal)});`,
        ].join("\n"),
      ],
      {
        cwd: resolve(process.cwd(), "server"),
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(child.stdout).toContain("APP_HANDLER_STARTED");
    expect(child.stdout).toContain("APP_HANDLER_COMPLETED");
    expect(child.stdout).not.toContain("UNCOMMANDED_DATABASE_STOP");
    },
  );

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
      persistHotRestartHandoff: vi.fn(async () => undefined),
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

  it("stops the owned database when hot-restart handoff persistence fails", async () => {
    const writeError = new Error("forced handoff write failure");
    const stop = vi.fn(async () => undefined);
    const onHotRestartHandoffFailure = vi.fn();

    const result = await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: true,
      stop,
      lifecycle: createShutdownLifecycleContext({
        signal: "SIGTERM",
        hotRestart: { skipDrain: true },
      }),
      persistHotRestartHandoff: vi.fn(async () => {
        throw writeError;
      }),
      onHotRestartHandoffFailure,
    });

    expect(result).toBe("stopped");
    expect(stop).toHaveBeenCalledOnce();
    expect(onHotRestartHandoffFailure).toHaveBeenCalledWith(writeError);
  });

  it("keeps the predecessor outside systemd's stop lifecycle when handoff and stop both fail", () => {
    const shutdownModuleUrl = new URL("./shutdown.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        resolve(process.cwd(), "server/node_modules/tsx/dist/cli.mjs"),
        "--eval",
        [
          "void (async () => {",
          `const { createShutdownLifecycleContext, prepareEmbeddedPostgresForHotRestart, restoreAbortedHotRestartPredecessor } = await import(${JSON.stringify(shutdownModuleUrl)});`,
          "let schedulerStopped = true;",
          "let schedulerTicks = 0;",
          "let telemetryRunning = true;",
          "let mirrorsRunning = true;",
          "let appRunning = true;",
          "const serviceManagerNotifications = [];",
          "let serviceManagerStopping = false;",
          "let handoffAttempts = 0;",
          "let stopAttempts = 0;",
          "const notifyServiceManager = async (args) => { serviceManagerNotifications.push(args); if (args[0] === '--stopping') serviceManagerStopping = true; return true; };",
          "const scheduler = setInterval(() => { if (!schedulerStopped) schedulerTicks += 1; }, 5);",
          "process.once('SIGTERM', async () => {",
          "  const result = await prepareEmbeddedPostgresForHotRestart({",
          "    ownedByThisProcess: true,",
          "    stop: async () => { stopAttempts += 1; throw new Error('forced stop failure'); },",
          "    lifecycle: createShutdownLifecycleContext({ signal: 'SIGTERM', hotRestart: { skipDrain: true } }),",
          "    persistHotRestartHandoff: async () => { handoffAttempts += 1; throw new Error('forced handoff failure'); },",
          "    restorePredecessor: () => restoreAbortedHotRestartPredecessor({",
          "      signal: 'SIGTERM',",
          "      restartHeartbeatScheduler: () => { schedulerStopped = false; },",
          "      notifyServiceManager,",
          "    }),",
          "  });",
          "  if (result !== 'aborted') { await notifyServiceManager(['--stopping', '--status=Stopping after SIGTERM']); telemetryRunning = false; mirrorsRunning = false; appRunning = false; }",
          "  setTimeout(() => {",
          "    const state = { result, schedulerTicks, telemetryRunning, mirrorsRunning, appRunning, serviceManagerStopping, serviceManagerNotifications, handoffAttempts, stopAttempts };",
          "    console.log(JSON.stringify(state));",
          "    clearInterval(scheduler);",
          "    process.exit(result === 'aborted' && schedulerTicks > 0 && telemetryRunning && mirrorsRunning && appRunning && !serviceManagerStopping && serviceManagerNotifications.length === 1 && serviceManagerNotifications[0][0] === '--ready' && serviceManagerNotifications[0][1] === '--status=Hot restart aborted after SIGTERM; predecessor remains operational' && handoffAttempts === 1 && stopAttempts === 1 ? 0 : 1);",
          "  }, 50);",
          "});",
          "process.emit('SIGTERM');",
          "})();",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(child.stdout).toContain('"result":"aborted"');
    expect(child.stdout).toContain('"telemetryRunning":true');
    expect(child.stdout).toContain('"mirrorsRunning":true');
    expect(child.stdout).toContain('"appRunning":true');
    expect(child.stdout).toContain('"serviceManagerStopping":false');
    expect(child.stdout).toContain('"serviceManagerNotifications":[["--ready","--status=Hot restart aborted after SIGTERM; predecessor remains operational"]]');
    expect(child.stdout).toContain('"handoffAttempts":1');
    expect(child.stdout).toContain('"stopAttempts":1');
  });

  it("omits the handoff transfer token from issued and claimed log context", () => {
    const handoff = {
      version: 1 as const,
      transferToken: "do-not-log-this-token",
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
    };

    const issuedContext = createEmbeddedPostgresHandoffLogContext(handoff);
    const claimedContext = createEmbeddedPostgresHandoffLogContext({
      ...handoff,
      replacementServerPid: 4343,
    });

    expect(issuedContext).toEqual({
      postgresPid: 54321,
      port: 5432,
      predecessorServerPid,
      expiresAt: "2026-07-31T15:10:05.000Z",
    });
    expect(claimedContext).toEqual({
      postgresPid: 54321,
      port: 5432,
      predecessorServerPid,
      replacementServerPid: 4343,
      expiresAt: "2026-07-31T15:10:05.000Z",
    });
    expect(JSON.stringify({ issuedContext, claimedContext })).not.toContain(handoff.transferToken);
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
      persistHotRestartHandoff: vi.fn(async () => undefined),
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
