import { describe, expect, it } from "vitest";
import {
  extractClaudeQuotaResetAt,
  extractClaudeRetryNotBefore,
  isClaudeQuotaExhaustedError,
  isClaudeTransientUpstreamError,
} from "./parse.js";

describe("isClaudeQuotaExhaustedError", () => {
  it("classifies the 'out of extra usage' subscription window failure as quota-exhausted", () => {
    expect(
      isClaudeQuotaExhaustedError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeQuotaExhaustedError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour, weekly, monthly, and session limit wording", () => {
    expect(
      isClaudeQuotaExhaustedError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(isClaudeQuotaExhaustedError({ errorMessage: "5-hour limit reached." })).toBe(true);
    expect(isClaudeQuotaExhaustedError({ errorMessage: "Monthly limit reached." })).toBe(true);
    expect(isClaudeQuotaExhaustedError({ errorMessage: "Session limit reached." })).toBe(true);
    expect(isClaudeQuotaExhaustedError({ errorMessage: "Usage limit exceeded." })).toBe(true);
    expect(isClaudeQuotaExhaustedError({ errorMessage: "Billing limit reached." })).toBe(true);
  });

  it("does not classify per-minute rate-limit or 5xx errors as quota-exhausted", () => {
    expect(
      isClaudeQuotaExhaustedError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(false);
    expect(isClaudeQuotaExhaustedError({ stderr: "HTTP 429: Too Many Requests" })).toBe(false);
    expect(isClaudeQuotaExhaustedError({ stderr: "Bedrock ThrottlingException: slow down" })).toBe(
      false,
    );
    expect(isClaudeQuotaExhaustedError({ stderr: "service unavailable" })).toBe(false);
  });

  it("does not classify login/auth failures or deterministic errors as quota-exhausted", () => {
    expect(
      isClaudeQuotaExhaustedError({ stderr: "Please log in. Run `claude login` first." }),
    ).toBe(false);
    expect(
      isClaudeQuotaExhaustedError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeQuotaExhaustedError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("does NOT classify quota signals as transient (ADR-001 split — quota gets its own classifier)", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(false);
    expect(isClaudeTransientUpstreamError({ errorMessage: "5-hour limit reached." })).toBe(false);
    expect(isClaudeTransientUpstreamError({ errorMessage: "Monthly limit reached." })).toBe(false);
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

describe("extractClaudeQuotaResetAt", () => {
  it("prefers the wall-clock 'resets HH:MMam' hint when available", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeQuotaResetAt(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("falls back to x-ratelimit-reset header (epoch seconds) when no wall-clock hint", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    // epoch seconds for 2026-04-22T16:00:00Z
    const epochSec = Math.floor(Date.UTC(2026, 3, 22, 16, 0, 0) / 1000);
    const extracted = extractClaudeQuotaResetAt(
      { stderr: `usage limit exceeded\nx-ratelimit-reset: ${epochSec}` },
      now,
    );
    expect(extracted.toISOString()).toBe("2026-04-22T16:00:00.000Z");
  });

  it("parses ISO-8601 x-ratelimit-reset header values", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeQuotaResetAt(
      { stderr: "billing limit reached\nx-ratelimit-reset: 2026-04-22T17:30:00Z" },
      now,
    );
    expect(extracted.toISOString()).toBe("2026-04-22T17:30:00.000Z");
  });

  it("falls back to now+60min when no parseable reset info is present", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeQuotaResetAt({ errorMessage: "Monthly limit reached." }, now);
    expect(extracted.getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });
});
