import { afterEach, describe, expect, it, vi } from "vitest";
import { printClaudeStreamEvent } from "./format-event.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function capture(raw: string, debug = false): string[] {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    calls.push(args.map(String).join(" "));
  });
  try {
    printClaudeStreamEvent(raw, debug);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

// ============================================================================
// Empty / non-JSON input
// ============================================================================

describe("printClaudeStreamEvent — empty / non-JSON input", () => {
  it("does nothing for empty string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printClaudeStreamEvent("", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does nothing for whitespace-only string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printClaudeStreamEvent("   ", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints raw line when content is not JSON", () => {
    const calls = capture("not valid json");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("not valid json");
  });

  it("does not print non-JSON raw line when debug=false and input is unknown event type", () => {
    // Valid JSON but unknown event type — with debug=false, should be silent
    const calls = capture(line({ type: "unknown_event" }), false);
    expect(calls).toHaveLength(0);
  });

  it("prints unknown JSON event in debug mode", () => {
    const calls = capture(line({ type: "unknown_event", data: "value" }), true);
    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// system init events
// ============================================================================

describe("printClaudeStreamEvent — system init events", () => {
  it("prints model and session on init", () => {
    const calls = capture(line({ type: "system", subtype: "init", model: "claude-3-opus", session_id: "sess-1" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Claude initialized");
    expect(calls[0]).toContain("claude-3-opus");
    expect(calls[0]).toContain("sess-1");
  });

  it("prints model without session when session_id is absent", () => {
    const calls = capture(line({ type: "system", subtype: "init", model: "claude-3-sonnet" }));
    expect(calls[0]).toContain("claude-3-sonnet");
    expect(calls[0]).not.toContain("session:");
  });

  it("prints 'unknown' when model field is absent", () => {
    const calls = capture(line({ type: "system", subtype: "init" }));
    expect(calls[0]).toContain("unknown");
  });

  it("ignores non-init system events in non-debug mode", () => {
    const calls = capture(line({ type: "system", subtype: "heartbeat" }), false);
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// assistant events
// ============================================================================

describe("printClaudeStreamEvent — assistant events", () => {
  it("prints text block from content array", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("Hello world");
  });

  it("does not print text block when text is empty", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    }));
    expect(calls).toHaveLength(0);
  });

  it("prints thinking block from content array", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "My reasoning" }] },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("thinking:");
    expect(calls[0]).toContain("My reasoning");
  });

  it("does not print thinking block when thinking text is empty", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }] },
    }));
    expect(calls).toHaveLength(0);
  });

  it("prints tool_use block from content array", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "bash", input: { cmd: "ls" } }] },
    }));
    expect(calls).toHaveLength(2); // tool_call line + input JSON
    expect(calls[0]).toContain("tool_call:");
    expect(calls[0]).toContain("bash");
    expect(calls[1]).toContain("cmd");
  });

  it("prints tool_use without input when input is undefined", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "read" }] },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("tool_call:");
    expect(calls[0]).toContain("read");
  });

  it("uses 'unknown' as tool name when name field is absent", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_use" }] },
    }));
    expect(calls[0]).toContain("unknown");
  });

  it("handles multiple content blocks in order", () => {
    const calls = capture(line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    }));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("First");
    expect(calls[1]).toContain("Second");
  });

  it("ignores unknown content block types", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "image", url: "http://example.com" }] },
    }));
    expect(calls).toHaveLength(0);
  });

  it("handles absent message.content gracefully", () => {
    const calls = capture(line({ type: "assistant", message: {} }));
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// user events
// ============================================================================

describe("printClaudeStreamEvent — user events", () => {
  it("prints tool_result block from user message content", () => {
    const calls = capture(line({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "command output", is_error: false }],
      },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("tool_result");
    expect(combined).toContain("command output");
  });

  it("marks tool_result as error when is_error=true", () => {
    const calls = capture(line({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "fail", is_error: true }],
      },
    }));
    expect(calls[0]).toContain("error");
  });

  it("handles content array in tool_result block", () => {
    const calls = capture(line({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "array content" }],
          },
        ],
      },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("array content");
  });

  it("ignores non-tool_result blocks in user message", () => {
    const calls = capture(line({
      type: "user",
      message: {
        content: [{ type: "text", text: "user text" }],
      },
    }));
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// result events
// ============================================================================

describe("printClaudeStreamEvent — result events", () => {
  it("prints result text when present", () => {
    const calls = capture(line({ type: "result", result: "Done.", subtype: "success" }));
    const combined = calls.join("\n");
    expect(combined).toContain("result:");
    expect(combined).toContain("Done.");
  });

  it("always prints token summary", () => {
    const calls = capture(line({
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      total_cost_usd: 0.001234,
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("tokens:");
    expect(combined).toContain("in=100");
    expect(combined).toContain("out=50");
    expect(combined).toContain("cached=10");
  });

  it("prints error info when subtype starts with 'error'", () => {
    const calls = capture(line({ type: "result", subtype: "error_max_turns" }));
    const combined = calls.join("\n");
    expect(combined).toContain("claude_result:");
    expect(combined).toContain("error_max_turns");
  });

  it("prints error info when is_error=true", () => {
    const calls = capture(line({ type: "result", is_error: true }));
    const combined = calls.join("\n");
    expect(combined).toContain("claude_result:");
    expect(combined).toContain("is_error=true");
  });

  it("prints errors array when present and non-empty", () => {
    const calls = capture(line({ type: "result", errors: ["err1", { message: "err2" }] }));
    const combined = calls.join("\n");
    expect(combined).toContain("claude_errors:");
    expect(combined).toContain("err1");
    expect(combined).toContain("err2");
  });

  it("uses 0 for missing token fields", () => {
    const calls = capture(line({ type: "result" }));
    const combined = calls.join("\n");
    expect(combined).toContain("in=0");
    expect(combined).toContain("out=0");
    expect(combined).toContain("cached=0");
  });

  it("does not print result: header when result text is absent", () => {
    const calls = capture(line({ type: "result", subtype: "success" }));
    const combined = calls.join("\n");
    expect(combined).not.toContain("result:");
  });
});
