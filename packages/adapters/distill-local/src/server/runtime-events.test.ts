import { describe, expect, it } from "vitest";
import { createRuntimeEventExtractor } from "./parse.js";

// Paperclip only shows what the agent is doing when the adapter emits these events.
describe("createRuntimeEventExtractor", () => {
  it("turns a tool call into an event even when the line is split across chunks", () => {
    const x = createRuntimeEventExtractor();
    const line = JSON.stringify({ type: "tool_call", toolName: "run_terminal_command", rawInput: {} });
    expect(x.push(line.slice(0, 20))).toEqual([]);
    expect(x.push(`${line.slice(20)}\n`)).toEqual([
      { eventType: "tool_call", payload: { toolName: "run_terminal_command" } },
    ]);
  });

  it("throttles streamed text deltas and flushes the rest, so the status shows the latest words", () => {
    let t = 10_000;
    const x = createRuntimeEventExtractor({ now: () => t });
    const delta = (data: string) => `${JSON.stringify({ type: "thought", data })}\n`;
    expect(x.push(delta("Checking ") + delta("the tests"))).toEqual([
      { eventType: "thinking", message: "Checking", payload: { text: "Checking" } },
    ]);
    t += 500;
    expect(x.push(delta(" now"))).toEqual([]);
    expect(x.flush()).toEqual([
      { eventType: "thinking", message: "the tests now", payload: { text: "the tests now" } },
    ]);
  });

  it("ignores bookkeeping events and non-JSON lines", () => {
    const x = createRuntimeEventExtractor();
    expect(x.push('{"type":"usage"}\n{"type":"available_commands"}\nnot json\n')).toEqual([]);
  });
});
