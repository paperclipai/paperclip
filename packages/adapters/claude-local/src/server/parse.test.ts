import { describe, expect, it } from "vitest";
import {
  extractClaudeHardLimitBlock,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("does NOT classify hard-limit 'out of extra usage' as transient (it is provider_rate_limit)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(false);
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

  it("does NOT classify 5-hour / weekly limit wording as transient (it is provider_rate_limit)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(false);
  });

  it("does NOT classify the live CLI wording 'You've hit your limit · resets 8pm' as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your limit · resets 8pm (Europe/Berlin)",
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          api_error_status: 429,
          result: "You've hit your limit · resets 8pm (Europe/Berlin)",
        },
      }),
    ).toBe(false);
  });

  it("does NOT classify a stream carrying a rejected rate_limit_event as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        rateLimitInfo: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1778004000 },
      }),
    ).toBe(false);
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

describe("extractClaudeHardLimitBlock", () => {
  it("returns null for transient errors", () => {
    expect(extractClaudeHardLimitBlock({ stderr: "HTTP 429: Too Many Requests" })).toBeNull();
    expect(extractClaudeHardLimitBlock({ parsed: { is_error: true, errors: [{ type: "overloaded_error" }] } })).toBeNull();
  });

  it("classifies 5-hour limit as five_hour with no modelFamily", () => {
    const block = extractClaudeHardLimitBlock({ errorMessage: "5-hour limit reached." });
    expect(block?.limitKind).toBe("five_hour");
    expect(block?.modelFamily).toBeNull();
  });

  it("classifies weekly limit as seven_day with no modelFamily", () => {
    const block = extractClaudeHardLimitBlock({
      errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
    });
    expect(block?.limitKind).toBe("seven_day");
    expect(block?.modelFamily).toBeNull();
  });

  it("classifies opus weekly limit as seven_day_opus with claude-opus modelFamily", () => {
    const block = extractClaudeHardLimitBlock({ errorMessage: "Opus weekly limit reached." });
    expect(block?.limitKind).toBe("seven_day_opus");
    expect(block?.modelFamily).toBe("claude-opus");
  });

  it("classifies extra_usage hits and includes resetsAt when present", () => {
    const block = extractClaudeHardLimitBlock({
      errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
    });
    expect(block?.limitKind).toBe("extra_usage");
    expect(block?.resetsAt).not.toBeNull();
  });

  it("classifies the live CLI wording 'You've hit your limit · resets 8pm (Europe/Berlin)' as five_hour", () => {
    const now = new Date("2026-05-05T17:58:37.000Z");
    const block = extractClaudeHardLimitBlock(
      { errorMessage: "You've hit your limit · resets 8pm (Europe/Berlin)" },
      now,
    );
    expect(block?.limitKind).toBe("five_hour");
    expect(block?.modelFamily).toBeNull();
    expect(block?.resetsAt).toBe("2026-05-05T18:00:00.000Z");
  });

  it("prefers structured rate_limit_info over text matching", () => {
    const block = extractClaudeHardLimitBlock({
      rateLimitInfo: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1778004000,
      },
      errorMessage: "Some unrelated message that would not match the regex.",
    });
    expect(block?.limitKind).toBe("five_hour");
    expect(block?.modelFamily).toBeNull();
    expect(block?.resetsAt).toBe("2026-05-05T18:00:00.000Z");
  });

  it("maps structured seven_day_opus to claude-opus modelFamily", () => {
    const block = extractClaudeHardLimitBlock({
      rateLimitInfo: {
        status: "rejected",
        rateLimitType: "seven_day_opus",
        resetsAt: 1778004000,
      },
    });
    expect(block?.limitKind).toBe("seven_day_opus");
    expect(block?.modelFamily).toBe("claude-opus");
  });

  it("ignores rate_limit_info when status is allowed (not rejected)", () => {
    expect(
      extractClaudeHardLimitBlock({
        rateLimitInfo: {
          status: "allow",
          rateLimitType: "five_hour",
          resetsAt: 1778004000,
        },
      }),
    ).toBeNull();
  });
});

describe("parseClaudeStreamJson rate_limit_event extraction", () => {
  it("captures rate_limit_info from a rejected rate_limit_event in the JSONL stream", () => {
    const stream = [
      '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4-6"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1778004000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"session_id":"sess-1"}',
      '{"type":"assistant","message":{"id":"m1","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You\'ve hit your limit · resets 8pm (Europe/Berlin)"}]},"session_id":"sess-1","error":"rate_limit"}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"duration_ms":475,"result":"You\'ve hit your limit · resets 8pm (Europe/Berlin)","stop_reason":"stop_sequence","session_id":"sess-1","total_cost_usd":0}',
    ].join("\n");
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.rateLimitInfo).toEqual({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1778004000,
    });
  });

  it("returns null rateLimitInfo when no rate_limit_event is present", () => {
    const stream = [
      '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4-6"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1"}',
    ].join("\n");
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.rateLimitInfo).toBeNull();
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
