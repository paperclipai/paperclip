import { describe, expect, it } from "vitest";
import { parseGeminiStdoutLine } from "./parse-stdout.js";

const ts = "2026-05-04T05:43:45.198Z";

describe("parseGeminiStdoutLine", () => {
  it("renders v0.38 message+role:assistant as an assistant transcript entry", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "hello.",
      delta: true,
    });
    const entries = parseGeminiStdoutLine(line, ts);
    expect(entries).toEqual([{ kind: "assistant", ts, text: "hello." }]);
  });

  it("renders v0.38 message+role:user as a user transcript entry", () => {
    const line = JSON.stringify({
      type: "message",
      role: "user",
      content: "Respond with hello.",
    });
    const entries = parseGeminiStdoutLine(line, ts);
    expect(entries).toEqual([{ kind: "user", ts, text: "Respond with hello." }]);
  });

  it("preserves the legacy claude-style assistant event handler", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "output_text", text: "legacy hello" }] },
    });
    const entries = parseGeminiStdoutLine(line, ts);
    expect(entries).toEqual([{ kind: "assistant", ts, text: "legacy hello" }]);
  });

  it("reads token usage from v0.38 result.stats", () => {
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: {
        total_tokens: 9468,
        input_tokens: 9095,
        output_tokens: 29,
        cached: 8132,
      },
    });
    const [entry] = parseGeminiStdoutLine(line, ts);
    expect(entry).toMatchObject({
      kind: "result",
      inputTokens: 9095,
      outputTokens: 29,
      cachedTokens: 8132,
      isError: false,
      subtype: "success",
    });
  });

  it("flags v0.38 result.status=error as an error", () => {
    const line = JSON.stringify({
      type: "result",
      status: "error",
      error: "boom",
    });
    const [entry] = parseGeminiStdoutLine(line, ts);
    expect(entry).toMatchObject({ kind: "result", isError: true, errors: ["boom"] });
  });

  it("ignores message events without an actionable role", () => {
    const line = JSON.stringify({ type: "message", role: "system", content: "ignored" });
    expect(parseGeminiStdoutLine(line, ts)).toEqual([]);
  });
});
