import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createResultExitGuard,
  enforceResultProcessIntegrity,
} from "./result-exit-guard.js";
import type { RunnerE2EResult } from "./types.js";

const passingResult = {
  status: "passed",
  cleanup: "passed",
} as RunnerE2EResult;

describe("runner E2E result-exit guard", () => {
  it("expires once after every result exists and stops a controlled child", async () => {
    const child = spawn(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    let now = 1_000;
    const onExpired = vi.fn(() => {
      child.kill("SIGTERM");
    });
    const guard = createResultExitGuard({
      resultPaths: ["first.json", "second.json"],
      interactive: false,
      graceMs: 120_000,
      now: () => now,
      pathExists: async () => true,
      onExpired,
    });
    let exitTimeout: NodeJS.Timeout | undefined;

    try {
      await guard.poll();
      now += 119_999;
      await guard.poll();
      expect(onExpired).not.toHaveBeenCalled();
      now += 1;
      await guard.poll();
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          exitTimeout = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
      expect(stopped).toBe(true);
      await guard.poll();
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      if (exitTimeout) clearTimeout(exitTimeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("does not monitor interactive sessions", async () => {
    const pathExists = vi.fn(async () => true);
    const onExpired = vi.fn();
    const guard = createResultExitGuard({
      resultPaths: ["result.json"],
      interactive: true,
      graceMs: 1,
      now: () => 10,
      pathExists,
      onExpired,
    });

    expect(guard.enabled).toBe(false);
    await guard.poll();
    expect(pathExists).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("requires every result before it starts the grace period", async () => {
    let now = 1_000;
    let complete = false;
    const onExpired = vi.fn();
    const guard = createResultExitGuard({
      resultPaths: ["first.json", "second.json"],
      interactive: false,
      graceMs: 10,
      now: () => now,
      pathExists: async (path) => path === "first.json" || complete,
      onExpired,
    });

    await guard.poll();
    now += 100;
    complete = true;
    await guard.poll();
    now += 9;
    await guard.poll();
    expect(onExpired).not.toHaveBeenCalled();
    now += 1;
    await guard.poll();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("changes a saved pass into a cleanup failure after process failure", () => {
    expect(
      enforceResultProcessIntegrity(passingResult, {
        exitCode: 1,
        timedOut: false,
        postResultStallError: null,
        processCleanupError: null,
      }),
    ).toMatchObject({
      status: "failed",
      cleanup: "failed",
      failureClass: "cleanup_failure",
      error: "Playwright exited 1 after writing a passing result",
    });
    expect(
      enforceResultProcessIntegrity(passingResult, {
        exitCode: 0,
        timedOut: false,
        postResultStallError: "Playwright stayed alive after every result",
        processCleanupError: null,
      }),
    ).toMatchObject({
      status: "failed",
      cleanup: "failed",
      failureClass: "cleanup_failure",
      error: "Playwright stayed alive after every result",
    });
    expect(
      enforceResultProcessIntegrity(passingResult, {
        exitCode: 1,
        timedOut: true,
        postResultStallError: null,
        processCleanupError: null,
      }),
    ).toMatchObject({
      status: "failed",
      cleanup: "failed",
      failureClass: "cleanup_failure",
      error:
        "Playwright exceeded its process watchdog after writing every result",
    });

    expect(
      enforceResultProcessIntegrity(passingResult, {
        exitCode: 0,
        timedOut: false,
        postResultStallError: null,
        processCleanupError: null,
      }),
    ).toBe(passingResult);
  });
});
