import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  coordinateHeartbeatSchedulerShutdown,
  finalizeServerShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
} from "./shutdown.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("finalizeServerShutdown", () => {
  it("awaits the setup-token cleanup before the database stop and the process exit", async () => {
    const order: string[] = [];
    // The held promise models the setup-token session cancellation and its
    // sandbox lease release. The teardown must not continue while it is pending.
    const release = deferred();
    const shutdownAppServices = vi.fn(async () => {
      order.push("appServices:start");
      await release.promise;
      order.push("appServices:settled");
    });
    const stopEmbeddedPostgres = vi.fn(async () => {
      order.push("postgres:stop");
    });
    const shutdownInstrumentation = vi.fn(async () => {
      order.push("instrumentation:flush");
    });

    let exited = false;
    const finalize = finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices,
      stopEmbeddedPostgres,
      shutdownInstrumentation,
      log: stubLogger(),
    }).then(() => {
      // This models the caller's `process.exit(0)` continuation.
      exited = true;
      order.push("exit");
    });

    // The cleanup is in flight. The database stop, the instrumentation flush,
    // and the process exit continuation must all wait for it to settle.
    await vi.waitFor(() => expect(shutdownAppServices).toHaveBeenCalledOnce());
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(shutdownInstrumentation).not.toHaveBeenCalled();
    expect(exited).toBe(false);

    release.resolve();
    await finalize;

    expect(exited).toBe(true);
    expect(order).toEqual([
      "appServices:start",
      "appServices:settled",
      "postgres:stop",
      "instrumentation:flush",
      "exit",
    ]);
  });

  it("keeps the teardown durable and still exits when the setup-token release fails", async () => {
    const order: string[] = [];
    // The held promise rejects, which models a lease release that failed. The
    // reaper owns the durable retry, so the teardown must log the failure and
    // continue rather than swallow it or block the exit.
    const release = deferred();
    const releaseError = new Error("lease release failed");
    const shutdownAppServices = vi.fn(async () => {
      await release.promise;
    });
    const stopEmbeddedPostgres = vi.fn(async () => {
      order.push("postgres:stop");
    });
    const shutdownInstrumentation = vi.fn(async () => {
      order.push("instrumentation:flush");
    });
    const log = stubLogger();

    let exited = false;
    const finalize = finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices,
      stopEmbeddedPostgres,
      shutdownInstrumentation,
      log,
    }).then(() => {
      exited = true;
    });

    await vi.waitFor(() => expect(shutdownAppServices).toHaveBeenCalledOnce());
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(exited).toBe(false);

    release.reject(releaseError);
    await finalize;

    // The teardown surfaced the failure in the log, then finished the ordered
    // teardown and reached the exit continuation.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: releaseError, signal: "SIGTERM" }),
      expect.any(String),
    );
    expect(order).toEqual(["postgres:stop", "instrumentation:flush"]);
    expect(exited).toBe(true);
  });

  it("skips the database stop when no embedded PostgreSQL runs in this process", async () => {
    const shutdownAppServices = vi.fn(async () => undefined);
    const shutdownInstrumentation = vi.fn(async () => undefined);
    const log = stubLogger();

    await finalizeServerShutdown({
      signal: "SIGINT",
      shutdownAppServices,
      stopEmbeddedPostgres: null,
      shutdownInstrumentation,
      log,
    });

    expect(shutdownAppServices).toHaveBeenCalledOnce();
    expect(shutdownInstrumentation).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("loadWithoutCoordinatedShutdownSignalHooks", () => {
  it("removes the eager signal handlers from the real embedded-postgres import", async () => {
    const before = {
      SIGINT: process.rawListeners("SIGINT"),
      SIGTERM: process.rawListeners("SIGTERM"),
    };
    const moduleName = "embedded-postgres";

    await loadWithoutCoordinatedShutdownSignalHooks(() => import(moduleName));

    expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.rawListeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("keeps the database available for a marker-backed SIGTERM snapshot", async () => {
    const signalTarget = new EventEmitter();
    const preexistingSignalListener = vi.fn();
    signalTarget.on("SIGTERM", preexistingSignalListener);

    let databaseAvailable = true;
    const embeddedPostgresExitHook = vi.fn(() => {
      databaseAvailable = false;
    });
    await loadWithoutCoordinatedShutdownSignalHooks(
      async () => {
        signalTarget.on("SIGINT", embeddedPostgresExitHook);
        signalTarget.on("SIGTERM", embeddedPostgresExitHook);
        return { default: class EmbeddedPostgres {} };
      },
      signalTarget,
    );

    let shutdown: Promise<unknown> | null = null;
    let snapshotCaptured = false;
    signalTarget.once("SIGTERM", () => {
      shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: async () => {
          // This models the real failure path: a valid intent exists, and the
          // snapshot must query embedded PostgreSQL after SIGTERM is delivered.
          expect(databaseAvailable).toBe(true);
          snapshotCaptured = true;
          return { mode: "hot_restart" as const, skipDrain: true };
        },
        waitForHeartbeatSchedulerIdle: vi.fn(async () => undefined),
      });
    });

    signalTarget.emit("SIGTERM");
    await shutdown;

    expect(preexistingSignalListener).toHaveBeenCalledOnce();
    expect(embeddedPostgresExitHook).not.toHaveBeenCalled();
    expect(snapshotCaptured).toBe(true);
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("quiesces active scheduler work before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseScheduler();

    const result = await shutdown;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("quiesces scheduler work before selecting server-stdio runs to drain", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "acp_drain_required" as const,
        skipDrain: false,
        drainRunIds: ["acp-run"],
      })),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: {
        mode: "acp_drain_required",
        skipDrain: false,
        drainRunIds: ["acp-run"],
      },
      preparationError: null,
      waitedForSchedulerIdle: true,
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
