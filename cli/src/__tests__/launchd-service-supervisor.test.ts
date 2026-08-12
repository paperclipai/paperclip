import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAUNCHD_LOG_GENERATIONS,
  LAUNCHD_MAX_EARLY_FAILURES,
  LAUNCHD_MIN_FREE_DISK_BYTES,
  RotatingLogWriter,
  launchdStartupBlockReason,
  runLaunchdServiceSupervisor,
} from "../services/launchd-service-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-launchd-supervisor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("launchd startup safeguards", () => {
  it("refuses startup below the free-disk floor", () => {
    expect(launchdStartupBlockReason({
      freeDiskBytes: LAUNCHD_MIN_FREE_DISK_BYTES - 1,
      failureTimestamps: [],
      now: 100_000,
    })).toMatchObject({ reason: "low_disk" });
  });

  it("caps five early failures in a sixty-second window", () => {
    const now = 100_000;
    expect(launchdStartupBlockReason({
      freeDiskBytes: LAUNCHD_MIN_FREE_DISK_BYTES,
      failureTimestamps: Array.from({ length: LAUNCHD_MAX_EARLY_FAILURES }, (_, index) => now - index * 1_000),
      now,
    })).toMatchObject({ reason: "crash_loop" });
  });

  it("writes an operator-readable status without spawning when disk is low", async () => {
    const homeDir = await temporaryDirectory();
    let spawnCalled = false;

    const exitCode = await runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: "/missing/paperclipai",
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES - 1,
      spawnChild: () => {
        spawnCalled = true;
        throw new Error("must not spawn");
      },
    });

    expect(exitCode).toBe(0);
    expect(spawnCalled).toBe(false);
    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; message: string };
    expect(status).toMatchObject({ state: "blocked", reason: "low_disk" });
    expect(status.message).toContain("startup refused");
  });

  it("stops spawning after the fifth early child failure", async () => {
    const homeDir = await temporaryDirectory();
    let spawnCount = 0;
    const options = {
      instanceId: "test",
      homeDir,
      shimPath: process.execPath,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => {
        spawnCount += 1;
        return spawn(process.execPath, ["-e", "process.exit(1)"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
    };

    for (let attempt = 1; attempt <= LAUNCHD_MAX_EARLY_FAILURES; attempt += 1) {
      const exitCode = await runLaunchdServiceSupervisor(options);
      expect(exitCode).toBe(attempt === LAUNCHD_MAX_EARLY_FAILURES ? 0 : 1);
    }
    expect(spawnCount).toBe(LAUNCHD_MAX_EARLY_FAILURES);

    expect(await runLaunchdServiceSupervisor(options)).toBe(0);
    expect(spawnCount).toBe(LAUNCHD_MAX_EARLY_FAILURES);
    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; earlyFailureCount: number };
    expect(status).toMatchObject({
      state: "blocked",
      reason: "crash_loop",
      earlyFailureCount: LAUNCHD_MAX_EARLY_FAILURES,
    });
  });

  it("does not wait indefinitely when a descendant retains an output descriptor", async () => {
    const homeDir = await temporaryDirectory();
    const childScript = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "setTimeout(() => undefined, 250)"], {',
      '  stdio: ["ignore", "inherit", "inherit"],',
      '});',
      'process.exit(1);',
    ].join("\n");

    const exitCode = await runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: process.execPath,
      outputDrainTimeoutMs: 20,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => spawn(process.execPath, ["-e", childScript], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    });

    expect(exitCode).toBe(1);
    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; exitCode: number };
    expect(status).toMatchObject({ state: "exited", reason: "early_exit", exitCode: 1 });
  });

  it("installs operator signal handlers before publishing the child pid", async () => {
    const homeDir = await temporaryDirectory();
    const listenersBefore = new Set(process.listeners("SIGTERM"));
    let handlerInstalledAtFirstPidRead: boolean | null = null;

    const exitCode = await runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: process.execPath,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 50)"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const pid = child.pid;
        Object.defineProperty(child, "pid", {
          configurable: true,
          enumerable: true,
          get: () => {
            if (handlerInstalledAtFirstPidRead === null) {
              handlerInstalledAtFirstPidRead = process
                .listeners("SIGTERM")
                .some((listener) => !listenersBefore.has(listener));
            }
            return pid;
          },
        });
        return child;
      },
    });

    expect(exitCode).toBe(1);
    expect(handlerInstalledAtFirstPidRead).toBe(true);
  });

  it("stops the child when an operator signal arrives while spawn is returning", async () => {
    const homeDir = await temporaryDirectory();
    const listenersBefore = new Set(process.listeners("SIGTERM"));
    let spawnedChild: ChildProcess | null = null;

    const exitCode = await runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: process.execPath,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        spawnedChild = child;
        const signalListener = process
          .listeners("SIGTERM")
          .find((listener) => !listenersBefore.has(listener));
        expect(signalListener).toBeDefined();
        signalListener?.("SIGTERM");
        return child;
      },
    });

    expect(exitCode).toBe(1);
    expect((spawnedChild as ChildProcess | null)?.signalCode).toBe("SIGTERM");
    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; signal: string };
    expect(status).toMatchObject({ state: "exited", reason: "operator_stop", signal: "SIGTERM" });
  });

  it("force-stops a child that ignores an operator restart signal", async () => {
    const homeDir = await temporaryDirectory();
    const listenersBefore = new Set(process.listeners("SIGTERM"));
    let spawnedChild: (ChildProcess & { stdout: Readable; stderr: Readable }) | null = null;
    let childReadyResolve: (() => void) | null = null;
    const childReady = new Promise<void>((resolve) => {
      childReadyResolve = resolve;
    });
    const childScript = [
      'process.on("SIGTERM", () => undefined);',
      'process.on("SIGINT", () => undefined);',
      'process.send?.("ready");',
      'setInterval(() => undefined, 1_000);',
    ].join("\n");

    const supervisor = runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: process.execPath,
      childStopTimeoutMs: 20,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => {
        const child = spawn(process.execPath, ["-e", childScript], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        }) as ChildProcess & { stdout: Readable; stderr: Readable };
        spawnedChild = child;
        child.once("message", () => childReadyResolve?.());
        return child;
      },
    });

    await childReady;
    let signalListener = process.listeners("SIGTERM").find((listener) => !listenersBefore.has(listener));
    for (let attempt = 0; !signalListener && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      signalListener = process.listeners("SIGTERM").find((listener) => !listenersBefore.has(listener));
    }
    expect(signalListener).toBeDefined();
    signalListener?.("SIGTERM");

    await expect(supervisor).resolves.toBe(1);
    expect((spawnedChild as ChildProcess | null)?.signalCode).toBe("SIGKILL");
    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; signal: string };
    expect(status).toMatchObject({ state: "exited", reason: "operator_stop", signal: "SIGKILL" });
  });

  it("persists an asynchronous child spawn error as an early failure", async () => {
    const homeDir = await temporaryDirectory();

    const exitCode = await runLaunchdServiceSupervisor({
      instanceId: "test",
      homeDir,
      shimPath: path.join(homeDir, "missing-paperclipai"),
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
    });

    expect(exitCode).toBe(1);
    const instanceRoot = path.join(homeDir, "instances", "test");
    const failures = JSON.parse(await fs.readFile(
      path.join(instanceRoot, "service-early-failures.json"),
      "utf8",
    )) as { timestamps: number[] };
    const status = JSON.parse(await fs.readFile(
      path.join(instanceRoot, "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; message: string; earlyFailureCount: number };
    expect(failures.timestamps).toHaveLength(1);
    expect(status).toMatchObject({
      state: "exited",
      reason: "spawn_error",
      earlyFailureCount: 1,
    });
    expect(status.message).toContain("could not start the child service");
  });

  it("caps repeated synchronous child spawn failures", async () => {
    const homeDir = await temporaryDirectory();
    let spawnCount = 0;
    const options = {
      instanceId: "test",
      homeDir,
      shimPath: "/missing/paperclipai",
      now: () => 100_000,
      freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
      spawnChild: () => {
        spawnCount += 1;
        throw new Error("spawn denied");
      },
    };

    for (let attempt = 1; attempt <= LAUNCHD_MAX_EARLY_FAILURES; attempt += 1) {
      await expect(runLaunchdServiceSupervisor(options)).resolves.toBe(
        attempt === LAUNCHD_MAX_EARLY_FAILURES ? 0 : 1,
      );
    }
    await expect(runLaunchdServiceSupervisor(options)).resolves.toBe(0);
    expect(spawnCount).toBe(LAUNCHD_MAX_EARLY_FAILURES);

    const status = JSON.parse(await fs.readFile(
      path.join(homeDir, "instances", "test", "service-supervisor-status.json"),
      "utf8",
    )) as { state: string; reason: string; earlyFailureCount: number };
    expect(status).toMatchObject({
      state: "blocked",
      reason: "crash_loop",
      earlyFailureCount: LAUNCHD_MAX_EARLY_FAILURES,
    });
  });

  it.each(["service.log", "service.err.log"])(
    "persists a %s pipeline/log-write failure and stops the child",
    async (blockedLogName) => {
      const homeDir = await temporaryDirectory();
      const instanceRoot = path.join(homeDir, "instances", "test");
      const blockedLogPath = path.join(instanceRoot, "logs", blockedLogName);
      await fs.mkdir(blockedLogPath, { recursive: true });
      const spawnedChildren: Array<ChildProcess & { stdout: Readable; stderr: Readable }> = [];

      const exitCode = await runLaunchdServiceSupervisor({
        instanceId: "test",
        homeDir,
        shimPath: process.execPath,
        freeDiskBytes: async () => LAUNCHD_MIN_FREE_DISK_BYTES,
        spawnChild: () => {
          const spawnedChild = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          spawnedChildren.push(spawnedChild);
          return spawnedChild;
        },
      });

      expect(exitCode).toBe(1);
      expect(spawnedChildren).toHaveLength(1);
      expect(spawnedChildren[0]?.signalCode).toBe("SIGTERM");
      const failures = JSON.parse(await fs.readFile(
        path.join(instanceRoot, "service-early-failures.json"),
        "utf8",
      )) as { timestamps: number[] };
      const status = JSON.parse(await fs.readFile(
        path.join(instanceRoot, "service-supervisor-status.json"),
        "utf8",
      )) as { state: string; reason: string; message: string; earlyFailureCount: number };
      expect(failures.timestamps).toHaveLength(1);
      expect(status).toMatchObject({
        state: "exited",
        reason: "output_error",
        earlyFailureCount: 1,
      });
      expect(status.message).toContain("could not stream the child service logs");
    },
  );
});

describe("launchd service log rotation", () => {
  it("rotates while streaming and retains only three generations", async () => {
    const directory = await temporaryDirectory();
    const logPath = path.join(directory, "service.log");
    const writer = new RotatingLogWriter(logPath, 10, LAUNCHD_LOG_GENERATIONS);

    writer.end(Buffer.from("0123456789abcdefghijKLMNOPQRSTuvwxy"));
    await finished(writer);

    expect(await fs.readFile(logPath, "utf8")).toBe("uvwxy");
    expect(await fs.readFile(`${logPath}.1`, "utf8")).toBe("KLMNOPQRST");
    expect(await fs.readFile(`${logPath}.2`, "utf8")).toBe("abcdefghij");
    expect(await fs.readFile(`${logPath}.3`, "utf8")).toBe("0123456789");
    await expect(fs.access(`${logPath}.4`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
