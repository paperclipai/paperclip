import { describe, expect, it } from "vitest";
import { classifyClaudeTerminalSessionFailure } from "./acp.js";
import {
  CLAUDE_RATE_LIMIT_PER_MINUTE_RETRY_DELAY_MS,
  CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS,
  claudeRateLimitWindowRetryDelayMs,
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
} from "./parse.js";

const now = new Date("2026-11-09T10:00:00.000Z");
const GENERIC_TITLE = "ACP agent reported a terminal limit failure.";
const ENDPOINT = "example-endpoint";

const HOURLY = [
  `API Error: Request rejected (429) · User defined rate limit(s) exceeded for '${ENDPOINT}'. Tokens-per-hour (TPH) rate limit exceeded for default user`,
  `{"error_code":"REQUEST_LIMIT_EXCEEDED","message":"User defined rate limit(s) exceeded for '${ENDPOINT}'. Tokens-per-hour (TPH) rate limit exceeded for default user"}`,
  "User defined rate limit(s) exceeded for 'some.endpoint'.",
  "REQUEST_LIMIT_EXCEEDED",
];
const PER_MINUTE = [
  "REQUEST_LIMIT_EXCEEDED: Exceeded workspace output tokens per minute rate limit for databricks-claude-haiku-5-5. Please wait.",
  "API Error: Request rejected (429) · Exceeded workspace output tokens per minute rate limit for databricks-claude-haiku-5-5",
];
const minutes = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe("Databricks rate-limit window classification", () => {
  it.each(HOURLY)("retries an hourly window after the long delay: %s", (details) => {
    expect(classifyClaudeTerminalSessionFailure({ category: "limit", title: GENERIC_TITLE, details }, now)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: minutes(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS),
      rateLimitWindow: true,
    });
  });

  it.each(PER_MINUTE)("retries a per-minute window after the short delay: %s", (details) => {
    expect(classifyClaudeTerminalSessionFailure({ category: "limit", title: GENERIC_TITLE, details }, now)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: minutes(CLAUDE_RATE_LIMIT_PER_MINUTE_RETRY_DELAY_MS),
      rateLimitWindow: true,
    });
  });

  it("waits a quarter of an hour for the hourly window and less for the per-minute one", () => {
    expect(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS).toBe(15 * 60_000);
    expect(CLAUDE_RATE_LIMIT_PER_MINUTE_RETRY_DELAY_MS).toBeLessThan(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS);
  });

  it("finds the wording in the title as well as the details", () => {
    expect(classifyClaudeTerminalSessionFailure({ category: "limit", title: HOURLY[0] }, now)).toMatchObject({
      rateLimitWindow: true,
    });
  });

  it("classifies the same wording from the legacy CLI surface", () => {
    const input = { parsed: null, stdout: "", stderr: "", errorMessage: HOURLY[0] };
    expect(isClaudeProviderQuotaError(input)).toBe(true);
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    expect(claudeRateLimitWindowRetryDelayMs(input)).toBe(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS);
    expect(extractClaudeRetryNotBefore(input, now)?.toISOString()).toBe(minutes(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS));
  });

  it("reads the failure's own message and parsed result, never the run's output", () => {
    for (const output of [HOURLY[0], HOURLY[1], PER_MINUTE[0]]) {
      const input = { parsed: null, stdout: output, stderr: output, errorMessage: "Claude exited with code 1" };
      expect(isClaudeProviderQuotaError(input)).toBe(false);
      expect(claudeRateLimitWindowRetryDelayMs(input)).toBeNull();
      expect(extractClaudeRetryNotBefore(input, now)).toBeNull();
    }
    const parsed = { type: "result", is_error: true, result: HOURLY[0] };
    expect(claudeRateLimitWindowRetryDelayMs({ parsed, stdout: "", stderr: "" })).toBe(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS);
  });

  it("waits for the window, not for a quota reset the run's output quotes", () => {
    const quoted = "You've hit your session limit · resets 4:30pm (America/Chicago)";
    for (const errorMessage of [HOURLY[0], PER_MINUTE[0]]) {
      const input = { parsed: null, stdout: quoted, stderr: quoted, errorMessage };
      const delayMs = claudeRateLimitWindowRetryDelayMs(input);
      expect(delayMs).not.toBeNull();
      expect(extractClaudeRetryNotBefore(input, now)?.toISOString()).toBe(minutes(delayMs!));
    }
    expect(extractClaudeRetryNotBefore({ errorMessage: quoted }, now)?.toISOString()).toBe("2026-11-09T22:30:00.000Z");
  });

  it("keeps an hourly wait when the output says per minute", () => {
    expect(claudeRateLimitWindowRetryDelayMs({
      errorMessage: HOURLY[0],
      stdout: "the agent printed: tokens per minute rate limit",
      stderr: "QPM TPM per-minute",
    })).toBe(CLAUDE_RATE_LIMIT_WINDOW_RETRY_DELAY_MS);
  });

  it("does not apply outside the limit category", () => {
    expect(classifyClaudeTerminalSessionFailure({ category: "request", title: GENERIC_TITLE, details: HOURLY[0] }, now)).toBeNull();
    expect(classifyClaudeTerminalSessionFailure({ category: "service", title: GENERIC_TITLE, details: HOURLY[0] }, now)).toBeNull();
  });
});

describe("failures the rate-limit window leaves alone", () => {
  it("keeps the reset time of a Claude subscription quota", () => {
    const title = "You've hit your session limit · resets 4:30pm (America/Chicago)";
    const classified = classifyClaudeTerminalSessionFailure({ category: "limit", title }, now);
    expect(classified).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-11-09T22:30:00.000Z",
    });
    expect(classified).not.toHaveProperty("rateLimitWindow");
  });

  it("does not mark a Claude quota that names no reset time", () => {
    const classified = classifyClaudeTerminalSessionFailure({ category: "limit", title: "The Claude account has no available quota." }, now);
    expect(classified).toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  });

  it("does not mix Claude quota wording into the window", () => {
    expect(claudeRateLimitWindowRetryDelayMs({
      errorMessage: `Usage limit reached. REQUEST_LIMIT_EXCEEDED for '${ENDPOINT}'`,
    })).toBeNull();
  });

  it.each([
    "API Error: Request rejected (429) · rate_limit_error",
    "This request would exceed the rate limit for your organization of 30,000 input tokens per minute. Please try again later.",
    "API Error: 429 Too Many Requests",
    "ACP agent reported a terminal limit failure.",
  ])("leaves an unrelated 429 to the generic retry: %s", (details) => {
    expect(classifyClaudeTerminalSessionFailure({ category: "limit", title: GENERIC_TITLE, details }, now)).toBeNull();
    const input = { errorMessage: details };
    expect(claudeRateLimitWindowRetryDelayMs(input)).toBeNull();
    expect(extractClaudeRetryNotBefore(input, now)).toBeNull();
  });
});
