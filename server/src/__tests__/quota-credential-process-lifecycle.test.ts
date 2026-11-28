import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorQuotaCredentialProcess } from "./helpers/quota-credential-process-lifecycle.js";

class FixtureChild extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal: NodeJS.Signals) => true);

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  monitor() { return monitorQuotaCredentialProcess(this as unknown as ChildProcess); }
}

afterEach(() => { vi.useRealTimers(); });

describe("quota credential receiver lifecycle", () => {
  it("waits for readiness within its startup budget and clears its timer", async () => {
    vi.useFakeTimers();
    const child = new FixtureChild(), monitor = child.monitor();
    const ready = monitor.waitForReady(1_000);
    await vi.advanceTimersByTimeAsync(999);
    child.emit("message", { type: "unrelated", credential: "private-fixture" });
    child.emit("message", { type: "ready" });
    await ready;
    expect(vi.getTimerCount()).toBe(0);
    monitor.assertRunning();
    await monitor.waitForReady(1);
    child.exit(0);
    expect(child.eventNames()).toEqual([]);
  });

  it.each([0, 1])("rejects exit code %s before readiness", async code => {
    const child = new FixtureChild(), monitor = child.monitor();
    const ready = expect(monitor.waitForReady(1_000)).rejects.toThrow(`exitCode=${code}`);
    child.exit(code);
    await ready;
    expect(() => monitor.assertRunning()).toThrow("stage=startup");
    await monitor.stop();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });

  it("observes signal death even though exitCode remains null", async () => {
    const child = new FixtureChild(), monitor = child.monitor();
    child.emit("message", { type: "ready" });
    await monitor.waitForReady(1_000);
    child.exit(null, "SIGKILL");
    expect(child.exitCode).toBeNull();
    expect(() => monitor.assertRunning()).toThrow("signal=SIGKILL");
    await monitor.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports spawn failure without exposing exception details", async () => {
    const child = new FixtureChild(), monitor = child.monitor();
    child.pid = undefined;
    child.emit("error", new Error("private-fixture credential and database URL"));
    const failure = await monitor.waitForReady(1_000).then(
      () => { throw new Error("Expected receiver startup to fail"); },
      error => error as Error,
    );
    expect(failure.message).toContain("stage=spawn-error");
    expect(failure.message).not.toContain("private-fixture");
    const stopped = monitor.stop();
    child.emit("close", -2, null);
    await stopped;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });

  it("times out startup and still stops the live child", async () => {
    vi.useFakeTimers();
    const child = new FixtureChild(), monitor = child.monitor();
    const failed = expect(monitor.waitForReady(1_000)).rejects.toThrow("stage=startup-timeout");
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    child.kill.mockImplementation(() => { child.exit(null, "SIGKILL"); return true; });
    await monitor.stop();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    expect(child.eventNames()).toEqual([]);
  });

  it("makes stop idempotent and waits for process termination", async () => {
    const child = new FixtureChild(), monitor = child.monitor();
    const first = monitor.stop(), second = monitor.stop();
    expect(first).toBe(second);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    let stopped = false;
    void first.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    child.exit(null, "SIGKILL");
    await first;
    expect(stopped).toBe(true);
    expect(child.eventNames()).toEqual([]);
  });
});
