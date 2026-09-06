import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOpenCodeInactivityMonitorErrorMessage,
  resolveOpenCodeInactivityTimeout,
} from "./output-inactivity-monitor.js";

class FakeClock {
  private nowMs = 0;
  private nextHandle = 1;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimer(cb: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fireAt: this.nowMs + ms, cb });
    return handle;
  }

  clearTimer(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(ms: number): void {
    const targetMs = this.nowMs + ms;
    while (true) {
      let nextHandle: number | null = null;
      let nextTimer: { fireAt: number; cb: () => void } | null = null;
      for (const [h, timer] of this.timers) {
        if (timer.fireAt <= targetMs && (!nextTimer || timer.fireAt < nextTimer.fireAt)) {
          nextHandle = h;
          nextTimer = timer;
        }
      }
      if (!nextTimer || nextHandle == null) break;
      this.timers.delete(nextHandle);
      this.nowMs = nextTimer.fireAt;
      nextTimer.cb();
    }
    this.nowMs = targetMs;
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }
}

describe("resolveOpenCodeInactivityTimeout", () => {
  it("defaults to 30 seconds", () => {
    expect(DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS).toBe(30_000);
  });

  it("uses default when value is unset", () => {
    expect(resolveOpenCodeInactivityTimeout(undefined)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("treats explicit null as disabled", () => {
    expect(resolveOpenCodeInactivityTimeout(null)).toEqual({
      mode: "disabled",
      reason: "explicit_null",
    });
  });

  it("returns configured value for positive numbers", () => {
    expect(resolveOpenCodeInactivityTimeout(750)).toEqual({
      mode: "configured",
      timeoutMs: 750,
    });
  });

  it("falls back to default for non-positive numbers", () => {
    expect(resolveOpenCodeInactivityTimeout(0)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
    expect(resolveOpenCodeInactivityTimeout(-100)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
  });

  it("falls back to default for non-number, non-null values", () => {
    expect(resolveOpenCodeInactivityTimeout("30000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });
});

describe("formatOpenCodeInactivityMonitorErrorMessage", () => {
  it("formats seconds with the canonical prefix", () => {
    expect(formatOpenCodeInactivityMonitorErrorMessage(0)).toBe("monitor: no opencode activity for 0s");
    expect(formatOpenCodeInactivityMonitorErrorMessage(30_000)).toBe("monitor: no opencode activity for 30s");
    expect(formatOpenCodeInactivityMonitorErrorMessage(95_000)).toBe("monitor: no opencode activity for 95s");
  });

  it("rounds partial seconds", () => {
    expect(formatOpenCodeInactivityMonitorErrorMessage(1_500)).toBe("monitor: no opencode activity for 2s");
  });
});

describe("createOpenCodeOutputInactivityMonitor (acceptance: fires on silence)", () => {
  it("fires after timeoutMs when the child goes silent after one JSONL event", () => {
    const clock = new FakeClock();
    const fires: Array<{ elapsed: number; parsedEventCount: number }> = [];
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 30_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: (state) => {
        fires.push({
          elapsed: (state.firedAt ?? 0) - state.lastEventAt,
          parsedEventCount: state.parsedEventCount,
        });
      },
    });

    // One JSONL event right after spawn.
    clock.advance(50);
    monitor.noteOutputChunk("stdout", '{"type":"text","sessionID":"opencode_123","part":{"text":"hi"}}\n');
    expect(fires).toHaveLength(0);
    expect(monitor.state().parsedEventCount).toBe(1);

    // Silent for 30s - 1ms: does not fire yet.
    clock.advance(30_000 - 1);
    expect(fires).toHaveLength(0);
    // Cross the 30s threshold: fires exactly once.
    clock.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].elapsed).toBe(30_000);
    expect(fires[0].parsedEventCount).toBe(1);

    const finalState = monitor.stop();
    expect(finalState.fired).toBe(true);
  });

  it("fires exactly once even if more silence elapses after firing", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(2_000);
    expect(fireCount).toBe(1);
    clock.advance(10_000);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("requires timeoutMs > 0", () => {
    expect(() =>
      createOpenCodeOutputInactivityMonitor({
        timeoutMs: 0,
        onFire: () => {},
      }),
    ).toThrow(/timeoutMs > 0/);
  });
});

describe("createOpenCodeOutputInactivityMonitor (acceptance: JSONL resets the timer)", () => {
  it("normal JSONL output keeps resetting the inactivity timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 30_000;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    // Healthy session: a JSONL line every ~25s for four cycles (>2 minutes total).
    for (let i = 0; i < 4; i += 1) {
      clock.advance(25_000);
      monitor.noteOutputChunk(
        "stdout",
        `{"type":"tool_use","sessionID":"opencode_123","part":{"state":{"status":"error","error":"tick ${i}"}}}\n`,
      );
      expect(fireCount).toBe(0);
    }

    expect(monitor.state().parsedEventCount).toBe(4);
    expect(monitor.state().fired).toBe(false);

    // Now silence past the threshold: fires.
    clock.advance(30_000);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("non-JSON stdout bytes also reset the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(500);
    monitor.noteOutputChunk("stdout", "loading model...\n");
    expect(monitor.state()).toMatchObject({
      outputChunkCount: 1,
      outputBytes: Buffer.byteLength("loading model...\n", "utf8"),
      parsedEventCount: 0,
    });
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("resets on process activity without output", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    clock.advance(900);
    monitor.noteProcessActivity();
    expect(monitor.state().processActivityCount).toBe(1);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("multiple JSONL events in one chunk all reset the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(500);
    monitor.noteOutputChunk(
      "stdout",
      '{"type":"text","sessionID":"a","part":{"text":"one"}}\n{"type":"step_finish","part":{"tokens":{"input":1,"output":2}}}\n',
    );
    expect(monitor.state().parsedEventCount).toBe(2);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS", () => {
  it("is the 5-second SIGTERM grace window", () => {
    expect(OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS).toBe(5_000);
  });
});
