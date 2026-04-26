import { describe, expect, it } from "vitest";
import { parseGeminiStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-17T00:00:00.000Z";

// ============================================================================
// Non-JSON fallback
// ============================================================================

describe("parseGeminiStdoutLine — non-JSON input", () => {
  it("wraps plain text in a stdout entry", () => {
    const result = parseGeminiStdoutLine("hello world", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stdout", text: "hello world", ts: TS });
  });

  it("wraps malformed JSON in a stdout entry", () => {
    const result = parseGeminiStdoutLine("{not json}", TS);
    expect(result[0]?.kind).toBe("stdout");
  });

  it("wraps blank line in a stdout entry", () => {
    const result = parseGeminiStdoutLine("", TS);
    expect(result[0]?.kind).toBe("stdout");
  });
});

// ============================================================================
// system / init event
// ============================================================================

describe("parseGeminiStdoutLine — system init", () => {
  it("returns an init entry with sessionId and model", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-42",
      model: "gemini-2.0",
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "init", model: "gemini-2.0", sessionId: "sess-42" });
  });

  it("uses thread_id as session fallback when session_id is absent", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      thread_id: "thread-99",
      model: "gemini-pro",
    });
    const result = parseGeminiStdoutLine(line, TS);
    const entry = result[0] as { kind: string; sessionId?: string };
    expect(entry.sessionId).toBe("thread-99");
  });

  it("returns a system entry for other subtypes", () => {
    const line = JSON.stringify({ type: "system", subtype: "unknown_subtype" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("system");
  });

  it("returns stderr for system error subtype", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "error",
      error: "quota exceeded",
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("stderr");
    const entry = result[0] as { kind: string; text: string };
    expect(entry.text).toContain("quota exceeded");
  });
});

// ============================================================================
// assistant event
// ============================================================================

describe("parseGeminiStdoutLine — assistant", () => {
  it("extracts text content from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello there!" }],
      },
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result.some((e) => e.kind === "assistant")).toBe(true);
    const entry = result.find((e) => e.kind === "assistant") as { kind: string; text: string } | undefined;
    expect(entry?.text).toContain("Hello there!");
  });
});

// ============================================================================
// thinking event
// ============================================================================

describe("parseGeminiStdoutLine — thinking", () => {
  it("returns a thinking entry for type=thinking with text", () => {
    const line = JSON.stringify({ type: "thinking", text: "reasoning..." });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "thinking", text: "reasoning..." });
  });

  it("returns empty for thinking with no text", () => {
    const line = JSON.stringify({ type: "thinking", text: "" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// text event
// ============================================================================

describe("parseGeminiStdoutLine — text", () => {
  it("returns an assistant entry for type=text", () => {
    const line = JSON.stringify({ type: "text", text: "Here is my response." });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "assistant", text: "Here is my response." });
  });

  it("returns empty for type=text with blank text", () => {
    const line = JSON.stringify({ type: "text", text: "   " });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// result event
// ============================================================================

describe("parseGeminiStdoutLine — result", () => {
  it("returns a result entry with usage fields", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task complete",
      total_cost_usd: 0.012,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
    });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    const entry = result[0] as { kind: string; text: string; costUsd: number; inputTokens: number };
    expect(entry.kind).toBe("result");
    expect(entry.text).toBe("Task complete");
    expect(entry.costUsd).toBe(0.012);
    expect(entry.inputTokens).toBe(100);
  });

  it("returns an error result for is_error=true", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      error: "something failed",
    });
    const result = parseGeminiStdoutLine(line, TS);
    const entry = result[0] as { kind: string; isError: boolean; errors: string[] };
    expect(entry.kind).toBe("result");
    expect(entry.isError).toBe(true);
    expect(entry.errors).toContain("something failed");
  });
});

// ============================================================================
// error event
// ============================================================================

describe("parseGeminiStdoutLine — error", () => {
  it("returns a stderr entry for type=error with string error", () => {
    const line = JSON.stringify({ type: "error", error: "auth failed" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("stderr");
    const entry = result[0] as { kind: string; text: string };
    expect(entry.text).toContain("auth failed");
  });

  it("returns a stderr entry with fallback text for empty error", () => {
    const line = JSON.stringify({ type: "error" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("stderr");
  });
});

// ============================================================================
// step_finish / step_complete
// ============================================================================

describe("parseGeminiStdoutLine — step_finish / step_complete", () => {
  it("returns empty array for type=step_finish", () => {
    const line = JSON.stringify({ type: "step_finish" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for type=step_complete", () => {
    const line = JSON.stringify({ type: "step_complete" });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// unknown type fallback
// ============================================================================

describe("parseGeminiStdoutLine — unknown type", () => {
  it("falls through to stdout for unknown event types", () => {
    const line = JSON.stringify({ type: "mystery_event", data: {} });
    const result = parseGeminiStdoutLine(line, TS);
    expect(result[0]?.kind).toBe("stdout");
  });
});
