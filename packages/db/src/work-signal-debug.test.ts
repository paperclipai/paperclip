import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkSignalDebug, parseWorkSignalDebugSpec, trimWorkSignalStack, workSignalDebug } from "./work-signal-debug.js";

const STACK = [
  "Error",
  "    at createWorkSignalDebug (/app/packages/db/src/work-signal-debug.ts:10:3)",
  "    at signalDatabaseWork (/app/packages/db/src/work-signals.ts:80:5)",
  "    at notifyDeliveryWork (/app/server/src/services/delivery-work-notifications.ts:169:3)",
  "    at notifyIssueGraphRecovery (/app/server/src/services/issue-recovery-notifications.ts:44:5)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
  "    at someLibrary (/app/node_modules/postgres/src/index.js:1:1)",
  "    at writer (/Users/someone/checkout/server/src/services/writer.ts:12:7)",
].join("\n");

function harness(spec: string | undefined, options: { maxLinesPerSecond?: number } = {}) {
  let clock = 1_000_000;
  const lines: string[] = [];
  const sink = vi.fn((text: string) => { lines.push(...text.trim().split("\n")); });
  const captureStack = vi.fn(() => STACK);
  const debug = createWorkSignalDebug({ spec, sink, captureStack, now: () => clock, flushIntervalMs: 0, ...options });
  return { debug, sink, captureStack, lines, entries: () => lines.map(line => JSON.parse(line)),
    advance: (ms: number) => { clock += ms; } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("work signal debug attribution", () => {
  it("is a strict no-op when the flag is unset or empty", () => {
    for (const spec of [undefined, "", " , "]) {
      const { debug, sink, captureStack } = harness(spec);
      const errors = vi.spyOn(globalThis, "Error");
      expect(debug.enabled).toBe(false);
      for (let index = 0; index < 50; index++) {
        debug.signal("stranded-assignments", "{\"companyId\":\"c\"}");
        debug.event("stranded-assignments", "check", { issueId: "i" }, true);
      }
      debug.flush();
      expect(captureStack).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(sink).not.toHaveBeenCalled();
    }
  });

  it("leaves the process-wide instance disabled when the environment does not set it", () => {
    expect(process.env.PAPERCLIP_DEBUG_WORK_SIGNALS ?? "").toBe("");
    expect(workSignalDebug.enabled).toBe(false);
  });

  it("logs only allowlisted topics", () => {
    const { debug, entries } = harness("stranded-assignments,run-dispatch:5");
    debug.signal("stranded-assignments", "{\"companyId\":\"c\",\"graphRunId\":\"r\"}");
    debug.signal("issue-monitors", "{\"companyId\":\"c\"}");
    debug.event("run-dispatch", "load", { scope: "*" });
    debug.event("orphan-blockers", "load", { scope: "*" });
    debug.flush();
    expect(entries().map(entry => [entry.event, entry.topic])).toEqual([
      ["signal", "stranded-assignments"], ["load", "run-dispatch"]]);
    expect(entries()[0].hint).toBe("{\"companyId\":\"c\",\"graphRunId\":\"r\"}");
  });

  it("parses per-topic sampling and ignores malformed entries", () => {
    expect([...parseWorkSignalDebugSpec("stranded-assignments:3, run-dispatch,bad topic!, :4,x:0")])
      .toEqual([["stranded-assignments", 3], ["run-dispatch", 20], ["x", 20]]);
  });

  it("captures a stack for one signal in N per topic", () => {
    const { debug, entries, captureStack } = harness("stranded-assignments:3");
    for (let index = 0; index < 7; index++) debug.signal("stranded-assignments", undefined);
    debug.flush();
    expect(captureStack).toHaveBeenCalledTimes(3);
    expect(entries().map(entry => Boolean(entry.stack))).toEqual([true, false, false, true, false, false, true]);
  });

  it("trims stacks to caller frames without dependency, wrapper or home-directory paths", () => {
    expect(trimWorkSignalStack(STACK)).toEqual([
      "at notifyIssueGraphRecovery (server/src/services/issue-recovery-notifications.ts:44:5)",
      "at writer (server/src/services/writer.ts:12:7)",
    ]);
    const deep = ["Error", ...Array.from({ length: 30 }, (_, index) => `    at f${index} (/app/server/src/f.ts:${index}:1)`)].join("\n");
    expect(trimWorkSignalStack(deep)).toHaveLength(10);
  });

  it("caps log lines per second and reports how many it suppressed", () => {
    const { debug, entries, advance } = harness("stranded-assignments:1000", { maxLinesPerSecond: 10 });
    for (let index = 0; index < 25; index++) debug.signal("stranded-assignments", undefined);
    debug.flush();
    expect(entries().filter(entry => entry.event === "signal")).toHaveLength(10);
    expect(entries().at(-1)).toMatchObject({ event: "suppressed", count: 15 });
    advance(1000);
    debug.signal("stranded-assignments", undefined);
    debug.flush();
    expect(entries().filter(entry => entry.event === "signal")).toHaveLength(11);
  });

  it("writes nothing on the signal path and flushes later from a timer", () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      const debug = createWorkSignalDebug({ spec: "stranded-assignments", sink, captureStack: () => STACK });
      debug.signal("stranded-assignments", undefined);
      expect(sink).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(sink).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(sink).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
