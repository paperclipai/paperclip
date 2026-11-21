/**
 * Tests for parseBobShellStdoutLine (UI transcript parser).
 */

import { describe, it, expect } from "vitest";
import { parseBobShellStdoutLine } from "./parse-stdout.js";

describe("parseBobShellStdoutLine", () => {
  const ts = "2024-01-01T00:00:00.000Z";

  it("emits system entry for [bob-shell] log lines", () => {
    const entries = parseBobShellStdoutLine("[bob-shell] Starting...", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("system");
  });

  it("emits assistant entry with delta=true for message role=assistant", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello from Bob",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("assistant");
    expect((entries[0] as { text: string }).text).toBe("Hello from Bob");
    expect((entries[0] as { delta?: boolean }).delta).toBe(true);
  });

  it("emits thinking entry with delta=true for isReasoning=true messages", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Thinking deeply...",
      isReasoning: true,
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("thinking");
    expect((entries[0] as { delta?: boolean }).delta).toBe(true);
  });

  it("emits user entry for message role=user", () => {
    const line = JSON.stringify({
      type: "message",
      role: "user",
      content: "Explain this file",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("user");
  });

  it("emits tool_call entry for tool_use events", () => {
    const line = JSON.stringify({
      type: "tool_use",
      tool_name: "read_file",
      tool_id: "tool-001",
      parameters: { path: "src/index.ts" },
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_call");
    expect((entries[0] as { name: string }).name).toBe("read_file");
    expect((entries[0] as { toolUseId: string }).toolUseId).toBe("tool-001");
  });

  it("emits tool_result entry for tool_result events (success)", () => {
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "tool-001",
      status: "success",
      output: "file contents here",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_result");
    expect((entries[0] as { isError: boolean }).isError).toBe(false);
    expect((entries[0] as { content: string }).content).toBe("file contents here");
  });

  it("emits tool_result with isError=true for error status", () => {
    const line = JSON.stringify({
      type: "tool_result",
      tool_id: "tool-002",
      status: "error",
      error: "file not found",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_result");
    expect((entries[0] as { isError: boolean }).isError).toBe(true);
  });

  it("emits stderr entry for error events", () => {
    const line = JSON.stringify({
      type: "error",
      severity: "cost",
      message: "Cost limit exceeded",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("stderr");
    expect((entries[0] as { text: string }).text).toContain("Cost limit exceeded");
  });

  it("emits assistant + result entries for successful result events", () => {
    const line = JSON.stringify({
      type: "result",
      status: "success",
      stats: {
        total_tokens: 400,
        input_tokens: 250,
        output_tokens: 150,
        duration_ms: 5000,
        session_costs: 0.01,
      },
      last_message: "Task completed successfully.",
    });
    const entries = parseBobShellStdoutLine(line, ts);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("result");
  });

  it("returns empty array for empty/whitespace lines", () => {
    expect(parseBobShellStdoutLine("", ts)).toHaveLength(0);
    expect(parseBobShellStdoutLine("   ", ts)).toHaveLength(0);
  });

  it("emits stdout entry for plain text lines", () => {
    const entries = parseBobShellStdoutLine("Some plain output", ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("stdout");
  });

  it("emits stdout entry for invalid JSON lines", () => {
    const entries = parseBobShellStdoutLine('{"broken": json}', ts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("stdout");
  });
});
