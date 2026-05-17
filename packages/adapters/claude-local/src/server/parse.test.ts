import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeCorruptionError,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
} from "./parse.js";

const incidentFixture = fs.readFileSync(
  new URL("./__fixtures__/session-corruption-error.txt", import.meta.url),
  "utf8",
).trim();

describe("isClaudeCorruptionError", () => {
  it("detects corruption when both tool_use_id and tool_result appear in result", () => {
    const parsed = {
      subtype: "error",
      result: "tool_result: [tool_use_id: toolu_xxx] content",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });

  it("detects corruption when tool_use_id and tool_result appear in errors array", () => {
    const parsed = {
      subtype: "error",
      result: "",
      errors: [
        { message: "tool_result for tool_use_id toolu_abc must be preceded by a tool_use" },
      ],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });

  it("does not match when only tool_use_id appears", () => {
    const parsed = {
      subtype: "error",
      result: "unknown tool_use_id: toolu_xxx",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match when only tool_result appears", () => {
    const parsed = {
      subtype: "error",
      result: "invalid tool_result format",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match unknown session errors", () => {
    const parsed = {
      subtype: "error",
      result: "no conversation found with session id abc123",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("does not match generic errors", () => {
    const parsed = {
      subtype: "error",
      result: "internal server error",
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(false);
  });

  it("detects corruption with ENOSPC incident signature", () => {
    const parsed = {
      subtype: "error",
      result: incidentFixture,
      errors: [],
    };
    expect(isClaudeCorruptionError(parsed)).toBe(true);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects unknown session in result text", () => {
    const parsed = {
      subtype: "error",
      result: "no conversation found with session id abc123",
      errors: [],
    };
    expect(isClaudeUnknownSessionError(parsed)).toBe(true);
  });

  it("does not match corruption errors", () => {
    const parsed = {
      subtype: "error",
      result: "tool_result for tool_use_id must be preceded by tool_use",
      errors: [],
    };
    // This string contains both tool_use_id and tool_result, so
    // isClaudeCorruptionError would be true. This test verifies the
    // unknown-session detector doesn't false-positive on corruption.
    expect(isClaudeUnknownSessionError(parsed)).toBe(false);
  });
});

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
