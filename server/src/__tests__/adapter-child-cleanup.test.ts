import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Layer 1: Adapter child cleanup ---

// We test cleanupChildProcess() in isolation by importing it directly.
// The function lives in heartbeat.ts and uses process.kill() under the hood.

// Mock the logger to avoid noisy output
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cleanupChildProcess } from "../services/heartbeat.js";

describe("cleanupChildProcess", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("kills child with SIGTERM on process_lost", async () => {
    // process.kill(pid, 0) returns true (alive), then SIGTERM sent,
    // then after 5s check: process.kill(pid, 0) throws ESRCH (dead)
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && killSpy.mock.calls.filter(c => c[1] === 0).length <= 1) return true; // first liveness check: alive
      if (signal === "SIGTERM") return true;
      if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); // second check: dead
      return true;
    });

    const promise = cleanupChildProcess(12345);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    // SIGKILL should NOT have been sent since process died after SIGTERM
    const sigkillCalls = killSpy.mock.calls.filter(c => c[1] === "SIGKILL");
    expect(sigkillCalls).toHaveLength(0);
  });

  it("kills child on done when process is still alive", async () => {
    // Same as above - process alive, gets SIGTERM, then dies
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && killSpy.mock.calls.filter(c => c[1] === 0).length <= 1) return true;
      if (signal === "SIGTERM") return true;
      if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });

    const promise = cleanupChildProcess(99999);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(99999, "SIGTERM");
  });

  it("kills child on failed when process is still alive", async () => {
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && killSpy.mock.calls.filter(c => c[1] === 0).length <= 1) return true;
      if (signal === "SIGTERM") return true;
      if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });

    const promise = cleanupChildProcess(88888);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(88888, "SIGTERM");
  });

  it("escalates to SIGKILL when SIGTERM does not kill the process within 5 seconds", async () => {
    // process.kill(pid, 0) always returns true (alive), even after SIGTERM
    killSpy.mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) return true; // always alive
      return true; // SIGTERM and SIGKILL both "succeed"
    });

    const promise = cleanupChildProcess(77777);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(77777, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(77777, "SIGKILL");
  });

  it("skips kill when pid is null", async () => {
    await cleanupChildProcess(null as unknown as number);
    // No process.kill calls at all
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("handles already-dead process gracefully", async () => {
    // process.kill(pid, 0) throws ESRCH immediately (already dead)
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    // Should not throw
    await expect(cleanupChildProcess(66666)).resolves.toBeUndefined();
    // Only the liveness check was attempted, no SIGTERM
    expect(killSpy).toHaveBeenCalledWith(66666, 0);
    const termCalls = killSpy.mock.calls.filter(c => c[1] === "SIGTERM");
    expect(termCalls).toHaveLength(0);
  });
});
