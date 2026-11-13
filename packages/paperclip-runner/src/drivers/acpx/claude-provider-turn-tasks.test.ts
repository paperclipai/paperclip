import { describe, expect, it } from "vitest";

import type { ClaudeBackgroundTaskState } from "./claude-background-tasks.js";
import { ClaudeProviderCycles } from "./claude-provider-turns.js";

const SESSION = "session-1";
const air = { jetbrains: { air: { version: 1, capabilities: ["sessionFailure", "asyncTasks"] } } };
const update = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: body } });
const spawned = (id: string) => update({ sessionUpdate: "async_task_spawned", asyncTaskId: id, name: id, taskType: "shell", description: id, showInTranscript: false, canStop: true });
const finished = (id: string) => update({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state: "completed" });
const usage = () => update({ sessionUpdate: "usage_update", used: 3, size: 100 });
const endMarker = () => update({ sessionUpdate: "usage_update", used: 4, size: 100,
  _meta: { "_claude/origin": { kind: "task-notification" }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

function wiring() {
  const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
  const terminals: Array<{ requestId: string; state: ClaudeBackgroundTaskState | null }> = [];
  const consumed = (async () => {
    let requestId = "";
    for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
      if (item.type === "started") {
        requestId = item.requestId;
        cycles.adopt(() => false);
      }
      if (item.type === "ended") terminals.push({ requestId, state: cycles.backgroundTasks() });
    }
  })();
  const deliver = (direction: "inbound" | "outbound", message: unknown) => { cycles.observe(direction, message); };
  const terminal = async (count: number) => {
    while (terminals.length < count) await new Promise(resolve => setTimeout(resolve, 1));
  };
  deliver("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air } } });
  deliver("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air } });
  deliver("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: SESSION } });
  deliver("inbound", spawned("task-1"));
  deliver("inbound", spawned("task-2"));
  deliver("inbound", { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
  return { cycles, terminals, terminal, deliver, consumed };
}

describe("Claude provider-started turns and background task accounting", () => {
  it("keeps the second shell live at the first cycle's terminal when the second cycle starts before the first is consumed", async () => {
    const { cycles, terminals, terminal, deliver } = wiring();
    expect(cycles.backgroundTasks()).toEqual({ live: 2 });
    deliver("inbound", finished("task-1"));
    deliver("inbound", usage());
    deliver("inbound", finished("task-2"));
    deliver("inbound", endMarker());
    deliver("inbound", usage());
    await terminal(1);
    expect(terminals[0]).toEqual({ requestId: expect.any(String), state: { live: 1 } });
    deliver("inbound", endMarker());
    await terminal(2);
    expect(terminals[1]!.state).toEqual({ live: 0 });
  });

  it("settles each cycle's own finished task when the cycles do not overlap", async () => {
    const { terminals, terminal, deliver } = wiring();
    deliver("inbound", finished("task-1"));
    deliver("inbound", usage());
    deliver("inbound", endMarker());
    await terminal(1);
    expect(terminals[0]!.state).toEqual({ live: 1 });
    deliver("inbound", finished("task-2"));
    deliver("inbound", usage());
    deliver("inbound", endMarker());
    await terminal(2);
    expect(terminals[1]!.state).toEqual({ live: 0 });
  });

  it("makes the background state unknown when a cycle is dropped", async () => {
    const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
    cycles.observe("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air } } });
    cycles.observe("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air } });
    cycles.observe("inbound", spawned("task-1"));
    cycles.observe("inbound", finished("task-1"));
    cycles.observe("inbound", usage());
    expect(cycles.backgroundTasks()).toEqual({ live: 1 });
    expect(await cycles.next()).toMatchObject({ type: "started" });
    cycles.drop();
    expect(cycles.backgroundTasks()).toBeNull();
    expect(await cycles.next()).toBeNull();
  });
});
