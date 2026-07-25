import { describe, expect, it } from "vitest";
import {
  CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC,
  createClaudeOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  readClaudeStreamToolActivity,
  resolveClaudeInactivityTimeout,
  resolveClaudeRunWallClockTimeoutSec,
} from "./output-inactivity-monitor.js";

const assistantToolUse = (id: string, name = "Bash") =>
  `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${id}","name":"${name}","input":{}}]}}\n`;
const toolResult = (id: string) =>
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${id}","content":"ok"}]}}\n`;
const assistantText = (text: string) =>
  `{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}\n`;

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

describe("resolveClaudeInactivityTimeout", () => {
  it("uses default when value is unset", () => {
    expect(resolveClaudeInactivityTimeout(undefined)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("treats explicit null as disabled", () => {
    expect(resolveClaudeInactivityTimeout(null)).toEqual({
      mode: "disabled",
      reason: "explicit_null",
    });
  });

  it("returns configured value for positive numbers", () => {
    expect(resolveClaudeInactivityTimeout(12_000)).toEqual({
      mode: "configured",
      timeoutMs: 12_000,
    });
  });

  it("falls back to default for non-positive numbers", () => {
    expect(resolveClaudeInactivityTimeout(0)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
    expect(resolveClaudeInactivityTimeout(-100)).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS,
      reason: "non_positive",
    });
  });

  it("falls back to default for non-number, non-null values", () => {
    expect(resolveClaudeInactivityTimeout("900000")).toEqual({
      mode: "default",
      timeoutMs: DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS,
    });
  });

  it("defaults to 15 minutes", () => {
    expect(DEFAULT_CLAUDE_OUTPUT_INACTIVITY_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});

describe("resolveClaudeRunWallClockTimeoutSec", () => {
  it("honors an already-resolved positive cap verbatim (passthrough)", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 1_800, rawRunWallClockTimeoutSec: undefined }),
    ).toEqual({ mode: "passthrough", timeoutSec: 1_800 });
    // An explicit timeoutSec wins even if a runWallClockTimeoutSec is also set.
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 1_800, rawRunWallClockTimeoutSec: 60 }),
    ).toEqual({ mode: "passthrough", timeoutSec: 1_800 });
  });

  it("applies the 4h default when no cap is otherwise set (local, unset)", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: undefined }),
    ).toEqual({ mode: "default", timeoutSec: DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC });
    expect(DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC).toBe(4 * 60 * 60);
  });

  it("treats explicit null as disabled when no other cap applies", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: null }),
    ).toEqual({ mode: "disabled", reason: "explicit_null" });
  });

  it("uses a positive configured override", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: 7_200 }),
    ).toEqual({ mode: "configured", timeoutSec: 7_200 });
  });

  it("falls back to default for a non-positive override", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: 0 }),
    ).toEqual({ mode: "default", timeoutSec: DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC, reason: "non_positive" });
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: -5 }),
    ).toEqual({ mode: "default", timeoutSec: DEFAULT_CLAUDE_RUN_WALL_CLOCK_TIMEOUT_SEC, reason: "non_positive" });
  });

  it("floors fractional configured values", () => {
    expect(
      resolveClaudeRunWallClockTimeoutSec({ resolvedTimeoutSec: 0, rawRunWallClockTimeoutSec: 90.7 }),
    ).toEqual({ mode: "configured", timeoutSec: 90 });
  });
});

describe("formatOutputInactivityMonitorErrorMessage", () => {
  it("formats minutes and seconds", () => {
    expect(formatOutputInactivityMonitorErrorMessage(0)).toBe("monitor: no claude output for 0m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(15 * 60 * 1000)).toBe("monitor: no claude output for 15m 0s");
    expect(formatOutputInactivityMonitorErrorMessage(15 * 60 * 1000 + 12_000)).toBe(
      "monitor: no claude output for 15m 12s",
    );
    expect(formatOutputInactivityMonitorErrorMessage(45_000)).toBe("monitor: no claude output for 0m 45s");
  });
});

describe("createClaudeOutputInactivityMonitor (fires)", () => {
  it("fires after timeoutMs when child emits one event then goes silent", () => {
    const clock = new FakeClock();
    const fires: Array<{ elapsed: number; parsedEventCount: number }> = [];
    const monitor = createClaudeOutputInactivityMonitor({
      timeoutMs: 15 * 60 * 1000,
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

    // One stream-json event right after spawn.
    clock.advance(50);
    monitor.noteStdoutChunk('{"type":"system","subtype":"init","session_id":"abc"}\n');
    expect(fires).toHaveLength(0);
    expect(monitor.state().parsedEventCount).toBe(1);

    // Now go silent for 15 minutes; monitor should fire exactly at threshold.
    clock.advance(15 * 60 * 1000 - 1);
    expect(fires).toHaveLength(0);
    clock.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0].elapsed).toBe(15 * 60 * 1000);
    expect(fires[0].parsedEventCount).toBe(1);

    const finalState = monitor.stop();
    expect(finalState.fired).toBe(true);
  });

  it("only fires once even if more silence elapses after firing", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createClaudeOutputInactivityMonitor({
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

  it("ignores non-JSON lines when resetting the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createClaudeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    // Plain stderr-ish text should NOT reset the monitor.
    clock.advance(500);
    monitor.noteStdoutChunk("loading...\n");
    expect(monitor.state().parsedEventCount).toBe(0);
    clock.advance(600);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("createClaudeOutputInactivityMonitor (does not fire)", () => {
  it("does not fire when events arrive every (threshold - 1s)", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 15 * 60 * 1000;
    const monitor = createClaudeOutputInactivityMonitor({
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
      monitor.noteStdoutChunk(`{"type":"assistant","message":{"content":[{"type":"text","text":"tick ${i}"}]}}\n`);
      expect(fireCount).toBe(0);
    }

    expect(monitor.state().parsedEventCount).toBe(12);
    expect(fireCount).toBe(0);

    monitor.stop();
    expect(fireCount).toBe(0);
  });

  it("multiple events in one chunk all reset the timer", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const monitor = createClaudeOutputInactivityMonitor({
      timeoutMs: 1_000,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire: () => {
        fireCount += 1;
      },
    });
    clock.advance(500);
    monitor.noteStdoutChunk(
      '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    );
    expect(monitor.state().parsedEventCount).toBe(2);
    clock.advance(999);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);
    monitor.stop();
  });
});

describe("createClaudeOutputInactivityMonitor (disabled)", () => {
  it("resolveClaudeInactivityTimeout returns disabled for null and the constructor rejects non-positive timeoutMs", () => {
    const resolution = resolveClaudeInactivityTimeout(null);
    expect(resolution.mode).toBe("disabled");
    expect(() =>
      createClaudeOutputInactivityMonitor({
        timeoutMs: 0,
        onFire: () => {},
      }),
    ).toThrow(/timeoutMs > 0/);
  });
});

describe("readClaudeStreamToolActivity", () => {
  it("returns null for non-tool lines", () => {
    expect(readClaudeStreamToolActivity("")).toBeNull();
    expect(readClaudeStreamToolActivity("loading...")).toBeNull();
    expect(readClaudeStreamToolActivity('{"type":"system","subtype":"init"}')).toBeNull();
    expect(readClaudeStreamToolActivity(assistantText("just thinking").trim())).toBeNull();
  });

  it("extracts started tool_use ids from an assistant event", () => {
    expect(readClaudeStreamToolActivity(assistantToolUse("toolu_1").trim())).toEqual({
      started: ["toolu_1"],
      completed: [],
    });
  });

  it("extracts completed tool_use_ids from a user tool_result event", () => {
    expect(readClaudeStreamToolActivity(toolResult("toolu_1").trim())).toEqual({
      started: [],
      completed: ["toolu_1"],
    });
  });

  it("handles parallel tool_use blocks in a single assistant event", () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{}},{"type":"text","text":"x"},{"type":"tool_use","id":"b","name":"Read","input":{}}]}}';
    expect(readClaudeStreamToolActivity(line)).toEqual({ started: ["a", "b"], completed: [] });
  });
});

describe("createClaudeOutputInactivityMonitor (tool-wait suspension)", () => {
  const makeMonitor = (clock: FakeClock, timeoutMs: number, onFire: () => void) =>
    createClaudeOutputInactivityMonitor({
      timeoutMs,
      now: () => clock.now(),
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (handle) => clock.clearTimer(handle),
      onFire,
    });

  it("does not fire while a dispatched tool has not yet returned, even far past the timeout", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 15 * 60 * 1000;
    const monitor = makeMonitor(clock, timeoutMs, () => {
      fireCount += 1;
    });

    clock.advance(50);
    monitor.noteStdoutChunk(assistantToolUse("toolu_1"));
    expect(monitor.state().pendingToolCount).toBe(1);

    // A long Bash / sub-agent Task / Workflow runs silently for 40 minutes.
    clock.advance(40 * 60 * 1000);
    expect(fireCount).toBe(0);

    monitor.stop();
  });

  it("re-arms and fires once the pending tool resolves and the run then goes silent", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 15 * 60 * 1000;
    const monitor = makeMonitor(clock, timeoutMs, () => {
      fireCount += 1;
    });

    monitor.noteStdoutChunk(assistantToolUse("toolu_1"));
    clock.advance(40 * 60 * 1000);
    expect(fireCount).toBe(0);

    // Tool returns; model is expected to resume generating. Silence is now a hang again.
    monitor.noteStdoutChunk(toolResult("toolu_1"));
    expect(monitor.state().pendingToolCount).toBe(0);
    clock.advance(timeoutMs - 1);
    expect(fireCount).toBe(0);
    clock.advance(1);
    expect(fireCount).toBe(1);

    monitor.stop();
  });

  it("stays suspended until ALL parallel tools resolve", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 10 * 60 * 1000;
    const monitor = makeMonitor(clock, timeoutMs, () => {
      fireCount += 1;
    });

    monitor.noteStdoutChunk(assistantToolUse("a"));
    monitor.noteStdoutChunk(assistantToolUse("b"));
    expect(monitor.state().pendingToolCount).toBe(2);

    monitor.noteStdoutChunk(toolResult("a"));
    expect(monitor.state().pendingToolCount).toBe(1);
    clock.advance(timeoutMs * 3);
    expect(fireCount).toBe(0); // still one tool pending

    monitor.noteStdoutChunk(toolResult("b"));
    expect(monitor.state().pendingToolCount).toBe(0);
    clock.advance(timeoutMs);
    expect(fireCount).toBe(1);

    monitor.stop();
  });

  it("still fires on a true mid-generation stall (no tool in flight)", () => {
    const clock = new FakeClock();
    let fireCount = 0;
    const timeoutMs = 5 * 60 * 1000;
    const monitor = makeMonitor(clock, timeoutMs, () => {
      fireCount += 1;
    });

    monitor.noteStdoutChunk(assistantText("hello"));
    expect(monitor.state().pendingToolCount).toBe(0);
    clock.advance(timeoutMs);
    expect(fireCount).toBe(1);

    monitor.stop();
  });
});

describe("CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS", () => {
  it("is a 5-second grace window", () => {
    expect(CLAUDE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS).toBe(5_000);
  });
});
