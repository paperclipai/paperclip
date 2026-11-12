import { describe, expect, it } from "vitest";
import { isTerminalOperation, pendingEarlierToolCalls, settleEarlierToolCalls, staleTerminalCallResult, unseenReturnedToolCalls } from "./terminal-call-freshness.js";

let seq = 0;
const event = (eventType: string, payload: Record<string, unknown>, turnId = "turn-1") => ({
  sourceEventId: `e${++seq}`, envelope: { payload: { eventType, turnId, payload } },
});
const started = (id: string, name: string, turnId?: string) =>
  event("tool.execution.started", { executionId: id, transport: "dynamic", name, status: "running" }, turnId);
const completed = (id: string, name: string) =>
  event("tool.execution.completed", { executionId: id, transport: "dynamic", name, status: "completed" });
const result = (id: string) => event("item.completed", { item: { type: "tool_result", id, tool_use_id: id, result: {} } });

describe("unseenReturnedToolCalls", () => {
  it("names a call that returned but that the agent had not seen when it decided (restart chaos t03)", () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), result("w"), block, completed("w", "write_document")];
    expect(unseenReturnedToolCalls(events, [], { terminalSourceEventId: block.sourceEventId, turnId: "turn-1" }))
      .toEqual(["write_document"]);
  });

  it("is empty once the agent saw the result before deciding", () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), result("w"), completed("w", "write_document"), block];
    expect(unseenReturnedToolCalls(events, [], { terminalSourceEventId: block.sourceEventId })).toEqual([]);
  });

  it("reports a call with no result yet as pending, not as returned", () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), block];
    expect(unseenReturnedToolCalls(events, [], { terminalSourceEventId: block.sourceEventId })).toEqual([]);
    expect(pendingEarlierToolCalls(events, [], { terminalSourceEventId: block.sourceEventId })).toEqual(["write_document"]);
  });

  it("ignores other turns, process tools and the terminal calls themselves", () => {
    const events = [
      started("old", "write_document", "turn-0"), result("old"),
      event("tool.execution.started", { executionId: "sh", transport: "process", name: "/bin/sh" }), result("sh"),
      started("f", "paperclip_finish"), result("f"),
    ];
    expect(unseenReturnedToolCalls(events, [], { turnId: "turn-1" })).toEqual([]);
  });
});

it("forgets calls of a provider turn lost on restore once a new turn starts (restart chaos K2 t110)", () => {
  const commands = [{ type: "semantic_tool.result", payload: { callId: "lost", operationId: "read_agent_instructions" } }];
  const finish = started("f", "paperclip_finish");
  const events = [
    event("turn.started", {}), started("lost", "read_agent_instructions"),
    event("turn.failed", { error: { code: "provider_turn_lost_on_restore" } }),
    event("turn.started", {}), started("r", "read_document"), result("r"), completed("r", "read_document"), finish,
  ];
  expect(unseenReturnedToolCalls(events, commands, { terminalSourceEventId: finish.sourceEventId, turnId: "turn-1" })).toEqual([]);
});

describe("a call whose result never reaches the agent (two staging Codex runs, 2026-11-11)", () => {
  const commands = [{ type: "semantic_tool.result", payload: { callId: "s", operationId: "paperclip_search_assigned_tools" } }];

  it("names the returned call once; a finish decided after that refusal is judged without it", async () => {
    const first = started("f1", "paperclip_finish");
    const second = started("f2", "paperclip_finish");
    const events = [
      event("turn.started", {}), started("s", "paperclip_search_assigned_tools"),
      started("r", "read_document"), result("r"), completed("r", "read_document"),
      first, completed("f1", "paperclip_finish"), second,
    ];
    const refused = await settleEarlierToolCalls(() => ({ events, commands }), { terminalSourceEventId: first.sourceEventId, turnId: "turn-1" });
    expect(refused).toEqual({ unseen: ["paperclip_search_assigned_tools"], unseenCallIds: ["s"], pending: [] });
    const refusals = new Map([["f1", refused!.unseenCallIds]]);
    expect(unseenReturnedToolCalls(events, commands, { terminalSourceEventId: second.sourceEventId, turnId: "turn-1" }))
      .toEqual(["paperclip_search_assigned_tools"]);
    expect(unseenReturnedToolCalls(events, commands, { terminalSourceEventId: second.sourceEventId, turnId: "turn-1", refusals }))
      .toEqual([]);
  });

  it("still refuses a terminal call queued before the agent received the refusal", () => {
    const second = started("f2", "paperclip_block");
    const events = [event("turn.started", {}), started("s", "paperclip_search_assigned_tools"), started("f1", "paperclip_finish"),
      second, completed("f1", "paperclip_finish")];
    expect(unseenReturnedToolCalls(events, commands, { terminalSourceEventId: second.sourceEventId, turnId: "turn-1",
      refusals: new Map([["f1", ["s"]]]) })).toEqual(["paperclip_search_assigned_tools"]);
  });

  it("still refuses for a write that was pending at the earlier refusal and returned unseen during the next wait", async () => {
    const second = started("f2", "paperclip_finish");
    const events = [event("turn.started", {}), started("w", "write_document"), started("f1", "paperclip_finish"),
      completed("f1", "paperclip_finish"), second];
    const writeCommands: { type: string; payload: Record<string, unknown> }[] = [];
    const first = await settleEarlierToolCalls(() => ({ events, commands: writeCommands }),
      { terminalSourceEventId: events[2]!.sourceEventId, turnId: "turn-1" }, { timeoutMs: 20, pollMs: 5 });
    expect(first).toMatchObject({ unseen: [], unseenCallIds: [], pending: ["write_document"] });
    const refusals = new Map([["f1", first!.unseenCallIds]]);
    setTimeout(() => writeCommands.push({ type: "semantic_tool.result", payload: { callId: "w", operationId: "write_document" } }), 20);
    const next = await settleEarlierToolCalls(() => ({ events, commands: writeCommands }),
      { terminalSourceEventId: second.sourceEventId, turnId: "turn-1", refusals }, { timeoutMs: 5_000, pollMs: 5 });
    expect(next).toEqual({ unseen: ["write_document"], unseenCallIds: ["w"], pending: [] });
  });
});

it("counts the controller's semantic_tool.result command as the returned result", () => {
  const block = started("b", "paperclip_block");
  const commands = [{ type: "semantic_tool.result", payload: { callId: "w", operationId: "write_document" } }];
  expect(unseenReturnedToolCalls([started("w", "write_document"), block], commands, { terminalSourceEventId: block.sourceEventId }))
    .toEqual(["write_document"]);
});

describe("staleTerminalCallResult", () => {
  it("is a retryable error that names the calls", () => {
    expect(isTerminalOperation("paperclip_block")).toBe(true);
    expect(isTerminalOperation("write_document")).toBe(false);
    const outcome = staleTerminalCallResult("paperclip_block", ["write_document"]);
    expect(outcome).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results", retryable: true } } });
    expect(outcome.result.error.message).toContain("write_document");
  });
});

describe("settleEarlierToolCalls", () => {
  it("waits for a held call that returns after the terminal call arrived (restart chaos t05)", async () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), block];
    const commands: { type: string; payload: Record<string, unknown> }[] = [];
    setTimeout(() => commands.push({ type: "semantic_tool.result", payload: { callId: "w", operationId: "write_document" } }), 30);
    const settled = await settleEarlierToolCalls(() => ({ events, commands }),
      { terminalSourceEventId: block.sourceEventId }, { timeoutMs: 5_000, pollMs: 5 });
    expect(settled).toEqual({ unseen: ["write_document"], unseenCallIds: ["w"], pending: [] });
  });

  it("reports a call still pending after the bound", async () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), block];
    const settled = await settleEarlierToolCalls(() => ({ events, commands: [] }),
      { terminalSourceEventId: block.sourceEventId }, { timeoutMs: 20, pollMs: 5 });
    expect(settled).toEqual({ unseen: [], unseenCallIds: [], pending: ["write_document"] });
    const outcome = staleTerminalCallResult("paperclip_block", settled!.unseen, settled!.pending);
    expect(outcome).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results", retryable: true } } });
    expect(outcome.result.error.message).toContain("has not returned yet");
  });

  it("does not wait when every earlier call was seen, and stops when the session is gone", async () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), result("w"), completed("w", "write_document"), block];
    const startedAt = Date.now();
    expect(await settleEarlierToolCalls(() => ({ events, commands: [] }), { terminalSourceEventId: block.sourceEventId }))
      .toEqual({ unseen: [], unseenCallIds: [], pending: [] });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await settleEarlierToolCalls(() => null, {})).toBeNull();
  });
});
