import { describe, expect, it } from "vitest";
import { parseAgyStdoutLine } from "./parse-stdout.js";
import { buildAgyLocalConfig } from "./build-config.js";

describe("parseAgyStdoutLine", () => {
  it("maps init", () => {
    const out = parseAgyStdoutLine(JSON.stringify({ type: "init", conversation_id: "c1", init: { model: "m" } }), "t");
    expect(out[0]).toMatchObject({ kind: "init", model: "m", sessionId: "c1" });
  });

  it("maps a finished tool step to call + result", () => {
    const out = parseAgyStdoutLine(JSON.stringify({
      type: "step_update",
      step_update: { conversation_id: "c1", step_index: 2, state: "DONE", step_type: "tool", tool_info: { name: "ls", parameters: { p: 1 }, output: "ok" } },
    }), "t");
    expect(out.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
  });

  it("maps result to assistant + result", () => {
    const out = parseAgyStdoutLine(JSON.stringify({
      type: "result",
      result: { status: "SUCCESS", response: "hi", usage: { input_tokens: 3, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 4 } },
    }), "t");
    expect(out.map((e) => e.kind)).toEqual(["assistant", "result"]);
    expect(out[1]).toMatchObject({ inputTokens: 3, outputTokens: 3, cachedTokens: 4, isError: false });
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
