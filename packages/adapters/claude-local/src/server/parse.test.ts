import { describe, expect, it } from "vitest";
import {
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeQuotaExhausted,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
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

  it("does not let app-level auth text override a Claude usage-limit result", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You're out of extra usage · resets 12:10am (UTC)",
    };
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "The Paperclip API returned 401 (Agent authentication required).",
          },
        ],
      },
    });

    expect(detectClaudeLoginRequired({ parsed, stdout, stderr: "" }).requiresLogin).toBe(false);
    expect(isClaudeTransientUpstreamError({ parsed, stdout })).toBe(true);
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

describe("detectClaudeLoginRequired", () => {
  // Real-world failure mode 2026-05-08: claude CLI emits
  //   {type:"result", subtype:"success", is_error:false,
  //    result:"Failed to authenticate. API Error: 401 Invalid authentication credentials"}
  // when the OAuth refresh failed during init. The original auth regex only
  // matched the friendly "Not logged in · Please run /login" form and missed
  // this 401-style result. Without classification as auth-required, the
  // ccrotate-aware retry at execute.ts:898 never fires and the agent loops on
  // a stale active account until manual intervention.
  it("matches 'Failed to authenticate' API-error result text", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("matches the legacy 'Not logged in · Please run /login' form", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Not logged in · Please run /login",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("matches generic 'authentication failed' against Claude/Anthropic context", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Anthropic API error: authentication failed.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("does not flag random text containing 'authentication'", () => {
    // Plain "authentication required" without a Claude/Anthropic/oauth
    // context word should still be treated as out-of-context noise (e.g. an
    // Paperclip-side auth message bubbling through stdout).
    const parsed = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ResearchTool: authentication required for upstream service.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(false);
  });
});

describe("quota / transient classifier overlap", () => {
  // Both classifiers match quota-style messages — callers must check
  // isClaudeQuotaExhausted first so quota gets routed to the rotation hook
  // instead of the transient retry schedule.
  const overlappingQuotaMessages = [
    "You're out of extra usage · resets 4pm (America/Chicago)",
    "Claude usage limit reached. Resets at 2am (Europe/Warsaw).",
    "Usage limit reached.",
    "5-hour limit reached",
    "5 hour limit reached. Resets at 4pm.",
    "Weekly limit reached. Resets Monday.",
    "Usage cap reached.",
  ];

  for (const msg of overlappingQuotaMessages) {
    it(`both classifiers match ${JSON.stringify(msg)} — quota must be checked first`, () => {
      const parsed = { is_error: true, result: msg };
      expect(isClaudeQuotaExhausted(parsed)).toBe(true);
      expect(isClaudeTransientUpstreamError({ parsed })).toBe(true);
    });
  }

  it("does not classify generic transient errors (e.g. 503) as quota", () => {
    expect(
      isClaudeQuotaExhausted({ is_error: true, result: "Service unavailable (503). Try again later." }),
    ).toBe(false);
    expect(
      isClaudeQuotaExhausted({ is_error: true, errors: [{ type: "overloaded_error" }] }),
    ).toBe(false);
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
