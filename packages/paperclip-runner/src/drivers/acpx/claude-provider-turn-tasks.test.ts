import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ClaudeBackgroundTaskState } from "./claude-background-tasks.js";
import { ClaudeProviderCycles } from "./claude-provider-turns.js";

const SESSION = "session-1";
const air = { jetbrains: { air: { version: 1, capabilities: ["sessionFailure", "asyncTasks"] } } };
const update = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: body } });
const spawned = (id: string) => update({ sessionUpdate: "async_task_spawned", asyncTaskId: id, name: id, taskType: "shell", description: id, showInTranscript: false, canStop: true });
const finished = (id: string) => update({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state: "completed" });
const usage = () => update({ sessionUpdate: "usage_update", used: 3, size: 100 });
const text = () => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Handled a notification." } });
const toolCall = (id: string) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "Read", kind: "read", status: "pending" });
const endMarker = (tokens = 1) => update({ sessionUpdate: "usage_update", used: 5, size: 100, cost: { amount: 0.000104, currency: "USD" },
  _meta: { "_claude/origin": { kind: "task-notification", producer: "session-task" }, usage: { input_tokens: tokens, output_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const humanEnd = () => update({ sessionUpdate: "usage_update", used: 5, size: 100, _meta: { "_claude/origin": { kind: "human" } } });

type Seen = { started: number; ended: Array<ClaudeBackgroundTaskState | null> };

function wiring() {
  const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
  const seen: Seen = { started: 0, ended: [] };
  void (async () => {
    for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
      if (item.type === "started") {
        seen.started += 1;
        cycles.adopt(() => false);
      }
      if (item.type === "ended") seen.ended.push(cycles.backgroundTasks());
    }
  })();
  const deliver = (...messages: unknown[]) => { for (const message of messages) cycles.observe("inbound", message); };
  let id = 0;
  const prompt = (...messages: unknown[]) => {
    const request = ++id;
    cycles.observe("outbound", { jsonrpc: "2.0", id: request, method: "session/prompt", params: { sessionId: SESSION } });
    deliver(...messages, humanEnd(), { jsonrpc: "2.0", id: request, result: { stopReason: "end_turn" } });
    return cycles.backgroundTasks();
  };
  const ended = async (count: number) => {
    while (seen.ended.length < count) await new Promise(resolve => setTimeout(resolve, 1));
    return seen.ended[count - 1];
  };
  cycles.observe("outbound", { jsonrpc: "2.0", id: 1_000, method: "initialize", params: { clientCapabilities: { _meta: air } } });
  deliver({ jsonrpc: "2.0", id: 1_000, result: { protocolVersion: 1, _meta: air } });
  return { cycles, seen, deliver, prompt, ended };
}

describe("Claude provider-started turns and background task accounting", () => {
  it("knows a process without background work is quiet at every terminal", () => {
    const { prompt } = wiring();
    expect(prompt(toolCall("toolu_1"))).toEqual({ live: 0 });
    expect(prompt(text())).toEqual({ live: 0 });
  });

  it("waits for a single shell, then is unknown once its cycle ran", async () => {
    const { prompt, deliver, ended } = wiring();
    expect(prompt(spawned("task-1"))).toEqual({ live: 1 });
    deliver(finished("task-1"), usage(), text(), endMarker());
    expect(await ended(1)).toBeNull();
  });

  it("keeps the shells that still run live after each cycle and is unknown after the last one", async () => {
    const { prompt, deliver, ended } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"))).toEqual({ live: 2 });
    deliver(finished("task-1"));
    deliver(usage(), text(), endMarker());
    expect(await ended(1)).toEqual({ live: 1 });
    deliver(finished("task-2"), usage(), text(), endMarker(2));
    expect(await ended(2)).toBeNull();
  });

  it("is unknown when a second shell finishes before the first cycle's first update", async () => {
    const { prompt, deliver, ended } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"))).toEqual({ live: 2 });
    deliver(finished("task-1"), finished("task-2"), usage(), text(), endMarker());
    expect(await ended(1)).toBeNull();
  });

  it("is unknown when a second shell's notification may be consumed inside the running cycle", async () => {
    const { prompt, deliver, ended } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"))).toEqual({ live: 2 });
    deliver(finished("task-1"), usage(), toolCall("toolu_cycle"), finished("task-2"), text(), endMarker());
    expect(await ended(1)).toBeNull();
  });

  it("ignores an empty result right after a cycle's end, as in the E2 capture, and adopts the next real cycle", async () => {
    const { prompt, deliver, ended, seen } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"), spawned("task-3"))).toEqual({ live: 3 });
    deliver(finished("task-1"), finished("task-2"), finished("task-3"), usage(), text(), usage(), endMarker(), endMarker(0));
    expect(await ended(1)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen.started).toBe(1);
    deliver(usage(), text(), usage(), endMarker(2));
    expect(await ended(2)).toBeNull();
    expect(seen.started).toBe(2);
  });

  it("keeps a running shell live through an empty result after a cycle", async () => {
    const { prompt, deliver, ended, cycles, seen } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"))).toEqual({ live: 2 });
    deliver(finished("task-1"), usage(), text(), endMarker());
    expect(await ended(1)).toEqual({ live: 1 });
    deliver(endMarker(0));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen.started).toBe(1);
    expect(cycles.backgroundTasks()).toEqual({ live: 1 });
  });

  it("still adopts a failed cycle's lone end marker after a task finished, even when it repeats the last one", async () => {
    const { prompt, deliver, ended, seen } = wiring();
    expect(prompt(spawned("task-1"), spawned("task-2"))).toEqual({ live: 2 });
    deliver(finished("task-1"), endMarker(0));
    expect(await ended(1)).toEqual({ live: 1 });
    deliver(finished("task-2"), endMarker(0));
    expect(await ended(2)).toBeNull();
    expect(seen.started).toBe(2);
  });

  it("replays the captured claude-agent-acp stream of three shells and a duplicate end marker as two cycles that end unknown", async () => {
    const capture = JSON.parse(readFileSync(new URL("../../test-support/claude-acp-overlapping-notifications.json", import.meta.url), "utf8")) as
      Array<{ direction: "inbound" | "outbound"; message: { id?: number; result?: unknown; params?: { sessionId?: string } } }>;
    const session = capture.find(({ message }) => message.params?.sessionId)!.message.params!.sessionId!;
    const cycles = new ClaudeProviderCycles({ sessionId: () => session, promptActive: () => false }).subscribe();
    const seen: Seen = { started: 0, ended: [] };
    void (async () => {
      for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
        if (item.type === "started") {
          seen.started += 1;
          cycles.adopt(() => false);
        }
        if (item.type === "ended") seen.ended.push(cycles.backgroundTasks());
      }
    })();
    let atPromptEnd: ClaudeBackgroundTaskState | null = null;
    for (const { direction, message } of capture) {
      cycles.observe(direction, message);
      if (direction === "inbound" && message.id === 3 && message.result) atPromptEnd = cycles.backgroundTasks();
    }
    expect(atPromptEnd).toEqual({ live: 3 });
    while (seen.ended.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual({ started: 2, ended: [null, null] });
  });

  it("makes the background state unknown when a cycle is dropped", async () => {
    const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
    cycles.observe("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air } } });
    cycles.observe("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air } });
    cycles.observe("inbound", spawned("task-1"));
    cycles.observe("inbound", spawned("task-2"));
    cycles.observe("inbound", finished("task-1"));
    cycles.observe("inbound", usage());
    expect(cycles.backgroundTasks()).toEqual({ live: 1 });
    expect(await cycles.next()).toMatchObject({ type: "started" });
    cycles.drop();
    expect(cycles.backgroundTasks()).toBeNull();
    expect(await cycles.next()).toBeNull();
  });
});
