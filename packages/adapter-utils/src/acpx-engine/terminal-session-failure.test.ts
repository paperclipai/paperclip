import { describe, expect, it } from "vitest";
import { classifyToolDefinitionFailure, formatTerminalSessionFailure, sanitizeTerminalSessionFailure } from "./terminal-session-failure.js";

describe("terminal session failure diagnostics", () => {
  it.each([
    "API Error: 400 tools.17.custom.name: String should have at most 128 characters",
    "tools[0].input_schema: invalid schema",
    "Invalid schema for function 'read-file': unsupported type",
  ])("rejects unchanged tool definitions: %s", (details) => {
    const failure = { category: "service", details };
    expect(classifyToolDefinitionFailure(failure)).toEqual({
      errorCode: "provider_tool_definition_invalid", errorFamily: "configuration",
    });
    // Classification precedes arbitrary short-secret redaction.
    expect(sanitizeTerminalSessionFailure(failure, { SECRET: "128" }).details).not.toContain("128");
  });
  it.each([
    "HTTP 503 service unavailable",
    "tool call arguments are invalid: name must be a string",
    "prompt is too long",
    "tools.0.arguments.name: String should have at most 128 characters",
  ])("keeps unrelated errors on their existing recovery path: %s", (details) => {
    expect(classifyToolDefinitionFailure({ category: "service", details })).toBeNull();
  });
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

  it("redacts unknown inherited launch values while preserving public process context", () => {
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "service",
      details: "request_id=req_123 inherited-canary A /workspace",
    }, { UNEXPECTED_VARIABLE: "inherited-canary", ANOTHER_VARIABLE: "A", HOME: "/workspace" });
    expect(diagnostic.details).toBe("request_id=req_123 ***REDACTED*** ***REDACTED*** /workspace");
  });

  it("preserves known boolean settings, HTTP codes and request IDs", () => {
    const details = "HTTP 401 request_id=req_123 req-1 /1/path retries=1";
    const diagnostic = sanitizeTerminalSessionFailure({ category: "access", details }, {
      OPENCODE_ALLOW_ALL_MODELS: "1",
    }, undefined, { OPENCODE_ALLOW_ALL_MODELS: "1" });
    expect(diagnostic.details).toBe(details);
  });

  it("redacts short credentials even inside words, paths and punctuated strings", () => {
    const diagnostic = sanitizeTerminalSessionFailure({
      category: "access", details: "upstream abc-def /abc/path xabcx abc.value abc_other",
    }, { CUSTOM_SETTING: "abc" }, undefined, { CUSTOM_SETTING: "abc" });
    expect(diagnostic.details).not.toContain("abc");
    expect(diagnostic.details).toBe(
      "upstream ***REDACTED***-def /***REDACTED***/path x***REDACTED***x ***REDACTED***.value ***REDACTED***_other",
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
