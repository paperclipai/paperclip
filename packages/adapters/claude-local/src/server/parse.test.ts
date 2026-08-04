import { describe, expect, it } from "vitest";
import {
  claudeModelUsageTotals,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
  readClaudeRateLimitRejection,
} from "./parse.js";

// A stream-json run refused by the account-level seven-day usage window. The CLI
// reports the refusal three ways in one stream — the structured rate_limit_event,
// the synthetic assistant message, and the result event — and this fixture keeps
// all three so the classifier is exercised against the shape it really sees.
// `resetsAt` 1785866400 is 2026-08-04T18:00:00Z, i.e. 7pm Europe/London.
const WEEKLY_LIMIT_STDOUT = [
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785866400,"rateLimitType":"seven_day","overageStatus":"allowed","isUsingOverage":false},"uuid":"a1","session_id":"s1"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1785866400,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"a2","session_id":"s1"}',
  '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit · resets 7pm (Europe/London)"}]},"session_id":"s1","error":"rate_limit","is_api_error_message":true}',
  '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"result":"You\'ve hit your weekly limit · resets 7pm (Europe/London)","total_cost_usd":0,"session_id":"s1"}',
].join("\n");

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeModelNotFoundError", () => {
  it("detects model resolution failures from structured and fallback output", () => {
    expect(isClaudeModelNotFoundError({
      parsed: {
        result: "API Error: 404 model not found: claude-haiku-4-6",
      },
    })).toBe(true);
    expect(isClaudeModelNotFoundError({
      stderr: "Unknown model claude-haiku-4-6",
    })).toBe(true);
  });

  it("does not classify unrelated provider failures as model resolution errors", () => {
    expect(isClaudeModelNotFoundError({
      errorMessage: "API Error: 503 service unavailable",
    })).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
  });

  it("classifies Claude session-limit windows as provider quota and extracts the retry time", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
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

  it("classifies the subscription 5-hour / weekly limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
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

  it("prefers the structured rate_limit_event reset over the wall-clock prose", () => {
    const now = new Date("2026-08-04T11:15:16.000Z");
    expect(
      extractClaudeRetryNotBefore({ stdout: WEEKLY_LIMIT_STDOUT }, now)?.toISOString(),
    ).toBe("2026-08-04T18:00:00.000Z");
  });

  it("falls back to the prose reset when the structured reset is already past", () => {
    // A stale resetsAt must not park the retry in the past; the prose clock
    // rolls forward to the next occurrence instead.
    const now = new Date("2026-08-05T11:15:16.000Z");
    expect(
      extractClaudeRetryNotBefore({ stdout: WEEKLY_LIMIT_STDOUT }, now)?.toISOString(),
    ).toBe("2026-08-05T18:00:00.000Z");
  });
});

describe("readClaudeRateLimitRejection", () => {
  it("reads the rejected account window and its exact reset epoch", () => {
    expect(readClaudeRateLimitRejection({ stdout: WEEKLY_LIMIT_STDOUT })).toEqual({
      resetsAt: new Date("2026-08-04T18:00:00.000Z"),
      rateLimitType: "seven_day",
    });
  });

  it("ignores allowed rate-limit events emitted during healthy runs", () => {
    const stdout =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785866400,"rateLimitType":"seven_day"},"uuid":"a1"}';
    expect(readClaudeRateLimitRejection({ stdout })).toBeNull();
  });

  it("returns null when the stream carries no rate-limit event", () => {
    expect(readClaudeRateLimitRejection({ stdout: '{"type":"result","subtype":"success"}' })).toBeNull();
  });
});

describe("claude subscription window classification (weekly-limit regression)", () => {
  // Regression: "You've hit your weekly limit" matched neither the quota nor the
  // reset wording, so the run was tagged claude_transient_upstream with no
  // retryNotBefore and replayed on the short bounded backoff for the entire
  // length of the window — every replay refused, every one costing a run.
  const errorMessage = "You've hit your weekly limit · resets 7pm (Europe/London)";

  it("classifies the weekly-limit wording as provider quota, not transient upstream", () => {
    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
  });

  it("classifies the 5-hour-limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({ errorMessage: "You've hit your 5-hour limit · resets 3pm (Europe/London)" }),
    ).toBe(true);
  });

  it("extracts the reset time from the weekly-limit prose alone", () => {
    const now = new Date("2026-08-04T11:15:16.000Z");
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-08-04T18:00:00.000Z",
    );
  });

  it("classifies the real refused stream as quota even though it also looks like a 429", () => {
    // The raw stream contains `"error":"rate_limit"` and `api_error_status: 429`,
    // which is what previously won the classification race.
    expect(isClaudeProviderQuotaError({ stdout: WEEKLY_LIMIT_STDOUT })).toBe(true);
    expect(isClaudeTransientUpstreamError({ stdout: WEEKLY_LIMIT_STDOUT })).toBe(false);
  });

  it("still treats a plain overload as transient rather than quota", () => {
    expect(isClaudeProviderQuotaError({ stderr: "HTTP 529: overloaded_error" })).toBe(false);
    expect(isClaudeTransientUpstreamError({ stderr: "HTTP 529: overloaded_error" })).toBe(true);
  });
});

describe("claudeModelUsageTotals", () => {
  it("sums per-model usage across models and counts cache writes as input", () => {
    const totals = claudeModelUsageTotals({
      "claude-fable-5": {
        inputTokens: 100,
        outputTokens: 70_000,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 4_000,
        costUSD: 1.2,
      },
      "claude-haiku-4-5": {
        inputTokens: 50,
        outputTokens: 7_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 500,
        costUSD: 0.05,
      },
    });
    expect(totals).toEqual({
      inputTokens: 4_650,
      outputTokens: 77_000,
      cachedInputTokens: 260_000,
    });
  });

  it("returns null for missing or empty modelUsage", () => {
    expect(claudeModelUsageTotals(undefined)).toBeNull();
    expect(claudeModelUsageTotals({})).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  const resultEvent = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 1_800, cache_read_input_tokens: 20 },
      ...extra,
    });

  it("prefers modelUsage totals over the main-loop usage block and marks them per-run", () => {
    const parsed = parseClaudeStreamJson(
      `${resultEvent({
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 90,
            outputTokens: 77_000,
            cacheReadInputTokens: 300_000,
            cacheCreationInputTokens: 2_000,
          },
        },
      })}\n`,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 2_090,
      outputTokens: 77_000,
      cachedInputTokens: 300_000,
    });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(1.25);
  });

  it("falls back to the result usage block when modelUsage is absent", () => {
    const parsed = parseClaudeStreamJson(`${resultEvent({})}\n`);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1_800,
      cachedInputTokens: 20,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});
