import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeThinkingBlocksModifiedError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("isClaudeThinkingBlocksModifiedError", () => {
  it("detects the canonical Anthropic API 400 thinking-block error", () => {
    expect(
      isClaudeThinkingBlocksModifiedError({
        is_error: true,
        result:
          "API Error: 400 messages.3.content.4: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
      }),
    ).toBe(true);
  });

  it("detects redacted_thinking variant", () => {
    expect(
      isClaudeThinkingBlocksModifiedError({
        is_error: true,
        errors: [
          {
            message:
              "redacted_thinking blocks in the latest assistant message cannot be modified.",
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeThinkingBlocksModifiedError({
        is_error: true,
        result: "API Error: 400 Invalid request: unknown parameter 'foo'.",
      }),
    ).toBe(false);
    expect(isClaudeThinkingBlocksModifiedError(null)).toBe(false);
    expect(isClaudeThinkingBlocksModifiedError(undefined)).toBe(false);
  });
});

describe("parseClaudeStreamJson — hasThinkingBlocks", () => {
  function makeAssistantEvent(contentBlocks: Record<string, unknown>[]) {
    return JSON.stringify({
      type: "assistant",
      session_id: "sess-1",
      message: { content: contentBlocks },
    });
  }

  const resultLine = JSON.stringify({
    type: "result",
    session_id: "sess-1",
    result: "done",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    total_cost_usd: 0.001,
  });

  it("sets hasThinkingBlocks when a thinking block is present", () => {
    const stdout = [
      makeAssistantEvent([
        { type: "thinking", thinking: "internal reasoning..." },
        { type: "text", text: "Hello" },
      ]),
      resultLine,
    ].join("\n");
    expect(parseClaudeStreamJson(stdout).hasThinkingBlocks).toBe(true);
  });

  it("sets hasThinkingBlocks when a redacted_thinking block is present", () => {
    const stdout = [
      makeAssistantEvent([
        { type: "redacted_thinking", data: "encrypted..." },
      ]),
      resultLine,
    ].join("\n");
    expect(parseClaudeStreamJson(stdout).hasThinkingBlocks).toBe(true);
  });

  it("leaves hasThinkingBlocks false when only text blocks are present", () => {
    const stdout = [
      makeAssistantEvent([{ type: "text", text: "Hello" }]),
      resultLine,
    ].join("\n");
    expect(parseClaudeStreamJson(stdout).hasThinkingBlocks).toBe(false);
  });

  it("leaves hasThinkingBlocks false on empty output", () => {
    expect(parseClaudeStreamJson("").hasThinkingBlocks).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
