import { describe, expect, it } from "vitest";
import {
  describeClaudeFailure,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudeContextWindowError,
  detectStuckSession,
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

describe("isClaudeContextWindowError", () => {
  it("detects context window limit messages", () => {
    expect(
      isClaudeContextWindowError({ result: "This conversation reached its context window limit." }),
    ).toBe(true);
    expect(isClaudeContextWindowError({ result: "prompt is too long: context length exceeded" })).toBe(true);
    expect(isClaudeContextWindowError({ result: "input token limit reached" })).toBe(true);
  });

  it("ignores unrelated errors and missing input", () => {
    expect(isClaudeContextWindowError({ result: "No conversation found with session id s_1" })).toBe(false);
    expect(isClaudeContextWindowError(null)).toBe(false);
    expect(isClaudeContextWindowError(undefined)).toBe(false);
  });
});

describe("describeClaudeFailure", () => {
  it("describes failure with subtype and detail", () => {
    const result = describeClaudeFailure({
      subtype: "error",
      result: "Something failed",
    });
    expect(result).toBe("Claude run failed: subtype=error: Something failed");
  });

  it("handles missing detail", () => {
    const result = describeClaudeFailure({
      subtype: "error",
      result: "",
    });
    expect(result).toBe("Claude run failed: subtype=error");
  });

  it("uses errors array when result is empty", () => {
    const result = describeClaudeFailure({
      subtype: "error",
      result: "",
      errors: ["Error from API"],
    });
    expect(result).toBe("Claude run failed: subtype=error: Error from API");
  });
});

describe("detectStuckSession", () => {
  describe("Variant A - stop_sequence_synthetic", () => {
    it("detects stop_sequence with 0 output tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "stop_sequence",
          stop_sequence: null,
          content: [{ type: "text", text: "<synthetic>" }],
          usage: { output_tokens: 0 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(true);
      expect(result.variant).toBe("stop_sequence_synthetic");
    });

    it("does not trigger when stop_sequence has output tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Normal completion" }],
          usage: { output_tokens: 150 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("does not trigger when output_tokens is non-zero", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "stop_sequence",
          usage: { output_tokens: 10 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });
  });

  describe("Variant B - incomplete_tool_use", () => {
    it("detects null stop_reason with tool_use and near-zero tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          usage: { output_tokens: 3 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(true);
      expect(result.variant).toBe("incomplete_tool_use");
    });

    it("detects empty string stop_reason with tool_use and near-zero tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "",
          stop_sequence: "",
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          usage: { output_tokens: 5 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(true);
      expect(result.variant).toBe("incomplete_tool_use");
    });

    it("detects string 'null' stop_reason with tool_use and near-zero tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "null",
          stop_sequence: "null",
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          usage: { output_tokens: 2 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(true);
      expect(result.variant).toBe("incomplete_tool_use");
    });

    it("does not trigger when tool_use has meaningful output tokens", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          usage: { output_tokens: 100 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("does not trigger when stop_reason is present", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          usage: { output_tokens: 3 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("does not trigger when no tool_use content exists", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          content: [{ type: "text", text: "Some text" }],
          usage: { output_tokens: 3 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("handles malformed JSON", () => {
      const result = detectStuckSession("not valid json");
      expect(result.isStuck).toBe(false);
      expect(result.variant).toBe("unknown");
    });

    it("handles empty string", () => {
      const result = detectStuckSession("");
      expect(result.isStuck).toBe(false);
      expect(result.variant).toBe("unknown");
    });

    it("handles non-assistant event type", () => {
      const lastLine = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session_123",
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("handles assistant event with non-assistant role", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "user",
          content: [{ type: "text", text: "User message" }],
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("handles missing usage field (defaults to stuck - tool_use with null stop)", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
        },
      });
      const result = detectStuckSession(lastLine);
      // When usage is missing, output_tokens defaults to 0, and with tool_use + null stop, this is stuck
      expect(result.isStuck).toBe(true);
      expect(result.variant).toBe("incomplete_tool_use");
    });

    it("handles missing content array", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });
  });

  describe("Normal completion - not stuck", () => {
    it("recognizes normal end_turn completion", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Task completed" }],
          usage: { output_tokens: 150 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("recognizes max_turns completion", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "max_turns",
          content: [{ type: "text", text: "Reached max turns" }],
          usage: { output_tokens: 200 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });

    it("recognizes normal tool_use completion with result", () => {
      const lastLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Bash",
              input: { command: "echo hello" },
            },
            { type: "text", text: "Done" },
          ],
          usage: { output_tokens: 50 },
        },
      });
      const result = detectStuckSession(lastLine);
      expect(result.isStuck).toBe(false);
    });
  });
});
