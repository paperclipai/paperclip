import { describe, expect, it } from "vitest";
import { parseZaiStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-23T10:00:00.000Z";

describe("parseZaiStdoutLine", () => {
  it("renders assistant_delta events as streaming assistant entries", () => {
    const line = '[zai:event] {"kind":"assistant_delta","text":"hi"}';
    const entries = parseZaiStdoutLine(line, TS);
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "hi", delta: true }]);
  });

  it("renders tool_call events as tool_call entries", () => {
    const line = '[zai:event] {"kind":"tool_call","id":"call_1","name":"lookup","input":{"id":"abc"}}';
    const entries = parseZaiStdoutLine(line, TS);
    expect(entries).toEqual([
      { kind: "tool_call", ts: TS, name: "lookup", input: { id: "abc" }, toolUseId: "call_1" },
    ]);
  });

  it("renders usage events as result entries", () => {
    const line = '[zai:event] {"kind":"usage","inputTokens":10,"outputTokens":2,"cachedTokens":5}';
    const entries = parseZaiStdoutLine(line, TS);
    expect(entries[0]).toMatchObject({
      kind: "result",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 5,
      subtype: "usage",
    });
  });

  it("renders model event as init", () => {
    const line = '[zai:event] {"kind":"model","model":"glm-4.6","sessionId":"c1"}';
    const entries = parseZaiStdoutLine(line, TS);
    expect(entries).toEqual([{ kind: "init", ts: TS, model: "glm-4.6", sessionId: "c1" }]);
  });

  it("renders system lines for non-event [zai] prefix", () => {
    const entries = parseZaiStdoutLine("[zai] request glm-4.6", TS);
    expect(entries).toEqual([{ kind: "system", ts: TS, text: "request glm-4.6" }]);
  });

  it("ignores malformed events", () => {
    expect(parseZaiStdoutLine("[zai:event] not-json", TS)).toEqual([]);
    expect(parseZaiStdoutLine("[zai:event] {}", TS)).toEqual([]);
  });

  it("passes through unrelated stdout as stdout entry", () => {
    const entries = parseZaiStdoutLine("random line", TS);
    expect(entries).toEqual([{ kind: "stdout", ts: TS, text: "random line" }]);
  });
});
