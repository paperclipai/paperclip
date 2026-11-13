import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createClaudeTerminalCleanupObserver, parseClaudeStreamJson } from "./parse.js";

type EventRow = [number, Record<string, unknown>];
const result = (origin?: "task-notification", turns = 2) => ({
  type: "result", subtype: "success", is_error: false,
  num_turns: turns, result: turns ? "completed" : "",
  ...(origin ? { origin: { kind: origin } } : {}),
});
const assistant = () => ({ type: "assistant", message: { content: [{ type: "tool_use" }] } });
const init = () => ({ type: "system", subtype: "init" });
const noise = () => ({ type: "system", subtype: "background_tasks_changed" });

async function syntheticRun(events: EventRow[], linger = false) {
  const js = [
    "const events = " + JSON.stringify(events) + ";",
    "for (const [ms, event] of events) setTimeout(() => process.stdout.write(JSON.stringify(event) + '\\n'), ms);",
    linger ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 580);",
  ].join("\n");
  return runChildProcess(randomUUID(), process.execPath, ["-e", js], {
    cwd: process.cwd(), env: {}, timeoutSec: 3, graceSec: 1,
    onLog: async () => {},
    terminalResultCleanup: {
      graceMs: 180,
      hasTerminalResult: ({ stdout }) => parseClaudeStreamJson(stdout).resultJson !== null,
      observeOutputEvents: createClaudeTerminalCleanupObserver(),
    },
  });
}

describe.skipIf(process.platform === "win32")("Claude multi-turn terminal cleanup", () => {
  it("does not kill after intermediate result when another real turn runs", async () => {
    const output = await syntheticRun([
      [30, assistant()], [60, result()], [95, init()],
      [135, assistant()], [450, result()],
    ]);
    expect(output.exitCode).toBe(0);
    expect(output.signal).toBeNull();
    expect(output.terminalResultCleanup).toBeNull();
  });

  it("ignores zero-turn task notifications on resume before real work", async () => {
    const output = await syntheticRun([
      [30, result("task-notification", 0)],
      [75, init()], [130, assistant()], [450, result()],
    ]);
    expect(output.exitCode).toBe(0);
    expect(output.terminalResultCleanup).toBeNull();
  });

  it("keeps SIGTERM for final result with only background notifications", async () => {
    const output = await syntheticRun([
      [30, result()], [100, noise()],
    ], true);
    expect(output.signal).toBe("SIGTERM");
    expect(output.terminalResultCleanup).toMatchObject({
      stopped: true, terminalResultSeen: true, signal: "SIGTERM",
      stopReason: "unmanaged_background_task_stopped",
    });
  });

  it("does not mistake an init without assistant work for a new active turn", async () => {
    const output = await syntheticRun([[30, result()], [90, init()]], true);
    expect(output.signal).toBe("SIGTERM");
    expect(output.terminalResultCleanup?.stopped).toBe(true);
  });

  it("does not disarm cleanup for assistant output without a new init", async () => {
    const output = await syntheticRun([[30, result()], [100, assistant()]], true);
    expect(output.signal).toBe("SIGTERM");
    expect(output.terminalResultCleanup).toMatchObject({
      stopped: true, terminalResultSeen: true, signal: "SIGTERM",
    });
  });

  it("re-arms cleanup for a later completed notification turn", async () => {
    const output = await syntheticRun([
      [30, assistant()], [60, result()], [95, init()],
      [135, assistant()], [440, result("task-notification", 2)],
    ], true);
    expect(output.signal).toBe("SIGTERM");
    expect(output.terminalResultCleanup).toMatchObject({
      stopped: true, terminalResultSeen: true, signal: "SIGTERM",
    });
  });
});
