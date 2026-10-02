import { describe, expect, it } from "vitest";
import {
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOpenCodeOutputInactivityMonitorErrorMessage,
  resolveOpenCodeInactivityTimeout,
} from "./output-inactivity-monitor.js";
import { createOpenCodeProcessActivityMonitor } from "./process-activity-monitor.js";

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
  it("defaults to 30 minutes", () => {
    expect(DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS).toBe(30 * 60 * 1000);
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
    expect(resolveOpenCodeInactivityTimeout(12_000)).toEqual({
      mode: "configured",
      timeoutMs: 12_000,
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
    expect(resolveOpenCodeInactivityTimeout("420000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_OPENCODE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });
});

describe("formatOpenCodeOutputInactivityMonitorErrorMessage", () => {
  it("formats minutes and seconds", () => {
    expect(formatOpenCodeOutputInactivityMonitorErrorMessage(0)).toBe(
      "monitor: no opencode activity (model events) for 0m 0s",
    );
    expect(formatOpenCodeOutputInactivityMonitorErrorMessage(7 * 60 * 1000)).toBe(
      "monitor: no opencode activity (model events) for 7m 0s",
    );
    expect(formatOpenCodeOutputInactivityMonitorErrorMessage(7 * 60 * 1000 + 12_000)).toBe(
      "monitor: no opencode activity (model events) for 7m 12s",
    );
    expect(formatOpenCodeOutputInactivityMonitorErrorMessage(45_000)).toBe(
      "monitor: no opencode activity (model events) for 0m 45s",
    );
  });
});

describe("createOpenCodeOutputInactivityMonitor", () => {
  it("fires after timeoutMs when stdout emits one JSONL event then goes silent", () => {
    const clock = new FakeClock();
    const fires: Array<{ elapsed: number; parsedEventCount: number }> = [];
    const monitor = createOpenCodeOutputInactivityMonitor({
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

    clock.advance(50);
    monitor.noteOutputChunk("stdout", '{"type":"step_start","sessionID":"ses_a"}\n');
    expect(fires).toHaveLength(0);
    expect(monitor.state().parsedEventCount).toBe(1);

    clock.advance(7 * 60 * 1000 - 1);
    expect(fires).toHaveLength(0);
    clock.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].elapsed).toBe(7 * 60 * 1000);
    expect(fires[0].parsedEventCount).toBe(1);

    const finalState = monitor.stop();
    expect(finalState.fired).toBe(true);
  });

  it("does NOT reset on stderr chunks (print-logs retry storm must not keep a doomed run alive)", () => {
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

    // Simulate a rate-limited retry storm: WARN logs every 250ms past the timeout.
    const chunk = "ERROR stream error, retrying in 2.0s\n";
    for (let i = 0; i < 48 && fireCount === 0; i += 1) {
      clock.advance(250);
      monitor.noteOutputChunk("stderr", chunk);
    }
    // 48 * 250ms = 12s > timeoutMs — the monitor must have fired despite stderr traffic.
    expect(fireCount).toBe(1);
    const finalState = monitor.stop();
    expect(finalState).toMatchObject({
      fired: true,
      parsedEventCount: 0,
    });
    expect(finalState.stderrChunkCount).toBeGreaterThan(0);
  });

  it("resets on process activity without output (long silent tool executions stay alive)", () => {
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

  it("keeps healthy runs alive when JSONL events keep arriving", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 7 * 60 * 1000;
    const monitor = createOpenCodeOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });

    for (let i = 0; i < 12; i += 1) {
      clock.advance(timeoutMs - 1_000);
      monitor.noteOutputChunk("stdout", `{"type":"step_finish","part":{"tokens":{"input":10,"output":5}}}\n`);
      expect(fireCount).toBe(0);
    }

    expect(monitor.state().parsedEventCount).toBe(12);
    expect(fireCount).toBe(0);
    monitor.stop();
    expect(fireCount).toBe(0);
  });

  it("counts a JSONL event split across two stdout chunks as progress (incomplete lines are buffered)", () => {
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
    clock.advance(600);
    monitor.noteOutputChunk("stdout", '{"type":"step_st');
    monitor.noteOutputChunk("stdout", 'art","sessionID":"ses_a"}\n');
    expect(monitor.state().parsedEventCount).toBe(1);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("counts an event split across three chunks with CRLF boundaries as progress", () => {
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
    monitor.noteOutputChunk("stdout", '{"type":"te');
    monitor.noteOutputChunk("stdout", "xt\",\"part\":{\"text\":\"hi\"}}\r");
    monitor.noteOutputChunk("stdout", "\n");
    expect(monitor.state().parsedEventCount).toBe(1);
    monitor.stop();
    expect(fireCount).toBe(0);
  });

  it("retry-storm stderr plus an idle process does NOT keep the run alive (composed production wiring)", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const inactivity = createOpenCodeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    // Production wiring (execute.ts wrappedOnSpawn): a process-activity
    // monitor feeds noteProcessActivity(). A retrying opencode idles between
    // backoff sleeps — CPU ticks, IO bytes, and the child list stay
    // unchanged — so the activity monitor must never report progress and the
    // retry storm must still be bounded despite its stderr traffic.
    const activity = createOpenCodeProcessActivityMonitor({
      pid: 4242,
      processGroupId: 4242,
      intervalMs: 100,
      sample: async () => ({ cpuTicks: 10, ioBytes: 100, processIds: "4242" }),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onActivity: () => inactivity.noteProcessActivity(),
    });
    const chunk = "ERROR stream error, retrying in 2.0s\n";
    for (let i = 0; i < 48 && fireCount === 0; i += 1) {
      clock.advance(250);
      inactivity.noteOutputChunk("stderr", chunk);
    }
    activity.stop();
    inactivity.stop();
    expect(fireCount).toBe(1);
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
      '{"type":"step_start","sessionID":"ses_a"}\n{"type":"text","part":{"text":"hi"}}\n',
    );
    expect(monitor.state().parsedEventCount).toBe(2);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });

  it("only fires once even if more silence elapses after firing", () => {
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
});

describe("disabled monitor", () => {
  it("resolveOpenCodeInactivityTimeout returns disabled for null and callers must not construct a monitor", () => {
    const resolution = resolveOpenCodeInactivityTimeout(null);
    expect(resolution.mode).toBe("disabled");
    expect(() =>
      createOpenCodeOutputInactivityMonitor({
        timeoutMs: 0,
        onFire: () => {},
      }),
    ).toThrow(/timeoutMs > 0/);
  });
});

describe("OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS", () => {
  it("matches the 5-second grace window used by codex-local", () => {
    expect(OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS).toBe(5_000);
  });
});
