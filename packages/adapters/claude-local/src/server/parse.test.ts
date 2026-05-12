import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
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

  it("classifies the 'You've hit your limit' message variant as transient", () => {
    // Observed in claude CLI output 2026-05-12: assistant message text was
    // "You've hit your limit · resets 2pm (Asia/Shanghai)" — does not match
    // any of the legacy prefix variants, but should still be transient.
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your limit · resets 2pm (Asia/Shanghai)",
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

  it("extracts the reset time from the 'You've hit your limit' message variant", () => {
    // claude CLI 2026-05-12 message format. Without the new prefix in the
    // regex, this would return null and force a default-backoff retry storm.
    const now = new Date("2026-05-12T05:38:40.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your limit · resets 2pm (Asia/Shanghai)" },
      now,
    );
    // 2pm Asia/Shanghai = 06:00 UTC same day.
    expect(extracted?.toISOString()).toBe("2026-05-12T06:00:00.000Z");
  });

  it("prefers the structured rate_limit_event resetsAt over text regex", () => {
    // Future resetsAt — should be used directly even when no regex would match.
    const now = new Date("2026-05-12T05:38:40.000Z");
    const futureResetsAt = Math.floor(new Date("2026-05-12T06:00:00.000Z").getTime() / 1000);
    const extracted = extractClaudeRetryNotBefore(
      {
        errorMessage: "(no text reset hint here)",
        rateLimitResetAtUnix: futureResetsAt,
      },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-05-12T06:00:00.000Z");
  });

  it("falls through to regex when structured rateLimitResetAtUnix is in the past", () => {
    // Past resetsAt is treated as stale; regex path takes over.
    const now = new Date("2026-05-12T10:00:00.000Z");
    const pastResetsAt = Math.floor(new Date("2026-05-12T06:00:00.000Z").getTime() / 1000);
    const extracted = extractClaudeRetryNotBefore(
      {
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
        rateLimitResetAtUnix: pastResetsAt,
      },
      now,
    );
    // Regex path: 4pm America/Chicago = 21:00 UTC.
    expect(extracted?.toISOString()).toBe("2026-05-12T21:00:00.000Z");
  });
});

describe("parseClaudeStreamJson — rate_limit_event", () => {
  it("captures rate_limit_info.resetsAt as rateLimitResetAtUnix", () => {
    // Real shape observed in claude CLI stdout 2026-05-12 (SIM-1753 incident).
    const stdout = [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1778565600,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled_until",
          isUsingOverage: false,
        },
      }),
    ].join("\n");
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.rateLimitResetAtUnix).toBe(1778565600);
  });

  it("leaves rateLimitResetAtUnix null when no rate_limit_event is present", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc",
      result: "fine",
    });
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.rateLimitResetAtUnix).toBeNull();
  });
});
