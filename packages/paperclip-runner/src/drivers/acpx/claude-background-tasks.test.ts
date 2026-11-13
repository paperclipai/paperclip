import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ClaudeBackgroundTaskTracker } from "./claude-background-tasks.js";
import { readGeneratedAcpxBackgroundTasks } from "./generated-sidecar-contract.js";

const vectors = JSON.parse(readFileSync(
  new URL("../../../protocol/fixtures/provider-boundary/acpx-background-tasks.json", import.meta.url), "utf8",
)) as { accepted: Array<{ value: unknown; live: number }>; rejected: Array<{ case: string; value: unknown }> };

describe("generated ACPX background task reader", () => {
  it("accepts and rejects exactly the shared vectors", () => {
    for (const { value, live } of vectors.accepted) expect(readGeneratedAcpxBackgroundTasks(value)).toEqual({ live });
    for (const { value, case: name } of vectors.rejected) expect(readGeneratedAcpxBackgroundTasks(value), name).toBeNull();
    expect(readGeneratedAcpxBackgroundTasks(undefined)).toBeNull();
  });
});

const air = (capabilities: string[]) => ({ jetbrains: { air: { version: 1, capabilities } } });

function negotiated(client = ["sessionFailure", "asyncTasks"], agent = ["sessionFailure", "asyncTasks"]) {
  const tracker = new ClaudeBackgroundTaskTracker();
  tracker.observe("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air(client) } } });
  tracker.observe("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air(agent) } });
  return tracker;
}

const update = (value: Record<string, unknown>) => ({
  jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: value },
});

function prompt(tracker: ClaudeBackgroundTaskTracker, id: number, updates: Array<Record<string, unknown>>) {
  tracker.observe("outbound", { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "session-1" } });
  for (const value of updates) tracker.observe("inbound", update(value));
  tracker.observe("inbound", { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

const spawned = (taskType = "shell") => ({
  sessionUpdate: "async_task_spawned", asyncTaskId: "task-1", name: "background", taskType,
  description: "background", showInTranscript: false, canStop: true,
});
const backgrounded = {
  sessionUpdate: "tool_call_update", toolCallId: "toolu_1",
  _meta: { claudeCode: { toolName: "Bash", toolResponse: { backgroundTaskId: "task-1" } } },
};
const settled = (state: string) => ({ sessionUpdate: "async_task_state_update", asyncTaskId: "task-1", state });

describe("ClaudeBackgroundTaskTracker", () => {
  it("knows a negotiated provider that started no background work is quiet", () => {
    const tracker = negotiated();
    prompt(tracker, 1, [
      { sessionUpdate: "tool_call", toolCallId: "toolu_1", _meta: { claudeCode: { toolName: "Bash" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed" },
      { sessionUpdate: "usage_update", used: 1, size: 2, _meta: { "_claude/origin": { kind: "human" } } },
    ]);
    tracker.observe("inbound", update({ sessionUpdate: "session_info_update", title: "Done" }));
    expect(tracker.state()).toEqual({ live: 0 });
  });

  it("reports a spawned background shell as live", () => {
    const tracker = negotiated();
    prompt(tracker, 1, [spawned(), { sessionUpdate: "async_task_progress", asyncTaskId: "task-1", toolCallId: "toolu_1" }, backgrounded]);
    expect(tracker.state()).toEqual({ live: 1 });
    tracker.observe("inbound", update(settled("paused")));
    expect(tracker.state()).toEqual({ live: 1 });
  });

  it.each(["completed", "failed", "stopped"])("never reports quiet again after a background shell %s", (state) => {
    const tracker = negotiated();
    prompt(tracker, 1, [spawned(), backgrounded]);
    tracker.observe("inbound", update(settled(state)));
    expect(tracker.state()).toBeNull();
    prompt(tracker, 2, []);
    expect(tracker.state()).toBeNull();
  });

  it("counts a backgrounded Bash result even before its async task is announced", () => {
    const tracker = negotiated();
    prompt(tracker, 1, [backgrounded]);
    expect(tracker.state()).toEqual({ live: 1 });
  });

  it("cannot classify a live monitor or other non-shell task, which covers ambient watchers", () => {
    for (const taskType of ["monitor", "workflow", "task"]) {
      const tracker = negotiated();
      prompt(tracker, 1, [spawned(taskType)]);
      expect(tracker.state(), taskType).toBeNull();
    }
  });

  it("ignores subagents, which the adapter holds inside their spawning turn", () => {
    const tracker = negotiated();
    prompt(tracker, 1, [
      { sessionUpdate: "tool_call", toolCallId: "toolu_1", _meta: { claudeCode: { toolName: "Agent", subagent: true } } },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", _meta: { claudeCode: { toolResponse: { isAsync: true, status: "async_launched" } } } },
      { sessionUpdate: "tool_call", toolCallId: "toolu_2", _meta: { claudeCode: { toolName: "Read", parentToolUseId: "toolu_1" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", _meta: { claudeCode: { subagentState: { status: "completed" } } } },
      { sessionUpdate: "usage_update", used: 1, size: 2, _meta: { "_claude/origin": { kind: "task-notification" } } },
    ]);
    expect(tracker.state()).toEqual({ live: 0 });
  });

  it("is unknown without negotiating the asyncTasks capability on both sides", () => {
    expect(new ClaudeBackgroundTaskTracker().state()).toBeNull();
    expect(negotiated(["sessionFailure"]).state()).toBeNull();
    expect(negotiated(undefined, ["sessionFailure"]).state()).toBeNull();
    const tracker = negotiated();
    tracker.observe("outbound", { jsonrpc: "2.0", id: 9, method: "initialize", params: { clientCapabilities: { _meta: air(["asyncTasks"]) } } });
    tracker.observe("inbound", { jsonrpc: "2.0", id: 9, result: { _meta: air([]) } });
    expect(tracker.state()).toBeNull();
  });

  it("is unknown after malformed, unannounced or unrecognized task updates", () => {
    const cases: Array<Record<string, unknown>> = [
      { sessionUpdate: "async_task_spawned", taskType: "shell" },
      { sessionUpdate: "async_task_progress", asyncTaskId: "unannounced" },
      { sessionUpdate: "async_task_state_update", asyncTaskId: "task-1", state: "exploded" },
      { sessionUpdate: "async_task_renamed", asyncTaskId: "task-1" },
      { ...backgrounded, _meta: { claudeCode: { toolResponse: { backgroundTaskId: 7 } } } },
    ];
    for (const value of cases) {
      const tracker = negotiated();
      prompt(tracker, 1, [spawned(), value]);
      expect(tracker.state(), JSON.stringify(value)).toBeNull();
    }
  });

  it("is unknown once Claude acts with no request in flight or schedules its own wakeup", () => {
    const idle = negotiated();
    prompt(idle, 1, []);
    idle.observe("inbound", update({ sessionUpdate: "tool_call", toolCallId: "toolu_9", _meta: { claudeCode: { toolName: "Read" } } }));
    expect(idle.state()).toBeNull();

    const idleUsage = negotiated();
    prompt(idleUsage, 1, []);
    idleUsage.observe("inbound", update({ sessionUpdate: "usage_update", _meta: { "_claude/origin": { kind: "task-notification" } } }));
    expect(idleUsage.state()).toBeNull();

    const idleRequest = negotiated();
    idleRequest.observe("inbound", { jsonrpc: "2.0", id: 4, method: "session/request_permission", params: {} });
    expect(idleRequest.state()).toBeNull();

    for (const toolName of ["CronCreate", "ScheduleWakeup"]) {
      const scheduled = negotiated();
      prompt(scheduled, 1, [{ sessionUpdate: "tool_call", toolCallId: "toolu_1", _meta: { claudeCode: { toolName } } }]);
      expect(scheduled.state(), toolName).toBeNull();
    }
  });

  it("does not treat replayed history during a session load as idle activity", () => {
    const tracker = negotiated();
    tracker.observe("outbound", { jsonrpc: "2.0", id: 1, method: "session/load", params: {} });
    tracker.observe("inbound", update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier" } }));
    tracker.observe("inbound", { jsonrpc: "2.0", id: 1, result: {} });
    expect(tracker.state()).toEqual({ live: 0 });
  });

  it("is unknown when its bounded ledgers overflow or a request id is reused", () => {
    const reused = negotiated();
    reused.observe("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt" });
    reused.observe("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt" });
    expect(reused.state()).toBeNull();

    const pending = negotiated();
    for (let id = 1; id <= 257; id += 1) pending.observe("outbound", { jsonrpc: "2.0", id, method: "session/prompt" });
    expect(pending.state()).toBeNull();

    const tasks = negotiated();
    tasks.observe("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt" });
    for (let index = 0; index < 257; index += 1) {
      tasks.observe("inbound", update({ ...spawned(), asyncTaskId: `task-${index}` }));
    }
    expect(tasks.state()).toBeNull();
  });
});
