import { describe, expect, it } from "vitest";
import { parseLocalLocalStdoutLine } from "./parse-stdout.js";

describe("parseLocalLocalStdoutLine", () => {
  const ts = "2026-03-30T12:00:00.000Z";

  it("parses LM Studio log lines as system entries", () => {
    const entries = parseLocalLocalStdoutLine(
      "[paperclip] LM Studio: POST http://127.0.0.1:1234/v1/chat/completions model=qwen/qwen3.5-9b",
      ts,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("system");
    expect(entries[0].ts).toBe(ts);
    expect((entries[0] as { text: string }).text).toContain("LM Studio");
  });

  it("parses paperclip fallback notices as system entries", () => {
    const entries = parseLocalLocalStdoutLine(
      "[paperclip] Claude unavailable (claude_auth_required). Falling back to local model: qwen/qwen3.5-9b",
      ts,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("system");
    expect((entries[0] as { text: string }).text).toContain("Falling back");
  });

  it("delegates Claude stream JSON init event to Claude parser", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session_abc",
      model: "claude-sonnet-4-6",
    });

    const entries = parseLocalLocalStdoutLine(line, ts);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("init");
    expect((entries[0] as { model: string }).model).toBe("claude-sonnet-4-6");
  });

  it("delegates Claude assistant text to Claude parser", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello from Claude" }],
      },
    });

    const entries = parseLocalLocalStdoutLine(line, ts);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
    expect((entries[0] as { text: string }).text).toBe("Hello from Claude");
  });

  it("delegates Claude result event to Claude parser", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task complete",
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.005,
    });

    const entries = parseLocalLocalStdoutLine(line, ts);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("result");
  });

  it("returns empty array for empty lines", () => {
    expect(parseLocalLocalStdoutLine("", ts)).toEqual([]);
    expect(parseLocalLocalStdoutLine("   ", ts)).toEqual([]);
  });
});
