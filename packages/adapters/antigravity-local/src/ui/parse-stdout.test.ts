// Unit tests for Antigravity UI parse-stdout

import { describe, expect, it } from "vitest";
import { parseAntigravityStdoutLine } from "./parse-stdout.js";

describe("parseAntigravityStdoutLine", () => {
  const ts = "2026-09-06T12:00:00.000Z";

  it("parses init event", () => {
    const line = JSON.stringify({
      event: "init",
      conversation_id: "conv-1",
      model: "gemini-3.8-flash-high",
    });
    const entries = parseAntigravityStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "init",
      ts,
      model: "gemini-3.8-flash-high",
      sessionId: "conv-1",
    });
  });

  it("parses step_update agent_response delta", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_type: "agent_response",
        text_delta: "working on it...",
      },
    });
    const entries = parseAntigravityStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "assistant",
      ts,
      text: "working on it...",
    });
  });

  it("parses result event with usage", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Finished!",
        usage: {
          input_tokens: 150,
          output_tokens: 45,
          cache_read_tokens: 20,
        },
      },
    });
    const entries = parseAntigravityStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "result",
      ts,
      text: "Finished!",
      inputTokens: 150,
      outputTokens: 45,
      cachedTokens: 20,
      isError: false,
    });
  });

  it("passes raw non-JSON text through as stdout entry", () => {
    const raw = "plain debug log";
    const entries = parseAntigravityStdoutLine(raw, ts);
    expect(entries).toEqual([{ kind: "stdout", ts, text: raw }]);
  });
});
