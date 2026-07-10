import { describe, expect, it } from "vitest";
import { AgentAnswerAccumulator } from "../src/agent-output.js";

describe("AgentAnswerAccumulator", () => {
  it("extracts only completed Codex assistant messages", () => {
    const accumulator = new AgentAnswerAccumulator();
    expect(accumulator.push("run started\n")).toEqual([]);
    expect(accumulator.push('{"type":"thread.started","thread_id":"thread-1"}\n')).toEqual([]);
    expect(accumulator.push(
      '{"type":"item.completed","item":{"id":"item-1","type":"command_execution","aggregated_output":"secret log"}}\n',
    )).toEqual([]);
    expect(accumulator.push(
      '{"type":"item.completed","item":{"id":"item-2","type":"agent_message","text":"ELIA-42 shipped."}}\n',
    )).toEqual(["ELIA-42 shipped."]);
  });

  it("handles JSON lines split across stream chunks", () => {
    const accumulator = new AgentAnswerAccumulator();
    expect(accumulator.push('{"type":"item.completed","item":{"type":"agent_')).toEqual([]);
    expect(accumulator.push('message","text":"Grounded answer"}}\n')).toEqual(["Grounded answer"]);
    expect(accumulator.finish()).toEqual([]);
  });

  it("flushes a final line without a newline", () => {
    const accumulator = new AgentAnswerAccumulator();
    accumulator.push('{"type":"item.completed","item":{"type":"agent_message","text":"Final answer"}}');
    expect(accumulator.finish()).toEqual(["Final answer"]);
  });
});
