import { describe, expect, it } from "vitest";
import { parseAgyStdoutLine } from "./parse-stdout.js";
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

  it("passes non-JSON through as stdout", () => {
    expect(parseAgyStdoutLine("plain", "t")).toEqual([{ kind: "stdout", ts: "t", text: "plain" }]);
  });
});

describe("buildAgyLocalConfig", () => {
  it("defaults the model and grace", () => {
    expect(buildAgyLocalConfig({ model: "", envVars: "", envBindings: {} } as never)).toMatchObject({ model: "gemini-3.8-flash-medium", graceSec: 20 });
  });
});
