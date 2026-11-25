import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkSignalStack, createWorkSignalDebug, parseWorkSignalDebugSpec, trimWorkSignalStack, workSignalDebug } from "./work-signal-debug.js";

const SOURCE_STACK = [
  "Error",
  "    at notifyDeliveryWork (/app/server/src/services/delivery-work-notifications.ts:169:3)",
  "    at notifyIssueGraphRecovery (/app/server/src/services/issue-recovery-notifications.ts:44:5)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
  "    at someLibrary (/app/node_modules/postgres/src/index.js:1:1)",
  "    at writer (/app/server/src/services/writer.ts:12:7)",
].join("\n");

const BUNDLE = "file:///app/server/dist-runtime/index.mjs";
const BUNDLED_STACK = [
  "Error",
  `    at notifyDeliveryWork (${BUNDLE}:91234:9)`,
  `    at notifyIssueGraphRecovery (${BUNDLE}:120456:11)`,
  `    at async notifyRunDispatch (${BUNDLE}:120501:3)`,
  `    at async PostgresJsDatabase.connection.transaction [as transaction] (${BUNDLE}:4021:22)`,
  `    at async Object.settleRunProjection (${BUNDLE}:300777:5)`,
  `    at async ${BUNDLE}:310002:17`,
  "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
].join("\n");

function harness(spec: string | undefined, options: { maxLinesPerSecond?: number; stack?: string } = {}) {
  let clock = 1_000_000;
  const lines: string[] = [];
  const sink = vi.fn((text: string) => { lines.push(...text.trim().split("\n")); });
  const captureStack = vi.fn((_entry: Function) => options.stack ?? SOURCE_STACK);
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
      const capture = vi.spyOn(Error, "captureStackTrace");
      expect(debug.enabled).toBe(false);
      for (let index = 0; index < 50; index++) {
        debug.signal("stranded-assignments", "{\"companyId\":\"c\"}");
        debug.event("stranded-assignments", "direct_wake", { queues: "a" }, "always");
      }
      debug.flush();
      expect(captureStack).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
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
    expect(debug.allows("run-dispatch")).toBe(true);
    expect(debug.allows("orphan-blockers")).toBe(false);
  });

  it("parses per-topic sampling and ignores malformed entries", () => {
    expect([...parseWorkSignalDebugSpec("stranded-assignments:3, run-dispatch,bad topic!, :4,x:0,live:7f3e-11,live:7f3e-12:4")])
      .toEqual([["stranded-assignments", 3], ["run-dispatch", 20], ["x", 20], ["live:7f3e-11", 20], ["live:7f3e-12", 4]]);
    const { debug, entries } = harness("live:7f3e-11");
    debug.event("live:7f3e-11", "remote_notification");
    debug.flush();
    expect(entries()).toEqual([expect.objectContaining({ topic: "live:7f3e-11", event: "remote_notification" })]);
  });

  it("samples stacks one in N per topic and event, independent of other events", () => {
    const { debug, entries, captureStack } = harness("stranded-assignments:3");
    for (let index = 0; index < 7; index++) {
      debug.signal("stranded-assignments", undefined);
      debug.event("stranded-assignments", "check", { issueId: `i${index}` }, "sampled");
      debug.event("stranded-assignments", "load", { scope: "*" }, "sampled");
    }
    debug.flush();
    const signals = entries().filter(entry => entry.event === "signal");
    expect(signals.map(entry => Boolean(entry.stack))).toEqual([true, false, false, true, false, false, true]);
    expect(captureStack).toHaveBeenCalledTimes(9);
  });

  it("captures an always-on stack for direct wakes on every call", () => {
    const { debug, entries, captureStack } = harness("stranded-assignments:20");
    for (let index = 0; index < 3; index++) debug.event("stranded-assignments", "direct_wake", { queues: "a,b" }, "always");
    debug.flush();
    expect(captureStack).toHaveBeenCalledTimes(3);
    expect(entries().every(entry => Array.isArray(entry.stack) && entry.queues === "a,b")).toBe(true);
  });

  it("trims a source-tree stack by file and by function name", () => {
    expect(trimWorkSignalStack(SOURCE_STACK)).toEqual([
      "at notifyIssueGraphRecovery (/app/server/src/services/issue-recovery-notifications.ts:44:5)",
      "at writer (/app/server/src/services/writer.ts:12:7)",
    ]);
    const deep = ["Error", ...Array.from({ length: 30 }, (_, index) => `    at f${index} (/app/server/src/f.ts:${index}:1)`)].join("\n");
    expect(trimWorkSignalStack(deep)).toHaveLength(10);
  });

  it("keeps raw bundle positions and drops wrappers by function name when every frame is in one bundled file", () => {
    const { debug, entries } = harness("stranded-assignments:1", { stack: BUNDLED_STACK });
    debug.signal("stranded-assignments", "{\"companyId\":\"c\",\"graphRunId\":\"r\"}");
    debug.event("stranded-assignments", "check", { issueId: "i", companyId: "c", wake: "load", dueAt: 1 });
    debug.event("stranded-assignments", "direct_wake", { queues: "stranded-assignments,orphan-blockers" }, "always");
    debug.flush();
    expect(entries()[0].stack).toEqual([
      `at notifyIssueGraphRecovery (${BUNDLE}:120456:11)`,
      `at async notifyRunDispatch (${BUNDLE}:120501:3)`,
      `at async PostgresJsDatabase.connection.transaction [as transaction] (${BUNDLE}:4021:22)`,
      `at async Object.settleRunProjection (${BUNDLE}:300777:5)`,
      `at async ${BUNDLE}:310002:17`,
    ]);
    if (process.env.WORK_SIGNAL_DEBUG_SAMPLE_OUT) appendFileSync(process.env.WORK_SIGNAL_DEBUG_SAMPLE_OUT,
      entries().map(entry => JSON.stringify(entry)).join("\n") + "\n");
  });

  it("captures frames below the entry function with a raised and restored stack limit", () => {
    const before = Error.stackTraceLimit;
    function signalEntry() { return captureWorkSignalStack(signalEntry); }
    function nest(depth: number): string | undefined { return depth === 0 ? signalEntry() : nest(depth - 1); }
    const stack = nest(25);
    expect(Error.stackTraceLimit).toBe(before);
    const frames = (stack ?? "").split("\n").slice(1);
    expect(frames.some(frame => frame.includes("signalEntry"))).toBe(false);
    expect(frames.filter(frame => frame.includes("nest")).length).toBeGreaterThan(before);
  });

  it("budgets each topic and event separately so frequent checks never drop signals", () => {
    const { debug, entries, advance } = harness("stranded-assignments:1000", { maxLinesPerSecond: 10 });
    let signals = 0;
    for (let second = 0; second < 5; second++) {
      for (let tick = 0; tick < 24; tick++) {
        debug.event("stranded-assignments", "check", { issueId: `i${tick}` });
        if (tick % 8 === 0) { debug.signal("stranded-assignments", `h${second}-${tick}`); signals++; }
        if (tick % 3 === 0) debug.event("stranded-assignments", "check", { issueId: `x${tick}` });
        advance(1000 / 24);
      }
    }
    debug.flush();
    expect(entries().filter(entry => entry.event === "signal")).toHaveLength(signals);
    expect(entries().filter(entry => entry.event === "check").length).toBeLessThanOrEqual(5 * 10 + 10);
    const suppressed = entries().filter(entry => entry.event === "suppressed");
    expect(suppressed).toEqual([expect.objectContaining({ topic: "stranded-assignments", suppressedEvent: "check" })]);
    expect(suppressed[0].count).toBeGreaterThan(0);
  });

  it("captures no stack for a record the cap suppresses", () => {
    const { debug, captureStack, entries } = harness("stranded-assignments:1", { maxLinesPerSecond: 3 });
    for (let index = 0; index < 20; index++) {
      debug.signal("stranded-assignments", undefined);
      debug.event("stranded-assignments", "direct_wake", { queues: "a" }, "always");
    }
    debug.flush();
    expect(captureStack).toHaveBeenCalledTimes(6);
    expect(entries().filter(entry => entry.event === "suppressed").map(entry => [entry.suppressedEvent, entry.count]))
      .toEqual([["signal", 17], ["direct_wake", 17]]);
  });

  it("writes nothing on the signal path and flushes later from a timer", () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      const debug = createWorkSignalDebug({ spec: "stranded-assignments", sink, captureStack: () => SOURCE_STACK });
      debug.signal("stranded-assignments", undefined);
      expect(sink).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(sink).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(sink).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
