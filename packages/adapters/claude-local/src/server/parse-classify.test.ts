import { describe, expect, it } from "vitest";
import { classifyClaudeFailure } from "./parse.js";

describe("classifyClaudeFailure", () => {
  it("returns null kind when there is no failure signal", () => {
    const result = classifyClaudeFailure({ stdout: "", stderr: "" });
    expect(result.kind).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
  });

  it("classifies the explicit 'not logged in' copy as auth_required", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        result: "Please log in. Run `claude login` first.",
      },
      stdout: "",
      stderr: "",
    });
    expect(result.kind).toBe("auth_required");
    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorFamily).toBe("auth");
  });

  it("classifies api_error_status:401 (without auth copy) as quota_exhausted", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        errors: [
          {
            message:
              "Anthropic API request failed: api_error_status: 401 (subscription token rejected)",
          },
        ],
      },
      stdout: "",
      stderr: "",
    });
    expect(result.kind).toBe("quota_exhausted");
    expect(result.errorCode).toBe("claude_quota_exhausted");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.httpStatus).toBe(401);
  });

  it("classifies 'quota exhausted' wording without an HTTP status as quota_exhausted", () => {
    const result = classifyClaudeFailure({
      parsed: { is_error: true, result: "Monthly Opus quota exhausted." },
      stdout: "",
      stderr: "",
    });
    expect(result.kind).toBe("quota_exhausted");
    expect(result.errorCode).toBe("claude_quota_exhausted");
  });

  it("classifies api_error_status:429 as rate_limited", () => {
    const result = classifyClaudeFailure({
      stderr: "Anthropic responded api_error_status: 429 Too Many Requests",
    });
    expect(result.kind).toBe("rate_limited");
    expect(result.errorCode).toBe("claude_rate_limited");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.httpStatus).toBe(429);
  });

  it("classifies a 429 stderr line without api_error_status as rate_limited", () => {
    const result = classifyClaudeFailure({
      stderr: "HTTP 429: Too Many Requests",
    });
    expect(result.kind).toBe("rate_limited");
    expect(result.errorCode).toBe("claude_rate_limited");
  });

  it("classifies rate_limit_error events as rate_limited", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        errors: [
          {
            type: "rate_limit_error",
            message: "Rate limit reached for requests.",
          },
        ],
      },
    });
    expect(result.kind).toBe("rate_limited");
    expect(result.errorCode).toBe("claude_rate_limited");
  });

  it("classifies api_error_status:503 as provider_5xx", () => {
    const result = classifyClaudeFailure({
      stderr: "api_error_status: 503 Service Unavailable",
    });
    expect(result.kind).toBe("provider_5xx");
    expect(result.errorCode).toBe("claude_provider_5xx");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.httpStatus).toBe(503);
  });

  it("classifies api_error_status:500 as provider_5xx", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        errors: [{ message: "Upstream failure api_error_status: 500" }],
      },
    });
    expect(result.kind).toBe("provider_5xx");
    expect(result.errorCode).toBe("claude_provider_5xx");
    expect(result.httpStatus).toBe(500);
  });

  it("falls back to transient_upstream for overloaded/throttling without a status code", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        errors: [{ type: "overloaded_error", message: "Overloaded" }],
      },
    });
    expect(result.kind).toBe("transient_upstream");
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("falls back to transient_upstream for 'out of extra usage' subscription wording", () => {
    const result = classifyClaudeFailure({
      errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
    });
    // "out of extra usage" is a quota-shaped wording, so we treat it as quota_exhausted.
    expect(result.kind).toBe("quota_exhausted");
    expect(result.errorCode).toBe("claude_quota_exhausted");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("ignores deterministic max-turns failures", () => {
    const result = classifyClaudeFailure({
      parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
    });
    expect(result.kind).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it("ignores deterministic unknown-session failures", () => {
    const result = classifyClaudeFailure({
      parsed: {
        result: "No conversation found with session id abc-123",
        errors: [{ message: "No conversation found with session id abc-123" }],
      },
    });
    expect(result.kind).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it("auth-required wins over a coincidental 401 status", () => {
    const result = classifyClaudeFailure({
      parsed: {
        is_error: true,
        result: "Please log in. api_error_status: 401",
      },
    });
    expect(result.kind).toBe("auth_required");
    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("extracts retry-after seconds when present", () => {
    const result = classifyClaudeFailure({
      stderr: "api_error_status: 429 Too Many Requests retry-after: 30",
    });
    expect(result.kind).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("returns the loginUrl alongside the classification when one is in the output", () => {
    const result = classifyClaudeFailure({
      stdout: "Please log in. Visit https://claude.ai/login to continue.",
    });
    expect(result.kind).toBe("auth_required");
    expect(result.loginUrl).toContain("claude.ai/login");
  });
});
