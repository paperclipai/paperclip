import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adoptEmbeddedPostgres,
  coordinateEmbeddedPostgresShutdown,
  coordinateHeartbeatSchedulerShutdown,
  createShutdownLifecycleContext,
} from "./shutdown.js";

describe("coordinateEmbeddedPostgresShutdown", () => {
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

    const stopAdoptedDatabase = adoptEmbeddedPostgres(replacement);
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
