import type { AcpRuntimeEvent } from "acpx/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_PROVIDER_TURN_PROCESS_LOST,
  CLAUDE_PROVIDER_TURN_SILENT,
  ClaudeProviderCycles,
  parseAcpxProviderTurnArming,
  type ClaudeProviderCycleSource,
  type ClaudeProviderTurnResult,
} from "./claude-provider-turns.js";

const SESSION = "session-1";
const update = (body: Record<string, unknown>, sessionId = SESSION) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
const endMarker = (usage: Record<string, unknown> = { input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }) =>
  update({ sessionUpdate: "usage_update", used: 9, size: 100, cost: { amount: 0.25, currency: "USD" }, _meta: { "_claude/origin": { kind: "task-notification", producer: "session-task" }, usage } });
const toolCall = (id: string) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "mcp__paperclip__probe", kind: "other", status: "pending", rawInput: { tag: id } });

type Adopted = { requestId: string; events: AcpRuntimeEvent[]; done: Promise<ClaudeProviderTurnResult>; settled: boolean };

function harness(overrides: Partial<ClaudeProviderCycleSource> = {}, adopt = true) {
  const adopted: Adopted[] = [];
  let promptActive = false;
  let busy = false;
  let next = 0;
  const cycles = new ClaudeProviderCycles({
    sessionId: () => SESSION,
    promptActive: () => promptActive,
    mintTurnId: () => `provider-${++next}`,
    ...overrides,
  }).subscribe();
  void (async () => {
    let settle: (result: ClaudeProviderTurnResult) => void = () => undefined;
    for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
      if (item.type === "started") {
        if (!adopt) {
          cycles.drop();
          continue;
        }
        cycles.adopt(() => busy);
        const entry: Adopted = { requestId: item.requestId, events: [], done: new Promise((resolve) => { settle = resolve; }), settled: false };
        adopted.push(entry);
      } else if (item.type === "event") {
        adopted.at(-1)!.events.push(item.event);
      } else if (item.type === "ended") {
        adopted.at(-1)!.settled = true;
        settle(item.result);
      }
    }
  })();
  return {
    cycles, adopted,
    setPrompt: (value: boolean) => { promptActive = value; },
    setBusy: (value: boolean) => { busy = value; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("Claude provider-started turns", () => {
  it("opens at the first idle cycle message and ends at the origin-tagged usage update with the cycle's usage", async () => {
    const { cycles, adopted } = harness();
    expect(cycles.observe("inbound", update({ sessionUpdate: "session_info_update", title: "A title" }))).toBe(false);
    expect(cycles.observe("inbound", update({ sessionUpdate: "available_commands_update", availableCommands: [] }))).toBe(false);
    expect(cycles.observe("inbound", update({ sessionUpdate: "async_task_state_update", asyncTaskId: "b1", state: "completed" }))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(adopted).toHaveLength(0);
    expect(cycles.observe("inbound", update({ sessionUpdate: "usage_update", used: 3, size: 100 }))).toBe(true);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(adopted[0]!.requestId).toBe("provider-1");
    expect(cycles.observe("inbound", toolCall("toolu_1"))).toBe(true);
    expect(cycles.observe("inbound", { jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "toolu_1" }, options: [] } })).toBe(true);
    expect(cycles.observe("inbound", update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }))).toBe(true);
    expect(cycles.observe("inbound", endMarker())).toBe(true);
    const result = await adopted[0]!.done;
    expect(result).toEqual({ status: "completed", stopReason: "end_turn", usage: { type: "status", tag: "usage_update", text: "terminal prompt usage",
      cost: { amount: 0.25, currency: "USD" },
      breakdown: { inputTokens: 6, outputTokens: 4, cachedReadTokens: 1, cachedWriteTokens: 2, thoughtTokens: undefined, totalTokens: undefined } } });
    expect(adopted[0]!.events.map(event => [event.type, (event as { tag?: unknown }).tag])).toEqual([
      ["status", "usage_update"], ["tool_call", "tool_call"], ["text_delta", "agent_message_chunk"], ["status", "usage_update"]]);
    expect(cycles.observe("inbound", update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_2", status: "pending" }))).toBe(true);
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
  });

  it("treats an end marker that arrives alone, as after a failed API call, as a whole turn", async () => {
    const { cycles, adopted } = harness();
    expect(cycles.observe("inbound", endMarker({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))).toBe(true);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(await adopted[0]!.done).toMatchObject({ status: "completed", usage: { breakdown: { inputTokens: 0, outputTokens: 0 } } });
  });

  it("never opens while a prompt or client request is in flight or for another session", async () => {
    const { cycles, adopted, setPrompt } = harness();
    setPrompt(true);
    expect(cycles.observe("inbound", toolCall("toolu_prompt"))).toBe(false);
    setPrompt(false);
    cycles.observe("outbound", { jsonrpc: "2.0", id: 7, method: "session/set_mode", params: {} });
    expect(cycles.observe("inbound", toolCall("toolu_pending"))).toBe(false);
    cycles.observe("inbound", { jsonrpc: "2.0", id: 7, result: {} });
    expect(cycles.observe("inbound", toolCall("toolu_other"), )).toBe(true);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(cycles.observe("inbound", update({ sessionUpdate: "tool_call", toolCallId: "x", title: "t" }, "child-session"))).toBe(false);
  });

  it("retires adoption when the turn is not admitted so the background state stays unknown", async () => {
    const { cycles } = harness({}, false);
    expect(cycles.observe("inbound", toolCall("toolu_1"))).toBe(true);
    await vi.waitFor(() => expect(cycles.retired).toBe(true));
    expect(cycles.observe("inbound", toolCall("toolu_2"))).toBe(false);
    expect(cycles.backgroundTasks()).toBeNull();
  });

  it("fails the turn when the provider exits and cancels it on request", async () => {
    const exited = harness();
    exited.cycles.observe("inbound", toolCall("toolu_1"));
    await vi.waitFor(() => expect(exited.adopted).toHaveLength(1));
    exited.cycles.lost();
    expect(await exited.adopted[0]!.done).toEqual({ status: "failed", error: { code: CLAUDE_PROVIDER_TURN_PROCESS_LOST,
      message: "The owned ACPX provider exited during Claude's own turn", retryable: false } });
    expect(exited.cycles.observe("inbound", toolCall("toolu_2"))).toBe(false);

    const cancelled = harness();
    expect(cancelled.cycles.cancel()).toBe(false);
    cancelled.cycles.observe("inbound", toolCall("toolu_1"));
    await vi.waitFor(() => expect(cancelled.adopted).toHaveLength(1));
    expect(cancelled.cycles.cancel()).toBe(true);
    expect(await cancelled.adopted[0]!.done).toEqual({ status: "cancelled", stopReason: "cancelled" });
  });

  it("fails a silent turn after the bound unless Paperclip still owns pending work", async () => {
    vi.useFakeTimers();
    const { cycles, adopted, setBusy } = harness({ silenceMs: 1_000 });
    cycles.observe("inbound", toolCall("toolu_1"));
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    setBusy(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(adopted[0]!.settled).toBe(false);
    setBusy(false);
    cycles.observe("inbound", update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed" }));
    while (adopted[0]!.events.length < 2) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(adopted[0]!.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await adopted[0]!.done).toMatchObject({ status: "failed", error: { code: CLAUDE_PROVIDER_TURN_SILENT } });
    expect(cycles.retired).toBe(true);
  });

  it("lets callbacks of a started cycle wait for the consumer's decision", async () => {
    const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
    expect(cycles.undecided()).toBeNull();
    cycles.observe("inbound", toolCall("toolu_1"));
    const first = cycles.undecided();
    expect(first).not.toBeNull();
    expect(await cycles.next()).toMatchObject({ type: "started" });
    cycles.adopt(() => false);
    expect(await first).toBe(true);
    expect(cycles.undecided()).toBeNull();
    cycles.observe("inbound", endMarker());
    cycles.observe("inbound", toolCall("toolu_2"));
    const second = cycles.undecided();
    for (let item = await cycles.next(); item?.type !== "started"; item = await cycles.next()) void item;
    cycles.drop();
    expect(await second).toBe(false);
    expect(cycles.undecided()).toBeNull();
  });

  it("binds a tool call or permission request to the decision of the cycle that sent it", async () => {
    const cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false }).subscribe();
    cycles.observe("inbound", toolCall("toolu_1"));
    cycles.observe("inbound", endMarker());
    cycles.observe("inbound", toolCall("toolu_2"));
    cycles.observe("inbound", { jsonrpc: "2.0", id: 3, method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "toolu_3" }, options: [] } });
    const first = cycles.decisionFor("toolu_1");
    const second = cycles.decisionFor("toolu_2");
    expect(cycles.decisionFor("toolu_3")).toBe(second);
    expect(cycles.decisionFor("toolu_unknown")).toBe(second);
    expect(second).not.toBe(first);
    let secondDecided = false;
    void second!.then(() => { secondDecided = true; });
    expect(await cycles.next()).toMatchObject({ type: "started" });
    cycles.adopt(() => false);
    expect(await first).toBe(true);
    for (let item = await cycles.next(); item?.type !== "started"; item = await cycles.next()) void item;
    expect(secondDecided).toBe(false);
    cycles.drop();
    expect(await second).toBe(false);
  });

  it("parses only the closed arming contract runnerd sends", () => {
    expect(parseAcpxProviderTurnArming({ turnId: "turn-1", armed: true })).toEqual({ turnId: "turn-1", armed: true });
    expect(parseAcpxProviderTurnArming({ armed: false, turnId: "provider-1" })).toEqual({ turnId: "provider-1", armed: false });
    for (const params of [{ turnId: "turn-1" }, { turnId: "turn-1", armed: "true" }, { turnId: "bad id", armed: true },
      { turnId: "turn-1", armed: true, extra: 1 }, { turnId: "x".repeat(241), armed: true }]) {
      expect(() => parseAcpxProviderTurnArming(params)).toThrow("bounded contract");
    }
  });

  it("keeps the next cycle's first messages when they arrive before the previous cycle has been consumed", async () => {
    const { cycles, adopted } = harness();
    cycles.observe("inbound", toolCall("toolu_1"));
    cycles.observe("inbound", endMarker());
    expect(cycles.observe("inbound", update({ sessionUpdate: "usage_update", used: 4, size: 100 }))).toBe(true);
    expect(cycles.observe("inbound", toolCall("toolu_2"))).toBe(true);
    await vi.waitFor(() => expect(adopted.length).toBeGreaterThan(0));
    expect(await adopted[0]!.done).toMatchObject({ status: "completed" });
    expect(adopted[0]!.events.map(event => (event as { toolCallId?: unknown }).toolCallId).filter(Boolean)).toEqual(["toolu_1"]);
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
    cycles.observe("inbound", endMarker());
    expect(await adopted[1]!.done).toMatchObject({ status: "completed" });
    expect(adopted[1]!.events.map(event => [event.type, (event as { tag?: unknown }).tag])).toEqual([
      ["status", "usage_update"], ["tool_call", "tool_call"], ["status", "usage_update"]]);
  });

  it("ignores a task report that arrives between cycles and does not count it as a declined cycle", async () => {
    const { cycles, adopted } = harness();
    const progress = update({ sessionUpdate: "async_task_progress", asyncTaskId: "task-2" });
    cycles.observe("inbound", toolCall("toolu_1"));
    cycles.observe("inbound", endMarker());
    expect(cycles.observe("inbound", progress)).toBe(false);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    expect(await adopted[0]!.done).toMatchObject({ status: "completed" });
    expect(cycles.retired).toBe(false);
    expect(cycles.observe("inbound", toolCall("toolu_2"))).toBe(true);
    expect(cycles.observe("inbound", progress)).toBe(true);
    cycles.observe("inbound", endMarker());
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
    expect(await adopted[1]!.done).toMatchObject({ status: "completed" });
    expect(cycles.retired).toBe(false);
  });
});
