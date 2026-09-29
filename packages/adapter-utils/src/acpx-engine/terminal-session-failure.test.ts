import { describe, expect, it } from "vitest";
import { formatTerminalSessionFailure, sanitizeTerminalSessionFailure } from "./terminal-session-failure.js";

describe("terminal session failure diagnostics", () => {
  it("keeps the provider category, message, request id and stack", () => {
    const failure = {
      category: "service",
      title: "HTTP 529: overloaded_error",
      details: 'request_id=req_diagnostic_123\n{"error":{"message":"Service unavailable"}}\n    at prompt (agent.js:42:7)',
    };
    const diagnostic = sanitizeTerminalSessionFailure(failure, {});
    expect(diagnostic).toEqual(failure);
    expect(formatTerminalSessionFailure("ACP turn failed.", diagnostic)).toBe(
      `ACP turn failed.\n${failure.title}\n${failure.details}`,
    );
  });

  it("redacts known credentials and common secret forms without dropping useful context", () => {
    const secret = 'opaque / credential "value"';
    const runKey = "run-credential-canary";
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "access",
      title: `Request rejected: ${secret}`,
      details: [
        `request_id=req_123 ${runKey}`,
        JSON.stringify({ message: secret }),
        `https://example.test/?value=${encodeURIComponent(secret)}`,
        'Authorization: Bearer bearer-canary',
        '{"api_key":"json-canary"}',
        'sk-ant-example-provider-key-canary',
        'TOKEN=assignment-canary',
      ].join("\n"),
    }, { PROVIDER_SECRET: secret }, runKey);
    const serialized = JSON.stringify(diagnostic);
    for (const value of ["opaque", runKey, "bearer-canary", "json-canary", "sk-ant-example", "assignment-canary"]) {
      expect(serialized).not.toContain(value);
    }
    expect(diagnostic.details).toContain("request_id=req_123");
    expect(diagnostic.title).toBe("Request rejected: ***REDACTED***");
  });

  it("redacts before truncation and reports every omitted field", () => {
    const credential = "opaque-credential-crossing-the-limit";
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "service",
      title: "t".repeat(5000),
      details: `${"d".repeat(24568)}${credential}${"x".repeat(1000)}`,
    }, { API_KEY: credential });
    expect(diagnostic.truncatedFields).toEqual(["title", "details"]);
    expect(diagnostic.title).toContain("[truncated: 904 characters omitted]");
    expect(diagnostic.details).not.toContain("opaque");
    expect(diagnostic.details).toContain("[truncated:");
    expect(diagnostic.details!.length).toBeLessThan(24700);
  });

  it("redacts configured values with arbitrary names and connection URL passwords", () => {
    const databaseUrl = "postgres://user:database%20canary@db.test/database";
    const opaque = "arbitrarily-named-secret";
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "service",
      details: `request_id=req_123 ${databaseUrl}\npassword echoed: database canary\n${opaque}`,
    }, { DATABASE_URL: databaseUrl, PROVIDER_SETTING: opaque }, undefined, {
      DATABASE_URL: databaseUrl, PROVIDER_SETTING: opaque,
    });
    expect(diagnostic.details).toBe(
      "request_id=req_123 ***REDACTED***\npassword echoed: ***REDACTED***\n***REDACTED***",
    );
  });

  it("fits the persisted transcript chunk limit even with escaped provider text", () => {
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "service",
      title: '"'.repeat(5000),
      details: "\\".repeat(40000),
    }, {});
    const log = JSON.stringify({
      type: "acpx.error", summary: "failed", stopReason: "adapter_failed",
      message: formatTerminalSessionFailure("ACP agent reported a terminal service failure.", diagnostic),
    });
    expect(log.length).toBeLessThan(64 * 1024);
    expect(JSON.parse(log).message).toContain("[truncated:");
  });

  it("handles empty, malformed and control-character fields", () => {
    expect(sanitizeTerminalSessionFailure({
      category: "untrusted-category",
      title: " \n",
      details: 42 as unknown as string,
    }, {})).toEqual({ category: "unknown" });
    expect(sanitizeTerminalSessionFailure({
      category: "service",
      title: "\x1b[31mFailure\x1b[0m\0",
      details: "line 1\n\tline 2",
    }, {})).toEqual({ category: "service", title: "Failure", details: "line 1\n\tline 2" });
    expect(formatTerminalSessionFailure("original error", null)).toBe("original error");
  });

  it("keeps truncated Unicode valid for JSONB storage", () => {
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "service",
      title: `${"x".repeat(4095)}🚨failure`,
      details: "malformed \ud800 detail",
    }, {});
    expect(diagnostic.title).not.toMatch(/[\ud800-\udfff]/u);
    expect(diagnostic.details).not.toMatch(/[\ud800-\udfff]/u);
    expect(diagnostic.truncatedFields).toEqual(["title"]);
  });
});
