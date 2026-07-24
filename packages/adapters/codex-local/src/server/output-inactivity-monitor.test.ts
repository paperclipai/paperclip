import { describe, expect, it } from "vitest";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  resolveCodexInactivityTimeout,
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

describe("resolveCodexInactivityTimeout", () => {
  it("defaults to 30 minutes", () => {
    expect(DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("uses default when value is unset", () => {
    expect(resolveCodexInactivityTimeout(undefined)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("treats explicit null as disabled", () => {
    expect(resolveCodexInactivityTimeout(null)).toEqual({
      mode: "disabled",
      reason: "explicit_null",
    });
  });

  it("returns configured value for positive numbers", () => {
    expect(resolveCodexInactivityTimeout(12_000)).toEqual({
      mode: "configured",
      timeoutMs: 12_000,
    });
  });

  it("falls back to default for non-positive numbers", () => {
    expect(resolveCodexInactivityTimeout(0)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
    expect(resolveCodexInactivityTimeout(-100)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
  });

  it("falls back to default for non-number, non-null values", () => {
    expect(resolveCodexInactivityTimeout("420000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });
});

describe("formatOutputInactivityMonitorErrorMessage", () => {
  it("formats minutes and seconds", () => {
    expect(formatOutputInactivityMonitorErrorMessage(0)).toBe("monitor: no codex output for 0m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(7 * 60 * 1000)).toBe("monitor: no codex output for 7m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(7 * 60 * 1000 + 12_000)).toBe("monitor: no codex output for 7m 12s");
    expect(formatOutputInactivityMonitorErrorMessage(45_000)).toBe("monitor: no codex output for 0m 45s");
  });
});

describe("createCodexOutputInactivityMonitor (acceptance criteria 1: fires)", () => {
  it("fires after timeoutMs when child emits one event then goes silent", () => {
    const clock = new FakeClock();
    const fires: Array<{ elapsed: number; parsedEventCount: number }> = [];
    const monitor = createCodexOutputInactivityMonitor({
      timeoutMs: 7 * 60 * 1000,
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

    // One event right after spawn.
    clock.advance(50);
    monitor.noteOutputChunk("stdout", '{"type":"thread.started","thread_id":"abc"}\n');
    expect(fires).toHaveLength(0);
    expect(monitor.state().parsedEventCount).toBe(1);

    // Now go silent for 7 minutes; monitor should fire exactly at threshold.
    clock.advance(7 * 60 * 1000 - 1);
    expect(fires).toHaveLength(0);
    clock.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].elapsed).toBe(7 * 60 * 1000);
    expect(fires[0].parsedEventCount).toBe(1);

    // Stopping after fire is a no-op for the timer but returns final state.
    const finalState = monitor.stop();
    expect(finalState.fired).toBe(true);
  });

  it("only fires once even if more silence elapses after firing", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createCodexOutputInactivityMonitor({
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

  it("resets on non-JSON stdout bytes", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createCodexOutputInactivityMonitor({
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
});

describe("createCodexOutputInactivityMonitor (acceptance criteria 2: does not fire)", () => {
  it("keeps long verification alive while non-JSON stdout and stderr bytes continue", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 7 * 60 * 1000;
    const monitor = createCodexOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    clock.advance(timeoutMs - 1_000);
    monitor.noteOutputChunk("stdout", "packages/server: typecheck passed\n");
    clock.advance(timeoutMs - 1_000);
    monitor.noteOutputChunk("stderr", "packages/ui: build still running\n");
    clock.advance(timeoutMs - 1_000);
    monitor.noteOutputChunk("stdout", "packages/ui: build passed\n");

    expect(fireCount).toBe(0);
    expect(monitor.state()).toMatchObject({
      outputChunkCount: 3,
      parsedEventCount: 0,
      fired: false,
    });
    monitor.stop();
  });

  it("does not fire when events arrive every (threshold - 1s)", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 7 * 60 * 1000;
    const monitor = createCodexOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    // Pump events at threshold-1s intervals for 12 cycles (~84 minutes).
    for (let i = 0; i < 12; i += 1) {
      clock.advance(timeoutMs - 1_000);
      monitor.noteOutputChunk("stdout", `{"type":"item.completed","item":{"type":"agent_message","text":"tick ${i}"}}\n`);
      expect(fireCount).toBe(0);
    }

    // Final event lets us "complete" — total state shows 12 parsed events.
    expect(monitor.state().parsedEventCount).toBe(12);
    expect(fireCount).toBe(0);

    // Stop cleanly before the timer would have fired.
    monitor.stop();
    expect(fireCount).toBe(0);
  });

  it("multiple events in one chunk all reset the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createCodexOutputInactivityMonitor({
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
      '{"type":"thread.started","thread_id":"a"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n',
    );
    expect(monitor.state().parsedEventCount).toBe(2);
    // Now wait 999ms — should still not fire.
    clock.advance(999);
    expect(fireCount).toBe(0);
    // Wait one more ms — fires now.
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("createCodexOutputInactivityMonitor (acceptance criteria 3: disabled)", () => {
  it("resolveCodexInactivityTimeout returns disabled for null and the adapter creates no monitor", () => {
    const resolution = resolveCodexInactivityTimeout(null);
    expect(resolution.mode).toBe("disabled");
    // Sanity: when a caller (execute.ts) honors `disabled`, it must not
    // construct a monitor at all. Verify the constructor would otherwise
    // require a positive timeoutMs.
    expect(() =>
      createCodexOutputInactivityMonitor({
        timeoutMs: 0,
        onFire: () => {},
      }),
    ).toThrow(/timeoutMs > 0/);
  });
});

describe("CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS", () => {
  it("matches the 5-second grace window required by NEE-81", () => {
    expect(CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS).toBe(5_000);
  });
});
