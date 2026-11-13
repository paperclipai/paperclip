import { describe, expect, it } from "vitest";

import { ClaudeBackgroundTaskTracker, type ClaudeBackgroundTaskState } from "./claude-background-tasks.js";
import { ClaudeProviderTurns, type ClaudeProviderTurn } from "./claude-provider-turns.js";

const SESSION = "session-1";
const air = { jetbrains: { air: { version: 1, capabilities: ["sessionFailure", "asyncTasks"] } } };
const update = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: body } });
const spawned = (id: string) => update({ sessionUpdate: "async_task_spawned", asyncTaskId: id, name: id, taskType: "shell", description: id, showInTranscript: false, canStop: true });
const finished = (id: string) => update({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state: "completed" });
const usage = () => update({ sessionUpdate: "usage_update", used: 3, size: 100 });
const endMarker = () => update({ sessionUpdate: "usage_update", used: 4, size: 100,
  _meta: { "_claude/origin": { kind: "task-notification" }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

function wiring() {
  const tracker = new ClaudeBackgroundTaskTracker();
  const terminals: Array<{ requestId: string; state: ClaudeBackgroundTaskState | null }> = [];
  const pumps: Promise<void>[] = [];
  const turns = new ClaudeProviderTurns({
    sessionId: () => SESSION,
    promptActive: () => false,
    admit: (turn: ClaudeProviderTurn) => {
      pumps.push((async () => {
        for await (const _event of turn.events) void _event;
        await turn.result;
        terminals.push({ requestId: turn.requestId, state: tracker.state() });
      })());
      return { busy: () => false, release: () => undefined };
    },
    turnStarted: () => tracker.providerTurnStarted(),
    turnEnded: (start, completed) => tracker.providerTurnEnded(start, completed),
    unadopted: () => tracker.providerTurnEnded(null, false),
  });
  const deliver = (direction: "inbound" | "outbound", message: unknown) => {
    const adopted = turns.observe(direction, message);
    tracker.observe(direction, message, adopted);
  };
  deliver("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air } } });
  deliver("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air } });
  deliver("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: SESSION } });
  deliver("inbound", spawned("task-1"));
  deliver("inbound", spawned("task-2"));
  deliver("inbound", { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
  return { tracker, terminals, pumps, deliver };
}

describe("Claude provider-started turns and background task accounting", () => {
  it("keeps the second shell live at the first cycle's terminal when the second cycle starts while the first drains", async () => {
    const { tracker, terminals, pumps, deliver } = wiring();
    expect(tracker.state()).toEqual({ live: 2 });
    deliver("inbound", finished("task-1"));
    deliver("inbound", usage());
    deliver("inbound", finished("task-2"));
    deliver("inbound", endMarker());
    deliver("inbound", usage());
    await pumps[0];
    expect(terminals[0]).toEqual({ requestId: expect.any(String), state: { live: 1 } });
    deliver("inbound", endMarker());
    await Promise.all(pumps);
    expect(terminals[1]!.state).toEqual({ live: 0 });
  });

  it("settles each cycle's own finished task when the cycles do not overlap", async () => {
    const { terminals, pumps, deliver } = wiring();
    deliver("inbound", finished("task-1"));
    deliver("inbound", usage());
    deliver("inbound", endMarker());
    await pumps[0];
    expect(terminals[0]!.state).toEqual({ live: 1 });
    deliver("inbound", finished("task-2"));
    deliver("inbound", usage());
    deliver("inbound", endMarker());
    await Promise.all(pumps);
    expect(terminals[1]!.state).toEqual({ live: 0 });
  });
});
