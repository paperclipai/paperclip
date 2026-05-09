import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  collectText,
  findError,
  findSessionId,
  parseQwenStreamBuffer,
  parseQwenStreamLine,
} from "./parse.js";

describe("parseQwenStreamLine", () => {
  it("parses text deltas from {delta} and {text} shapes", () => {
    expect(parseQwenStreamLine(JSON.stringify({ type: "content_delta", text: "hello " }))).toEqual({
      kind: "text_delta",
      text: "hello ",
    });
    expect(parseQwenStreamLine(JSON.stringify({ delta: "world" }))).toEqual({
      kind: "text_delta",
      text: "world",
    });
  });

  it("parses session announcements from session/system events", () => {
    expect(parseQwenStreamLine(JSON.stringify({ type: "session_start", session_id: "abc" }))).toEqual({
      kind: "session",
      sessionId: "abc",
    });
    expect(parseQwenStreamLine(JSON.stringify({ type: "system", session: { id: "xyz" } }))).toEqual({
      kind: "session",
      sessionId: "xyz",
    });
  });

  it("parses usage rollups under both top-level and message scopes", () => {
    const top = parseQwenStreamLine(
      JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 20 } }),
    );
    expect(top).toEqual({ kind: "usage", usage: { inputTokens: 10, outputTokens: 20 } });

    const nested = parseQwenStreamLine(
      JSON.stringify({ type: "message", message: { usage: { prompt_tokens: 3, completion_tokens: 5 } } }),
    );
    expect(nested).toEqual({ kind: "usage", usage: { inputTokens: 3, outputTokens: 5 } });
  });

  it("classifies tool calls + results", () => {
    expect(parseQwenStreamLine(JSON.stringify({ type: "tool_use", name: "edit_file" }))).toMatchObject({
      kind: "tool_call",
      name: "edit_file",
    });
    expect(parseQwenStreamLine(JSON.stringify({ type: "tool_result" }))).toMatchObject({
      kind: "tool_result",
    });
  });

  it("error events always win", () => {
    expect(parseQwenStreamLine(JSON.stringify({ type: "error", message: "boom" }))).toMatchObject({
      kind: "error",
      message: "boom",
    });
    // error field on a normally-typed event is also surfaced as error
    expect(parseQwenStreamLine(JSON.stringify({ type: "result", error: { message: "nope" } }))).toMatchObject({
      kind: "error",
      message: "nope",
    });
  });

  it("falls back to unknown for unrecognized typed events", () => {
    const ev = parseQwenStreamLine(JSON.stringify({ type: "future_event_kind", foo: "bar" }));
    expect(ev?.kind).toBe("unknown");
    if (ev?.kind === "unknown") expect(ev.type).toBe("future_event_kind");
  });

  it("ignores blank and non-JSON lines", () => {
    expect(parseQwenStreamLine("")).toBeNull();
    expect(parseQwenStreamLine("   ")).toBeNull();
    expect(parseQwenStreamLine("not json {")).toBeNull();
  });
});

describe("parseQwenStreamBuffer", () => {
  it("emits one event per newline and preserves the trailing partial line", () => {
    const buf = `${JSON.stringify({ delta: "a" })}\n${JSON.stringify({ delta: "b" })}\n{"delta":"c"`;
    const { events, remainder } = parseQwenStreamBuffer(buf);
    expect(events.map((e) => (e.kind === "text_delta" ? e.text : null))).toEqual(["a", "b"]);
    expect(remainder).toBe('{"delta":"c"');
  });
});

describe("reducers", () => {
  const events = [
    { kind: "text_delta" as const, text: "Hello " },
    { kind: "text_delta" as const, text: "world" },
    { kind: "usage" as const, usage: { inputTokens: 5, outputTokens: 7 } },
    { kind: "usage" as const, usage: { inputTokens: 2, outputTokens: 3 } },
    { kind: "session" as const, sessionId: "sess_42" },
    { kind: "error" as const, message: "fatal", raw: {} },
  ];

  it("aggregateUsage sums per-turn rollups", () => {
    expect(aggregateUsage(events)).toEqual({ inputTokens: 7, outputTokens: 10 });
  });

  it("collectText concatenates deltas", () => {
    expect(collectText(events)).toBe("Hello world");
  });

  it("findSessionId / findError return first match", () => {
    expect(findSessionId(events)).toBe("sess_42");
    expect(findError(events)).toBe("fatal");
  });
});
