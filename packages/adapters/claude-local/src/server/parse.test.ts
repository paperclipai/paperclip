import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeSeatRotationAccessError,
  isClaudeTransientUpstreamError,
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

describe("isClaudeSeatRotationAccessError", () => {
  it("classifies the seat-rotator 403 body as a seat-rotation access error", () => {
    expect(
      isClaudeSeatRotationAccessError({
        errorMessage: "API Error: 403 Your organization does not have access to Claude.",
      }),
    ).toBe(true);
    expect(
      isClaudeSeatRotationAccessError({
        parsed: {
          is_error: true,
          result:
            "Anthropic API Error: HTTP 403 — Your organization does not have access to Claude.",
        },
      }),
    ).toBe(true);
  });

  it("matches the shorter 'organization does not have access' phrasing in stderr", () => {
    expect(
      isClaudeSeatRotationAccessError({
        stderr: "Error from API: organization does not have access\n",
      }),
    ).toBe(true);
  });

  it("does not classify generic transient-upstream messages as seat-rotation errors", () => {
    expect(
      isClaudeSeatRotationAccessError({
        errorMessage: "Server overloaded (529). Try again later.",
      }),
    ).toBe(false);
    expect(
      isClaudeSeatRotationAccessError({
        errorMessage: "rate_limit_error: 429 Too Many Requests",
      }),
    ).toBe(false);
  });

  it("does not classify login-required errors as seat-rotation access errors", () => {
    expect(
      isClaudeSeatRotationAccessError({
        errorMessage: "Please run `claude login` to authenticate.",
      }),
    ).toBe(false);
  });

  it("ignores deterministic max-turns / unknown-session results", () => {
    expect(
      isClaudeSeatRotationAccessError({
        parsed: {
          is_error: true,
          subtype: "error_max_turns",
          result: "Reached max turns",
        },
      }),
    ).toBe(false);
  });
});
