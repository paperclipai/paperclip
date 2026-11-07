import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processExists, processStartsDefinitelyDiffer } from "./controller-process-identity.js";
import { isPidAlive, isProcessGroupAlive } from "./local-service-supervisor.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { verifiedRecoveryProcessIsAlive } from "./native-runtime/native-session-executor.js";

describe("shared process identity proof", () => {
  afterEach(() => vi.restoreAllMocks());

  it("needs a start-time gap of at least one second to prove a recycled PID", () => {
    const at = new Date("2026-11-07T10:00:00.000Z");
    expect(processStartsDefinitelyDiffer(at, new Date(at.getTime() + 999))).toBe(false);
    expect(processStartsDefinitelyDiffer(at, "2026-11-07T09:59:59.001Z")).toBe(false);
    expect(processStartsDefinitelyDiffer(at, new Date(at.getTime() + 1_000))).toBe(true);
    expect(processStartsDefinitelyDiffer(at, null)).toBe(false);
    expect(processStartsDefinitelyDiffer("not a date", at)).toBe(false);
  });

  it("treats EPERM as a live process in every signal-0 check", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(processExists(4242)).toBe(true);
    expect(isPidAlive(4242)).toBe(true);
    if (process.platform !== "win32" && process.platform !== "linux") expect(isProcessGroupAlive(4242)).toBe(true);
  });

  it("treats ESRCH as a gone process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(processExists(4242)).toBe(false);
    expect(isPidAlive(4242)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps a live recovered runner whose recorded start differs by under a second", async () => {
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    await once(live, "spawn");
    try {
      const observed = new Date((await readProcessStartedAt(live.pid!))!);
      const startedAt = new Date(observed.getTime() + 500).toISOString();
      await expect(verifiedRecoveryProcessIsAlive({ pid: live.pid!, startedAt })).resolves.toBe(true);
      const recycled = new Date(observed.getTime() + 5_000).toISOString();
      await expect(verifiedRecoveryProcessIsAlive({ pid: live.pid!, startedAt: recycled })).resolves.toBe(false);
    } finally {
      const exited = once(live, "exit");
      live.kill("SIGKILL");
      await exited;
    }
  });
});
