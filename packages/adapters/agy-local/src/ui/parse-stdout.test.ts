import { describe, expect, it } from "vitest";
import { createAgyStdoutParser, parseAgyStdoutLine } from "./parse-stdout.js";
import { buildAgyLocalConfig } from "./build-config.js";
import { AGY_CONVERSATION_ID, AGY_INIT_LINE, AGY_RESULT_LINE, AGY_TOOL_DONE_LINE } from "../test-fixtures.js";

describe("parseAgyStdoutLine", () => {
  it("maps init", () => {
    const out = parseAgyStdoutLine(AGY_INIT_LINE, "t");
    expect(out[0]).toMatchObject({ kind: "init", model: "gemini-3.8-flash-low", sessionId: AGY_CONVERSATION_ID });
  });

  it("maps a finished tool step to call + result", () => {
    const out = parseAgyStdoutLine(AGY_TOOL_DONE_LINE, "t");
    expect(out.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
  });

  it("maps result to assistant + result", () => {
    const out = parseAgyStdoutLine(AGY_RESULT_LINE, "t");
    expect(out.map((e) => e.kind)).toEqual(["assistant", "result"]);
    expect(out[1]).toMatchObject({ inputTokens: 3, outputTokens: 3, cachedTokens: 4, isError: false });
  });

  it("streams reply deltas and does not repeat them in the final result", () => {
    const delta = (text: string) => JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: AGY_CONVERSATION_ID, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: text },
    });
    const parse = createAgyStdoutParser();
    expect(parse.parseLine(delta("hel"), "t")).toEqual([{ kind: "assistant", ts: "t", text: "hel", delta: true }]);
    expect(parse.parseLine(delta("lo"), "t")).toEqual([{ kind: "assistant", ts: "t", text: "lo", delta: true }]);
    expect(parse.parseLine(AGY_RESULT_LINE, "t").map((e) => e.kind)).toEqual(["result"]);
    // A new transcript build never saw those deltas, so it still shows the final response.
    expect(createAgyStdoutParser().parseLine(AGY_RESULT_LINE, "t").map((e) => e.kind)).toEqual(["assistant", "result"]);
    expect(parseAgyStdoutLine(AGY_RESULT_LINE, "t").map((e) => e.kind)).toEqual(["assistant", "result"]);
  });

  it("passes non-JSON through as stdout", () => {
    expect(parseAgyStdoutLine("plain", "t")).toEqual([{ kind: "stdout", ts: "t", text: "plain" }]);
  });
});

describe("buildAgyLocalConfig", () => {
  it("defaults the model and grace", () => {
    expect(buildAgyLocalConfig({ model: "", envVars: "", envBindings: {} } as never)).toMatchObject({ model: "gemini-3.8-flash-medium", graceSec: 20 });
  });
});
