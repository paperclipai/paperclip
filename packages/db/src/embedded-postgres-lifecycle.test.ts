import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddedPostgresStartTimeoutError,
  EmbeddedPostgresStopTimeoutError,
  hasEmbeddedPostgresProcessExited,
  loadWithoutEmbeddedPostgresExitHooks,
  startEmbeddedPostgresWithin,
  stopEmbeddedPostgresWithin,
  type EmbeddedPostgresChildProcess,
  type EmbeddedPostgresLifecycle,
} from "./embedded-postgres-lifecycle.js";

describe("loadWithoutEmbeddedPostgresExitHooks", () => {
  it("removes every eager exit hook from the real embedded-postgres import", async () => {
    const eventNames = [
      "exit",
      "beforeExit",
      "SIGHUP",
      "SIGINT",
      "SIGTERM",
      "SIGBREAK",
      "message",
    ];
    const before = new Map(eventNames.map((eventName) => [
      eventName,
      process.rawListeners(eventName),
    ]));
    const moduleName = "embedded-postgres";

    await loadWithoutEmbeddedPostgresExitHooks(() => import(moduleName));

    for (const eventName of eventNames) {
      expect(process.rawListeners(eventName)).toEqual(before.get(eventName));
    }
  });

  it("removes dependency exit hooks while preserving existing listeners", async () => {
    const target = new EventEmitter();
    const existingSignalListener = vi.fn();
    const existingExitListener = vi.fn();
    target.on("SIGTERM", existingSignalListener);
    target.on("exit", existingExitListener);

    const dependencyListener = vi.fn();
    const loaded = await loadWithoutEmbeddedPostgresExitHooks(
      async () => {
        for (const eventName of [
          "exit",
          "beforeExit",
          "SIGHUP",
          "SIGINT",
          "SIGTERM",
          "SIGBREAK",
          "message",
        ]) {
          target.on(eventName, dependencyListener);
        }
        return { default: class EmbeddedPostgres {} };
      },
      target,
    );

    expect(loaded.default.name).toBe("EmbeddedPostgres");
    expect(target.rawListeners("SIGTERM")).toEqual([existingSignalListener]);
    expect(target.rawListeners("exit")).toEqual([existingExitListener]);
    for (const eventName of ["beforeExit", "SIGHUP", "SIGINT", "SIGBREAK", "message"]) {
      expect(target.rawListeners(eventName)).toEqual([]);
    }
  });

  it("cleans up listeners even when the import fails", async () => {
    const target = new EventEmitter();
    const dependencyListener = vi.fn();

    await expect(loadWithoutEmbeddedPostgresExitHooks(
      async () => {
        target.on("SIGTERM", dependencyListener);
        throw new Error("import failed");
      },
      target,
    )).rejects.toThrow("import failed");

    expect(target.rawListeners("SIGTERM")).toEqual([]);
  });
});

type FakeInstance = EmbeddedPostgresLifecycle & {
  startCalls: number;
  stopCalls: number;
  settleStart: { resolve: () => void; reject: (error: unknown) => void };
  settleStop: { resolve: () => void; reject: (error: unknown) => void };
};

function createFakeInstance(input: {
  process?: EmbeddedPostgresChildProcess;
  spawnOnStart?: EmbeddedPostgresChildProcess;
} = {}): FakeInstance {
  const instance: FakeInstance = {
    process: input.process,
    startCalls: 0,
    stopCalls: 0,
    settleStart: { resolve: () => {}, reject: () => {} },
    settleStop: { resolve: () => {}, reject: () => {} },
    start() {
      instance.startCalls += 1;
      if (input.spawnOnStart) instance.process = input.spawnOnStart;
      return new Promise<void>((resolve, reject) => {
        instance.settleStart = { resolve, reject };
      });
    },
    stop() {
      instance.stopCalls += 1;
      return new Promise<void>((resolve, reject) => {
        instance.settleStop = { resolve, reject };
      });
    },
  };
  return instance;
}

const liveChild = (pid: number): EmbeddedPostgresChildProcess => ({ pid, exitCode: null, signalCode: null });

function settled(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

describe("hasEmbeddedPostgresProcessExited", () => {
  it("treats a missing child as not exited", () => {
    expect(hasEmbeddedPostgresProcessExited(undefined)).toBe(false);
  });

  it("reads either an exit code or a signal as exited", () => {
    expect(hasEmbeddedPostgresProcessExited(liveChild(1))).toBe(false);
    expect(hasEmbeddedPostgresProcessExited({ pid: 1, exitCode: 0, signalCode: null })).toBe(true);
    expect(hasEmbeddedPostgresProcessExited({ pid: 1, exitCode: 1, signalCode: null })).toBe(true);
    expect(hasEmbeddedPostgresProcessExited({ pid: 1, exitCode: null, signalCode: "SIGKILL" })).toBe(true);
  });
});

describe("stopEmbeddedPostgresWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports not-started without touching an instance that never spawned", async () => {
    const instance = createFakeInstance();
    await expect(stopEmbeddedPostgresWithin(instance)).resolves.toBe("not-started");
    expect(instance.stopCalls).toBe(0);
  });

  it("skips stop() and clears the handle when the postmaster already exited", async () => {
    // embedded-postgres's stop() would signal the dead pid and then wait for an
    // exit event that fired long ago -- forever.
    const instance = createFakeInstance({ process: { pid: 4242, exitCode: null, signalCode: "SIGKILL" } });
    await expect(stopEmbeddedPostgresWithin(instance)).resolves.toBe("already-exited");
    expect(instance.stopCalls).toBe(0);
    expect(instance.process).toBeUndefined();
  });

  it("returns stopped once stop() settles inside the budget", async () => {
    const instance = createFakeInstance({ process: liveChild(4242) });
    const pending = stopEmbeddedPostgresWithin(instance, { timeoutMs: 1_000 });
    expect(instance.stopCalls).toBe(1);
    instance.settleStop.resolve();
    await expect(pending).resolves.toBe("stopped");
  });

  it("throws a timeout naming the pid when stop() never settles", async () => {
    const instance = createFakeInstance({ process: liveChild(4242) });
    const outcome = settled(
      stopEmbeddedPostgresWithin(instance, { timeoutMs: 1_000, describe: "on port 54329" }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(EmbeddedPostgresStopTimeoutError);
    expect((error as Error).message).toContain("on port 54329");
    expect((error as Error).message).toContain("pid=4242");
    expect((error as Error).message).toContain("1000ms");
    // The abandoned stop() settling later must not become an unhandled rejection.
    instance.settleStop.reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("startEmbeddedPostgresWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the postmaster reports readiness inside the budget", async () => {
    const instance = createFakeInstance({ spawnOnStart: liveChild(777) });
    const pending = startEmbeddedPostgresWithin(instance, { timeoutMs: 10_000 });
    instance.settleStart.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(instance.stopCalls).toBe(0);
  });

  it("propagates a start() rejection unchanged", async () => {
    const instance = createFakeInstance({ spawnOnStart: liveChild(777) });
    const pending = startEmbeddedPostgresWithin(instance, { timeoutMs: 10_000 });
    const failure = new Error("postmaster exited");
    instance.settleStart.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(instance.stopCalls).toBe(0);
  });

  it("reports progress while readiness is pending", async () => {
    const instance = createFakeInstance({ spawnOnStart: liveChild(777) });
    const onWaiting = vi.fn();
    const pending = startEmbeddedPostgresWithin(instance, {
      timeoutMs: 60_000,
      progressIntervalMs: 10_000,
      onWaiting,
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(onWaiting).toHaveBeenLastCalledWith({ elapsedMs: 20_000, pid: 777 });
    instance.settleStart.resolve();
    await pending;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onWaiting).toHaveBeenCalledTimes(2);
  });

  it("times out a postmaster that never announces readiness and stops it", async () => {
    // The child is alive (a standby announces read-only readiness instead,
    // for example) and start() would otherwise wait forever.
    const instance = createFakeInstance({ spawnOnStart: liveChild(777) });
    const outcome = settled(
      startEmbeddedPostgresWithin(instance, {
        timeoutMs: 60_000,
        stopTimeoutMs: 5_000,
        describe: "on port 54329 (dataDir=/tmp/db)",
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instance.stopCalls).toBe(1);
    instance.settleStop.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(EmbeddedPostgresStartTimeoutError);
    expect((error as Error).message).toContain("on port 54329 (dataDir=/tmp/db)");
    expect((error as Error).message).toContain("60000ms");
    expect((error as Error).message).toContain("postmaster pid=777");
    // A late rejection from the abandoned start() must not surface.
    instance.settleStart.reject(undefined);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("still reports the start timeout when the cleanup stop also times out", async () => {
    const instance = createFakeInstance({ spawnOnStart: liveChild(777) });
    const outcome = settled(
      startEmbeddedPostgresWithin(instance, { timeoutMs: 1_000, stopTimeoutMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(instance.stopCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBeInstanceOf(EmbeddedPostgresStartTimeoutError);
  });

  it("says so when the postmaster was never even spawned", async () => {
    const instance = createFakeInstance();
    const outcome = settled(startEmbeddedPostgresWithin(instance, { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(EmbeddedPostgresStartTimeoutError);
    expect((error as Error).message).toContain("never spawned");
    expect(instance.stopCalls).toBe(0);
  });
});
