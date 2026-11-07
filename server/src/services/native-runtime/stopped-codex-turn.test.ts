import { describe, expect, it } from "vitest";
import { stoppedCodexTurnIsTextOnly } from "./stopped-codex-turn.js";
const meta = { type: "session_meta", payload: { id: "thread", cwd: "/workspace" } };
const start = { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } };
const context = { type: "turn_context", payload: { turn_id: "turn", cwd: "/workspace" } };
const answer = { type: "response_item", payload: { type: "message", role: "assistant" } };
const stop = { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn", reason: "interrupted" } };
const check = (rows: unknown[]) => stoppedCodexTurnIsTextOnly({ rows, threadId: "thread", turnId: "turn", cwd: "/workspace" });
describe("stopped Codex turn inventory", () => {
  it("accepts an exactly bound, closed text-only turn", () => {
    expect(check([meta, start, context, answer, stop])).toBe(true);
  });
  it("does not treat partial output or an unrelated abort as containment", () => {
    expect(check([meta, start, context, answer])).toBe(false);
    expect(check([meta, start, context, { ...stop, payload: { ...stop.payload, turn_id: "other" } }])).toBe(false);
  });
  it.each(["function_call", "custom_tool_call", "web_search_call", "unknown_future_action"])("refuses unverified %s outcomes", type => {
    expect(check([meta, start, context, { type: "response_item", payload: { type } }, stop])).toBe(false);
  });
  it("refuses later work, duplicate starts, and changed session identity", () => {
    expect(check([meta, start, context, stop, answer])).toBe(false);
    expect(check([meta, start, context, start, stop])).toBe(false);
    expect(check([{ ...meta, payload: { ...meta.payload, id: "other" } }, start, context, stop])).toBe(false);
  });
  it("does not replay completed actions in earlier turns", () => {
    expect(check([meta, { type: "response_item", payload: { type: "custom_tool_call" } }, start, context, answer, stop])).toBe(true);
  });
  const completed = { callId: "finish-id", input: { summary: "ready" } };
  const completionRows = (source: string) => [meta, start, context,
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "script", input: source } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "turn",
      item: { type: "DynamicToolCall", tool: "paperclip_finish", id: completed.callId, arguments: completed.input, status: "completed", success: true } } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "script", output: [] } }, answer, stop];
  const checkCompletion = (source: string, calls = [completed]) => stoppedCodexTurnIsTextOnly({
    rows: completionRows(source), threadId: "thread", turnId: "turn", cwd: "/workspace", completedTaskControlCalls: calls,
  });
  it("preserves completion bookkeeping with an exact accepted receipt", () => {
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "ready"}); text(r);')).toBe(true);
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "ready"}); text(r);', [])).toBe(false);
    expect(checkCompletion('const r = await tools.paperclip_finish({summary: "different"}); text(r);')).toBe(false);
  });
  it.each([
    'await tools.send_email({}); const r = await tools.paperclip_finish({summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: tools.write_file()}); text(r);',
    'const r = await tools.paperclip_finish({get summary() { return "ready"; }}); text(r);',
    'const r = await tools.paperclip_finish({...external, summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: `ready`}); text(r);',
    'const r = await tools["paperclip_finish"]({summary: "ready"}); text(r);',
    'const r = await tools.paperclip_finish({summary: "ready"}); tools.send_email(r);',
    'const r = await tools.paperclip_finish({__proto__: {summary: "ready"}}); text(r);',
  ])("refuses unverified execution hidden in completion code %s", source => {
    expect(checkCompletion(source)).toBe(false);
  });
});
