import type { AcpRuntimeEvent } from "acpx/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_PROVIDER_TURN_PROCESS_LOST,
  CLAUDE_PROVIDER_TURN_SILENT,
  ClaudeProviderTurns,
  parseAcpxProviderTurnArming,
  type ClaudeProviderTurn,
  type ClaudeProviderTurnHooks,
} from "./claude-provider-turns.js";

const SESSION = "session-1";
const update = (body: Record<string, unknown>, sessionId = SESSION) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
const endMarker = (usage: Record<string, unknown> = { input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }) =>
  update({ sessionUpdate: "usage_update", used: 9, size: 100, cost: { amount: 0.25, currency: "USD" }, _meta: { "_claude/origin": { kind: "task-notification", producer: "session-task" }, usage } });
const toolCall = (id: string) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "mcp__paperclip__probe", kind: "other", status: "pending", rawInput: { tag: id } });

function harness(overrides: Partial<ClaudeProviderTurnHooks> = {}) {
  const adopted: Array<{ turn: ClaudeProviderTurn; events: AcpRuntimeEvent[]; done: Promise<unknown> }> = [];
  const released: string[] = [];
  let promptActive = false;
  let busy = false;
  let next = 0;
  const turns = new ClaudeProviderTurns({
    sessionId: () => SESSION,
    promptActive: () => promptActive,
    mintTurnId: () => `provider-${++next}`,
    admit: (turn) => {
      const events: AcpRuntimeEvent[] = [];
      const done = (async () => { for await (const event of turn.events) events.push(event); return await turn.result; })();
      adopted.push({ turn, events, done });
      return { busy: () => busy, release: () => released.push(turn.requestId) };
    },
    ...overrides,
  });
  return {
    turns, adopted, released,
    setPrompt: (value: boolean) => { promptActive = value; },
    setBusy: (value: boolean) => { busy = value; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("Claude provider-started turns", () => {
  it("opens at the first idle cycle message and ends at the origin-tagged usage update with the cycle's usage", async () => {
    const { turns, adopted, released } = harness();
    expect(turns.observe("inbound", update({ sessionUpdate: "session_info_update", title: "A title" }))).toBe(false);
    expect(turns.observe("inbound", update({ sessionUpdate: "available_commands_update", availableCommands: [] }))).toBe(false);
    expect(turns.observe("inbound", update({ sessionUpdate: "async_task_state_update", asyncTaskId: "b1", state: "completed" }))).toBe(false);
    expect(adopted).toHaveLength(0);
    expect(turns.observe("inbound", update({ sessionUpdate: "usage_update", used: 3, size: 100 }))).toBe(true);
    expect(adopted).toHaveLength(1);
    expect(turns.activeTurnId).toBe("provider-1");
    expect(turns.observe("inbound", toolCall("toolu_1"))).toBe(true);
    expect(turns.observe("inbound", { jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "toolu_1" }, options: [] } })).toBe(true);
    expect(turns.observe("inbound", update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }))).toBe(true);
    expect(turns.observe("inbound", endMarker())).toBe(true);
    const result = await adopted[0]!.done;
    expect(result).toEqual({ status: "completed", stopReason: "end_turn", usage: { type: "status", tag: "usage_update", text: "terminal prompt usage",
      cost: { amount: 0.25, currency: "USD" },
      breakdown: { inputTokens: 6, outputTokens: 4, cachedReadTokens: 1, cachedWriteTokens: 2, thoughtTokens: undefined, totalTokens: undefined } } });
    expect(adopted[0]!.events.map(event => [event.type, (event as { tag?: unknown }).tag])).toEqual([
      ["status", "usage_update"], ["tool_call", "tool_call"], ["text_delta", "agent_message_chunk"], ["status", "usage_update"]]);
    expect(released).toEqual(["provider-1"]);
    expect(turns.activeTurnId).toBeNull();
    expect(turns.observe("inbound", update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_2", status: "pending" }))).toBe(true);
    expect(adopted).toHaveLength(2);
  });

  it("treats an end marker that arrives alone, as after a failed API call, as a whole turn", async () => {
    const { turns, adopted } = harness();
    expect(turns.observe("inbound", endMarker({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))).toBe(true);
    expect(await adopted[0]!.done).toMatchObject({ status: "completed", usage: { breakdown: { inputTokens: 0, outputTokens: 0 } } });
  });

  it("never opens while a prompt or client request is in flight or for another session", () => {
    const { turns, adopted, setPrompt } = harness();
    setPrompt(true);
    expect(turns.observe("inbound", toolCall("toolu_prompt"))).toBe(false);
    setPrompt(false);
    turns.observe("outbound", { jsonrpc: "2.0", id: 7, method: "session/set_mode", params: {} });
    expect(turns.observe("inbound", toolCall("toolu_pending"))).toBe(false);
    turns.observe("inbound", { jsonrpc: "2.0", id: 7, result: {} });
    expect(turns.observe("inbound", toolCall("toolu_other"), )).toBe(true);
    expect(adopted).toHaveLength(1);
    expect(turns.observe("inbound", update({ sessionUpdate: "tool_call", toolCallId: "x", title: "t" }, "child-session"))).toBe(false);
  });

  it("retires adoption when the turn is not admitted so the background state stays unknown", () => {
    const { turns } = harness({ admit: () => null });
    expect(turns.observe("inbound", toolCall("toolu_1"))).toBe(false);
    expect(turns.retired).toBe(true);
    expect(turns.observe("inbound", toolCall("toolu_2"))).toBe(false);
  });

  it("fails the turn when the provider exits and cancels it on request", async () => {
    const exited = harness();
    exited.turns.observe("inbound", toolCall("toolu_1"));
    exited.turns.fail(CLAUDE_PROVIDER_TURN_PROCESS_LOST, "provider exited");
    expect(await exited.adopted[0]!.done).toEqual({ status: "failed", error: { code: CLAUDE_PROVIDER_TURN_PROCESS_LOST, message: "provider exited", retryable: false } });
    expect(exited.turns.observe("inbound", toolCall("toolu_2"))).toBe(false);

    const cancelled = harness();
    expect(cancelled.turns.cancel()).toBe(false);
    cancelled.turns.observe("inbound", toolCall("toolu_1"));
    expect(cancelled.turns.cancel()).toBe(true);
    expect(await cancelled.adopted[0]!.done).toEqual({ status: "cancelled", stopReason: "cancelled" });
    expect(cancelled.released).toEqual(["provider-1"]);
  });

  it("fails a silent turn after the bound unless Paperclip still owns pending work", async () => {
    vi.useFakeTimers();
    const { turns, adopted, setBusy } = harness({ silenceMs: 1_000 });
    turns.observe("inbound", toolCall("toolu_1"));
    setBusy(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(turns.activeTurnId).toBe("provider-1");
    setBusy(false);
    turns.observe("inbound", update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed" }));
    await vi.advanceTimersByTimeAsync(999);
    expect(turns.activeTurnId).toBe("provider-1");
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await adopted[0]!.done).toMatchObject({ status: "failed", error: { code: CLAUDE_PROVIDER_TURN_SILENT } });
    expect(turns.retired).toBe(true);
  });

  it("parses only the closed arming contract runnerd sends", () => {
    expect(parseAcpxProviderTurnArming({ turnId: "turn-1", armed: true })).toEqual({ turnId: "turn-1", armed: true });
    expect(parseAcpxProviderTurnArming({ armed: false, turnId: "provider-1" })).toEqual({ turnId: "provider-1", armed: false });
    for (const params of [{ turnId: "turn-1" }, { turnId: "turn-1", armed: "true" }, { turnId: "bad id", armed: true },
      { turnId: "turn-1", armed: true, extra: 1 }, { turnId: "x".repeat(241), armed: true }]) {
      expect(() => parseAcpxProviderTurnArming(params)).toThrow("bounded contract");
    }
  });

  it("keeps the next cycle's first messages when they arrive before the previous cycle has drained", async () => {
    const { turns, adopted } = harness();
    turns.observe("inbound", toolCall("toolu_1"));
    turns.observe("inbound", endMarker());
    expect(turns.observe("inbound", update({ sessionUpdate: "usage_update", used: 4, size: 100 }))).toBe(true);
    expect(turns.observe("inbound", toolCall("toolu_2"))).toBe(true);
    expect(await adopted[0]!.done).toMatchObject({ status: "completed" });
    expect(adopted[0]!.events.map(event => (event as { toolCallId?: unknown }).toolCallId).filter(Boolean)).toEqual(["toolu_1"]);
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
    turns.observe("inbound", endMarker());
    expect(await adopted[1]!.done).toMatchObject({ status: "completed" });
    expect(adopted[1]!.events.map(event => [event.type, (event as { tag?: unknown }).tag])).toEqual([
      ["status", "usage_update"], ["tool_call", "tool_call"], ["status", "usage_update"]]);
  });

  it("ignores a task report that arrives while a cycle drains and does not count it as a declined cycle", async () => {
    const unadopted = vi.fn();
    const { turns, adopted } = harness({ unadopted });
    const progress = update({ sessionUpdate: "async_task_progress", asyncTaskId: "task-2" });
    turns.observe("inbound", toolCall("toolu_1"));
    turns.observe("inbound", endMarker());
    expect(turns.observe("inbound", progress)).toBe(false);
    expect(await adopted[0]!.done).toMatchObject({ status: "completed" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unadopted).not.toHaveBeenCalled();
    expect(turns.observe("inbound", toolCall("toolu_2"))).toBe(true);
    expect(turns.observe("inbound", progress)).toBe(true);
    turns.observe("inbound", endMarker());
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
    expect(await adopted[1]!.done).toMatchObject({ status: "completed" });
    expect(unadopted).not.toHaveBeenCalled();
  });
});
