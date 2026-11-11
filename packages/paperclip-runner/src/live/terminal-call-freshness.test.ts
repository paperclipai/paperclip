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
    expect(settled).toEqual({ unseen: ["write_document"], pending: [] });
  });

  it("reports a call still pending after the bound", async () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), block];
    const settled = await settleEarlierToolCalls(() => ({ events, commands: [] }),
      { terminalSourceEventId: block.sourceEventId }, { timeoutMs: 20, pollMs: 5 });
    expect(settled).toEqual({ unseen: [], pending: ["write_document"] });
    const outcome = staleTerminalCallResult("paperclip_block", settled!.unseen, settled!.pending);
    expect(outcome).toMatchObject({ isError: true, result: { error: { code: "terminal_call_before_results", retryable: true } } });
    expect(outcome.result.error.message).toContain("has not returned yet");
  });

  it("does not wait when every earlier call was seen, and stops when the session is gone", async () => {
    const block = started("b", "paperclip_block");
    const events = [started("w", "write_document"), result("w"), completed("w", "write_document"), block];
    const startedAt = Date.now();
    expect(await settleEarlierToolCalls(() => ({ events, commands: [] }), { terminalSourceEventId: block.sourceEventId }))
      .toEqual({ unseen: [], pending: [] });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await settleEarlierToolCalls(() => null, {})).toBeNull();
  });
});
