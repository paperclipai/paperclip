import { describe, it, expect, beforeEach } from "vitest";
import { GuardrailPolicy, resetTurnViolations, validatePayload } from "../src/guardrail-policy.js";

const SESSION = "test-session-guardrail";

// Reset per-turn violation counter before each test
beforeEach(() => {
  resetTurnViolations(SESSION);
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

const makeToolResult = (overrides?: Record<string, unknown>) => ({
  tool: "Bash",
  status: "success",
  exit_code: 0,
  duration_ms: 100,
  stdout_ref: "artifact://" + "a".repeat(64),
  stderr_ref: "artifact://" + "b".repeat(64),
  preview: "output preview",
  parsed: null,
  truncation_flag: false,
  original_bytes: 100,
  original_lines: 5,
  ...overrides,
});

const makePayload = (toolResult?: Record<string, unknown>) => ({
  tool_result: toolResult ?? makeToolResult(),
});

// ---------------------------------------------------------------------------
// Tool summary size
// ---------------------------------------------------------------------------

describe("tool summary too large", () => {
  it("allows a compliant tool summary", () => {
    const policy = new GuardrailPolicy({ maxToolSummaryBytes: 1_500 });
    const result = policy.validate(makePayload(), SESSION);
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects oversized tool summary and returns instructive error", () => {
    const oversizedResult = makeToolResult({ preview: "x".repeat(2000) });
    const policy = new GuardrailPolicy({ maxToolSummaryBytes: 1_500 });
    const result = policy.validate({ tool_result: oversizedResult }, SESSION);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "tool_summary_too_large")).toBe(true);
    expect(result.errorMessage).toContain("artifact ref");
  });
});

// ---------------------------------------------------------------------------
// Base64 blob detection
// ---------------------------------------------------------------------------

describe("raw binary or base64 blob", () => {
  it("rejects payload with a base64 blob", () => {
    const blob = "A".repeat(150); // 150 char base64-like string
    const result = validatePayload({ content: blob }, SESSION);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "raw_binary_or_base64_blob")).toBe(true);
  });

  it("allows artifact:// refs (not blobs)", () => {
    const payload = {
      stdout_ref: "artifact://" + "a".repeat(64),
      stderr_ref: "artifact://" + "b".repeat(64),
    };
    const result = validatePayload(payload, SESSION);
    // Should not flag artifact refs as blobs
    expect(result.violations.some((v) => v.type === "raw_binary_or_base64_blob")).toBe(false);
  });

  it("allows short base64-like strings (under 100 chars)", () => {
    const shortB64 = "SGVsbG8gV29ybGQ="; // "Hello World" in base64
    const result = validatePayload({ token: shortB64 }, SESSION);
    expect(result.violations.some((v) => v.type === "raw_binary_or_base64_blob")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dynamic content above cache breakpoint
// ---------------------------------------------------------------------------

describe("dynamic content above cache breakpoint", () => {
  const scenarios = [
    { name: "ISO timestamp", content: "Last run at: 2026-04-13T10:30:00Z" },
    { name: "UUID", content: "Agent ID: 550e8400-e29b-41d4-a716-446655440000" },
    { name: "session ID assignment", content: "session_id: abc123defghi" },
    { name: "ticket number", content: "Working on ANGA-268" },
    { name: "cwd path", content: "Working directory: /Users/alice/workspace/project" },
  ];

  for (const { name, content } of scenarios) {
    it(`rejects ${name} above cache breakpoint`, () => {
      const payload = { system_prompt: content };
      const result = validatePayload(payload, SESSION);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.type === "dynamic_content_above_cache_breakpoint")).toBe(true);
    });
  }

  it("allows dynamic content BELOW the cache breakpoint marker", () => {
    const payload = {
      system_prompt:
        "Static instructions here.\n<!-- CACHE_BREAKPOINT -->\nCurrent time: 2026-04-13T10:30:00Z",
    };
    const result = validatePayload(payload, SESSION);
    expect(result.violations.some((v) => v.type === "dynamic_content_above_cache_breakpoint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing required schema fields
// ---------------------------------------------------------------------------

describe("missing required schema fields", () => {
  it("rejects tool result missing required fields", () => {
    // Missing: duration_ms, stdout_ref, stderr_ref, original_bytes, original_lines
    const incompleteResult = { tool: "Bash", status: "success", exit_code: 0 };
    const result = validatePayload({ tool_result: incompleteResult }, SESSION);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "missing_required_schema_fields")).toBe(true);
    expect(result.errorMessage).toContain("ToolResult schema");
  });

  it("allows a complete, valid tool result", () => {
    const result = validatePayload(makePayload(), SESSION);
    // Should only fail if there are other violations (like base64 in the artifact refs won't be flagged)
    const schemViolations = result.violations.filter((v) => v.type === "missing_required_schema_fields");
    expect(schemViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// max_output_tokens ceiling
// ---------------------------------------------------------------------------

describe("max_output_tokens exceeded", () => {
  it("rejects when max_tokens exceeds configured ceiling", () => {
    const policy = new GuardrailPolicy({ maxOutputTokens: 32_768 });
    const payload = { max_tokens: 50_000, messages: [] };
    const result = policy.validate(payload, SESSION);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "max_output_tokens_exceeded")).toBe(true);
  });

  it("allows when max_tokens is within ceiling", () => {
    const policy = new GuardrailPolicy({ maxOutputTokens: 32_768 });
    const payload = { max_tokens: 16_384, messages: [] };
    const result = policy.validate(payload, SESSION);
    expect(result.violations.some((v) => v.type === "max_output_tokens_exceeded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Double-violation checkpoint
// ---------------------------------------------------------------------------

describe("double-violation triggers forced checkpoint", () => {
  it("first violation does not force checkpoint", () => {
    const oversizedResult = makeToolResult({ preview: "x".repeat(2000) });
    const policy = new GuardrailPolicy({ maxToolSummaryBytes: 1_500 });
    const first = policy.validate({ tool_result: oversizedResult }, SESSION);
    expect(first.allowed).toBe(false);
    expect(first.forceCheckpoint).toBe(false);
  });

  it("second violation in the same session forces checkpoint", () => {
    const oversizedResult = makeToolResult({ preview: "x".repeat(2000) });
    const policy = new GuardrailPolicy({ maxToolSummaryBytes: 1_500 });
    policy.validate({ tool_result: oversizedResult }, SESSION);
    const second = policy.validate({ tool_result: oversizedResult }, SESSION);
    expect(second.forceCheckpoint).toBe(true);
    expect(second.errorMessage).toContain("forced checkpoint");
  });
});

// ---------------------------------------------------------------------------
// Context window limit
// ---------------------------------------------------------------------------

describe("context window limit", () => {
  it("rejects payload exceeding 90% of context window", () => {
    const policy = new GuardrailPolicy({ contextWindowTokens: 1_000 });
    // >900 tokens ≈ >3600 chars
    const hugePayload = { prompt: "x".repeat(4_000) };
    const result = policy.validate(hugePayload, SESSION);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "context_window_limit")).toBe(true);
  });

  it("allows payload within 90% context window", () => {
    const policy = new GuardrailPolicy({ contextWindowTokens: 200_000 });
    const smallPayload = { prompt: "short prompt" };
    const result = policy.validate(smallPayload, SESSION);
    expect(result.violations.some((v) => v.type === "context_window_limit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePayload convenience function
// ---------------------------------------------------------------------------

describe("validatePayload", () => {
  it("allows a clean payload", () => {
    const result = validatePayload({ messages: [{ role: "user", content: "hello" }] }, SESSION);
    expect(result.allowed).toBe(true);
  });

  it("accepts config overrides", () => {
    const result = validatePayload(
      { max_tokens: 50_000 },
      SESSION,
      { maxOutputTokens: 100_000 },
    );
    expect(result.violations.some((v) => v.type === "max_output_tokens_exceeded")).toBe(false);
  });
});
