import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS,
  createChildWatchdog,
  resolveChildWatchdogTimeoutMs,
  terminateChildProcessTree,
} from "./dev-runner-child-watchdog.js";

describe("resolveChildWatchdogTimeoutMs", () => {
  it("uses the default when the override is absent or unusable", () => {
    expect(resolveChildWatchdogTimeoutMs({})).toBe(DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS);
    expect(resolveChildWatchdogTimeoutMs({ PAPERCLIP_DEV_PREFLIGHT_TIMEOUT_MS: "" })).toBe(
      DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS,
    );
    expect(resolveChildWatchdogTimeoutMs({ PAPERCLIP_DEV_PREFLIGHT_TIMEOUT_MS: "soon" })).toBe(
      DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS,
    );
    expect(resolveChildWatchdogTimeoutMs({ PAPERCLIP_DEV_PREFLIGHT_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_CHILD_WATCHDOG_TIMEOUT_MS,
    );
  });

  it("accepts a positive millisecond override", () => {
    expect(resolveChildWatchdogTimeoutMs({ PAPERCLIP_DEV_PREFLIGHT_TIMEOUT_MS: "90000" })).toBe(90_000);
  });
});

describe("createChildWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const options = {
    label: "migration status check",
    command: "pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json",
    warnAfterMs: 15_000,
    noticeIntervalMs: 30_000,
    timeoutMs: 100_000,
  };

  it("stays quiet for a child that finishes before the first notice", () => {
    const write = vi.fn();
    const onTimeout = vi.fn();
    const watchdog = createChildWatchdog({ ...options, write }, onTimeout);
    vi.advanceTimersByTime(14_999);
    watchdog.dispose();
    vi.advanceTimersByTime(200_000);
    expect(write).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(watchdog.timedOut).toBe(false);
  });

  it("prints a notice after warnAfterMs and then on every interval", () => {
    const write = vi.fn();
    const watchdog = createChildWatchdog({ ...options, write }, () => {});
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("migration status check still running after 15s");
    expect(write.mock.calls[0]?.[0]).toContain("will give up at 100s");
    expect(write.mock.calls[0]?.[0]).toContain(options.command);
    vi.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toContain("after 45s");
    vi.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledTimes(3);
    watchdog.dispose();
  });

  it("fires onTimeout exactly once at the deadline and stops the notices", () => {
    const write = vi.fn();
    const onTimeout = vi.fn();
    const watchdog = createChildWatchdog({ ...options, write }, onTimeout);
    vi.advanceTimersByTime(100_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ elapsedMs: 100_000 });
    expect(watchdog.timedOut).toBe(true);
    const noticesAtDeadline = write.mock.calls.length;
    vi.advanceTimersByTime(200_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(noticesAtDeadline);
    watchdog.dispose();
  });

  it("never fires after dispose", () => {
    const onTimeout = vi.fn();
    const watchdog = createChildWatchdog({ ...options, write: () => {} }, onTimeout);
    watchdog.dispose();
    watchdog.dispose();
    vi.advanceTimersByTime(500_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(watchdog.timedOut).toBe(false);
  });
});

describe("terminateChildProcessTree", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing for a child that already exited", async () => {
    const kill = vi.fn(() => true);
    await terminateChildProcessTree({ pid: 1, kill, exitCode: 0, signalCode: null }, { platform: "linux" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM and escalates to SIGKILL when the child stays alive", async () => {
    const child = { pid: 1, kill: vi.fn(() => true), exitCode: null, signalCode: null };
    const pending = terminateChildProcessTree(child, { platform: "linux", killAfterMs: 1_000 });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("does not escalate when the child exited after SIGTERM", async () => {
    const child: {
      pid: number;
      kill: (signal?: NodeJS.Signals) => boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    } = {
      pid: 1,
      kill: vi.fn((_signal?: NodeJS.Signals) => true),
      exitCode: null,
      signalCode: null,
    };
    const pending = terminateChildProcessTree(child, { platform: "linux", killAfterMs: 1_000 });
    child.signalCode = "SIGTERM";
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
