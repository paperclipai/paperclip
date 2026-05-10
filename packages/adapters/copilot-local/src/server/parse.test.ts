import { describe, expect, it } from "vitest";
import { isCopilotAuthRequiredError, parseCopilotJsonl } from "./parse.js";

describe("copilot JSONL parser", () => {
  it("parses JSONL messages, session id, and usage", () => {
    const parsed = parseCopilotJsonl([
      JSON.stringify({ type: "session", session_id: "session-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "Hello" }),
      JSON.stringify({ type: "result", text: "Done", usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 5 } }),
    ].join("\n"));

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.summary).toBe("Hello\n\nDone");
    expect(parsed.usage).toEqual({
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 5,
    });
  });

  it("parses auth-required errors", () => {
    const parsed = parseCopilotJsonl(JSON.stringify({
      type: "error",
      message: "Authentication required. Run copilot login.",
    }));

    expect(parsed.errorMessage).toBe("Authentication required. Run copilot login.");
    expect(isCopilotAuthRequiredError({ errorMessage: parsed.errorMessage })).toBe(true);
  });
});
