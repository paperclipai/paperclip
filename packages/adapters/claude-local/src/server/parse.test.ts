import { describe, expect, it } from "vitest";
import {
  extractClaudeHardLimitBlock,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
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
