import { describe, expect, it } from "vitest";
import {
  CLAUDE_USAGE_FORMULA_VERSION,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
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

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
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

describe("parseClaudeStreamJson telemetry", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-telemetry",
    model: "claude-opus-4-8",
  });

  const assistantLine = (
    content: Array<Record<string, unknown>>,
    usage: Record<string, number>,
  ) =>
    JSON.stringify({
      type: "assistant",
      session_id: "sess-telemetry",
      message: { role: "assistant", content, usage },
    });

  const textBlock = (text: string) => ({ type: "text", text });
  const toolBlock = (name: string) => ({ type: "tool_use", id: `tool-${name}`, name, input: {} });

  it("derives turn, tool-call, tool-less, ratio, and resident-window fields from the stream", () => {
    // 4 assistant turns; turns 1 and 3 are text-only (tool-less), turns 2 and 4
    // call tools (2 + 1 = 3 tool calls). Per-turn resident window is
    // input + cache_creation + cache_read; the peak is turn 3 at 160001.
    const stdout = [
      initLine,
      assistantLine([textBlock("thinking out loud")], {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 100,
      }),
      assistantLine([textBlock("reading"), toolBlock("Read"), toolBlock("Grep")], {
        input_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50000,
      }),
      assistantLine([textBlock("still narrating, no action")], {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 160000,
      }),
      assistantLine([toolBlock("Edit")], {
        input_tokens: 3,
        cache_creation_input_tokens: 800,
        cache_read_input_tokens: 120000,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-telemetry",
        result: "done",
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 16,
          cache_read_input_tokens: 330100,
          output_tokens: 900,
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);

    expect(parsed.telemetry).toEqual({
      turnCount: 4,
      toolCallCount: 3,
      toolLessTurnCount: 2,
      toolLessTurnRatio: 0.5,
      residentWindowTokens: 160001,
      usageFormulaVersion: CLAUDE_USAGE_FORMULA_VERSION,
    });

    // Existing usage/session semantics are preserved alongside telemetry.
    expect(parsed.usage).toEqual({
      inputTokens: 16,
      cachedInputTokens: 330100,
      outputTokens: 900,
    });
    expect(parsed.costUsd).toBe(0.42);
    expect(parsed.sessionId).toBe("sess-telemetry");
    expect(parsed.model).toBe("claude-opus-4-8");
  });

  it("reports telemetry for a result-less (timed-out mid-stream) run while usage stays null", () => {
    const stdout = [
      initLine,
      assistantLine([toolBlock("Read")], {
        input_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40000,
      }),
      assistantLine([textBlock("narrating without acting")], {
        input_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80000,
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);

    expect(parsed.usage).toBeNull();
    expect(parsed.resultJson).toBeNull();
    expect(parsed.telemetry).toEqual({
      turnCount: 2,
      toolCallCount: 1,
      toolLessTurnCount: 1,
      toolLessTurnRatio: 0.5,
      residentWindowTokens: 80002,
      usageFormulaVersion: CLAUDE_USAGE_FORMULA_VERSION,
    });
  });

  it("defaults ratio and resident window to zero when there are no assistant turns", () => {
    const parsed = parseClaudeStreamJson("");

    expect(parsed.telemetry).toEqual({
      turnCount: 0,
      toolCallCount: 0,
      toolLessTurnCount: 0,
      toolLessTurnRatio: 0,
      residentWindowTokens: 0,
      usageFormulaVersion: CLAUDE_USAGE_FORMULA_VERSION,
    });
  });
});
