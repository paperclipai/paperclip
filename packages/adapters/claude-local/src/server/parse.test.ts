import { describe, expect, it } from "vitest";
import {
  describeClaudeFailure,
  extractClaudeRetryNotBefore,
  isClaudeSuccessfulResult,
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

describe("isClaudeSuccessfulResult", () => {
  it("recognizes subtype=success with is_error=false as success", () => {
    expect(
      isClaudeSuccessfulResult({
        subtype: "success",
        is_error: false,
        result: "Done. Issue reassigned to GM.",
      }),
    ).toBe(true);
  });

  it("recognizes subtype=success without an explicit is_error field as success", () => {
    expect(isClaudeSuccessfulResult({ subtype: "success", result: "ok" })).toBe(true);
  });

  it("does not classify subtype=success with is_error=true as success", () => {
    expect(isClaudeSuccessfulResult({ subtype: "success", is_error: true })).toBe(false);
  });

  it("does not classify error subtypes as success", () => {
    expect(isClaudeSuccessfulResult({ subtype: "error_max_turns" })).toBe(false);
    expect(isClaudeSuccessfulResult({ subtype: "error_during_execution" })).toBe(false);
  });

  it("does not classify a missing parsed result as success", () => {
    expect(isClaudeSuccessfulResult(null)).toBe(false);
    expect(isClaudeSuccessfulResult(undefined)).toBe(false);
    expect(isClaudeSuccessfulResult({})).toBe(false);
  });
});

describe("describeClaudeFailure", () => {
  it("returns null when the parsed result indicates a successful Claude run", () => {
    // Reproduces ZDA-2909: a successful audit was being recorded as
    // 'Claude run failed: subtype=success: <result>' because the host process
    // exited non-zero after `terminalResultCleanup` killed the CLI.
    expect(
      describeClaudeFailure({
        subtype: "success",
        is_error: false,
        result: "PP3 Audit — ZDA-2876: ✅ PASS",
      }),
    ).toBeNull();
  });

  it("describes a real failure when subtype is an error and is_error=true", () => {
    const message = describeClaudeFailure({
      subtype: "error_max_turns",
      is_error: true,
      result: "Maximum turns reached.",
    });
    expect(message).toBe("Claude run failed: subtype=error_max_turns: Maximum turns reached.");
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
