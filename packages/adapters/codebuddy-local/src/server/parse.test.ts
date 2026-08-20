import { describe, expect, it } from "vitest";
import {
  detectCodeBuddyLoginRequired,
  isCodeBuddyUnknownSessionError,
  parseCodeBuddyStreamJson,
} from "./parse.js";

describe("parseCodeBuddyStreamJson", () => {
  it("reads session metadata, assistant text, usage, and cost from stream-json", () => {
    const parsed = parseCodeBuddyStreamJson(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
          model: "gemini-2.5-pro",
        }),
        JSON.stringify({
          type: "assistant",
          session_id: "sess-1",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
        JSON.stringify({
          type: "result",
          session_id: "sess-1",
          result: "hello",
          total_cost_usd: 0.12,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
        }),
      ].join("\n"),
    );

    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.model).toBe("gemini-2.5-pro");
    expect(parsed.summary).toBe("hello");
    expect(parsed.costUsd).toBe(0.12);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});

describe("detectCodeBuddyLoginRequired", () => {
  it("detects authentication prompts", () => {
    expect(
      detectCodeBuddyLoginRequired({
        stdout: "",
        stderr: "Authentication required. Please use /login to sign in to CodeBuddy.",
      }).requiresLogin,
    ).toBe(true);
    expect(detectCodeBuddyLoginRequired({ stdout: "ok", stderr: "" }).requiresLogin).toBe(false);
  });
});

describe("isCodeBuddyUnknownSessionError", () => {
  it("detects stale resume failures", () => {
    expect(
      isCodeBuddyUnknownSessionError({
        result: "no conversation found with session id sess-1",
      }),
    ).toBe(true);
    expect(isCodeBuddyUnknownSessionError({ result: "ok" })).toBe(false);
  });
});
