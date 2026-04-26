import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printCursorStreamEvent } from "./format-event.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

// Collect all console.log calls during a printCursorStreamEvent call.
// Returns the raw arguments from each call joined with newlines.
function capture(raw: string, debug = false): string[] {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    calls.push(args.map(String).join(" "));
  });
  try {
    printCursorStreamEvent(raw, debug);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

// ============================================================================
// Empty / non-JSON input
// ============================================================================

describe("printCursorStreamEvent — empty / non-JSON input", () => {
  it("does nothing for empty string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printCursorStreamEvent("", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does nothing for whitespace-only string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printCursorStreamEvent("   ", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints raw line when content is not JSON", () => {
    const calls = capture("not json at all");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("not json at all");
  });

  it("handles stdout: prefix by stripping it before parsing", () => {
    const calls = capture(`stdout: ${line({ type: "error", message: "oops" })}`);
    expect(calls[0]).toContain("error:");
    expect(calls[0]).toContain("oops");
  });
});

// ============================================================================
// system events
// ============================================================================

describe("printCursorStreamEvent — system events", () => {
  it("prints init with session and model", () => {
    const calls = capture(line({ type: "system", subtype: "init", session_id: "sess-1", model: "gpt-4" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Cursor init");
    expect(calls[0]).toContain("sess-1");
    expect(calls[0]).toContain("gpt-4");
  });

  it("supports sessionId camelCase variant", () => {
    const calls = capture(line({ type: "system", subtype: "init", sessionId: "sess-camel" }));
    expect(calls[0]).toContain("sess-camel");
  });

  it("supports sessionID all-caps variant", () => {
    const calls = capture(line({ type: "system", subtype: "init", sessionID: "sess-caps" }));
    expect(calls[0]).toContain("sess-caps");
  });

  it("prints init without details when session_id and model are absent", () => {
    const calls = capture(line({ type: "system", subtype: "init" }));
    expect(calls[0]).toContain("Cursor init");
    expect(calls[0]).not.toContain("(");
  });

  it("prints generic system subtype for non-init events", () => {
    const calls = capture(line({ type: "system", subtype: "heartbeat" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("system:");
    expect(calls[0]).toContain("heartbeat");
  });

  it("prints 'system: event' when subtype is absent", () => {
    const calls = capture(line({ type: "system" }));
    expect(calls[0]).toContain("system:");
    expect(calls[0]).toContain("event");
  });
});

// ============================================================================
// assistant events (string message)
// ============================================================================

describe("printCursorStreamEvent — assistant string message", () => {
  it("prints assistant text from string message", () => {
    const calls = capture(line({ type: "assistant", message: "Hello world" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("Hello world");
  });

  it("skips empty string message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printCursorStreamEvent(line({ type: "assistant", message: "   " }), false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ============================================================================
// assistant events (object message)
// ============================================================================

describe("printCursorStreamEvent — assistant object message", () => {
  it("prints text from message.text field", () => {
    const calls = capture(line({ type: "assistant", message: { text: "Direct text" } }));
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("Direct text");
  });

  it("prints text from message.content[].type=output_text parts", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "output_text", text: "Part text" }] },
    }));
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("Part text");
  });

  it("prints text from message.content[].type=text parts", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Text type" }] },
    }));
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("Text type");
  });

  it("prints thinking from content part", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "my reasoning" }] },
    }));
    expect(calls[0]).toContain("thinking:");
    expect(calls[0]).toContain("my reasoning");
  });

  it("prints tool_call from content part with name", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_call", name: "bash", input: { cmd: "ls" } }] },
    }));
    expect(calls[0]).toContain("tool_call:");
    expect(calls[0]).toContain("bash");
  });

  it("prints tool_result from content part", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_result", output: "file list" }] },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("tool_result");
  });

  it("marks tool_result as error when is_error=true", () => {
    const calls = capture(line({
      type: "assistant",
      message: { content: [{ type: "tool_result", is_error: true, output: "fail" }] },
    }));
    expect(calls[0]).toContain("error");
  });
});

// ============================================================================
// user events
// ============================================================================

describe("printCursorStreamEvent — user events", () => {
  it("prints user text from string message", () => {
    const calls = capture(line({ type: "user", message: "Hello from user" }));
    expect(calls[0]).toContain("user:");
    expect(calls[0]).toContain("Hello from user");
  });

  it("prints user text from message.text field", () => {
    const calls = capture(line({ type: "user", message: { text: "Object user" } }));
    expect(calls[0]).toContain("user:");
    expect(calls[0]).toContain("Object user");
  });

  it("prints user text from content array (output_text)", () => {
    const calls = capture(line({
      type: "user",
      message: { content: [{ type: "output_text", text: "Content user" }] },
    }));
    expect(calls[0]).toContain("user:");
    expect(calls[0]).toContain("Content user");
  });
});

// ============================================================================
// thinking events
// ============================================================================

describe("printCursorStreamEvent — thinking events", () => {
  it("prints thinking text from top-level text field", () => {
    const calls = capture(line({ type: "thinking", text: "deep thought" }));
    expect(calls[0]).toContain("thinking:");
    expect(calls[0]).toContain("deep thought");
  });

  it("prints thinking text from delta.text field", () => {
    const calls = capture(line({ type: "thinking", delta: { text: "delta thought" } }));
    expect(calls[0]).toContain("thinking:");
    expect(calls[0]).toContain("delta thought");
  });

  it("does nothing for empty thinking text", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printCursorStreamEvent(line({ type: "thinking", text: "   " }), false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ============================================================================
// tool_call events
// ============================================================================

describe("printCursorStreamEvent — tool_call events", () => {
  it("prints tool_call started with name and callId", () => {
    const calls = capture(line({
      type: "tool_call",
      subtype: "started",
      call_id: "cid-1",
      tool_call: { bash: { args: { cmd: "ls" } } },
    }));
    expect(calls[0]).toContain("tool_call:");
    expect(calls[0]).toContain("bash");
    expect(calls[0]).toContain("cid-1");
  });

  it("prints tool_call completed with result", () => {
    const calls = capture(line({
      type: "tool_call",
      subtype: "completed",
      call_id: "cid-2",
      tool_call: { bash: { result: "file list" } },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("tool_result");
    expect(combined).toContain("file list");
  });

  it("marks completed tool_call as error when error field present", () => {
    const calls = capture(line({
      type: "tool_call",
      subtype: "completed",
      tool_call: { bash: { error: "command failed" } },
    }));
    expect(calls[0]).toContain("error");
  });

  it("prints tool_call with subtype=failed in the label (falls through to default)", () => {
    const calls = capture(line({
      type: "tool_call",
      subtype: "failed",
      tool_call: { bash: {} },
    }));
    expect(calls[0]).toContain("tool_call:");
    expect(calls[0]).toContain("bash");
    expect(calls[0]).toContain("failed");
  });

  it("prints tool_call without subtype handling gracefully", () => {
    const calls = capture(line({
      type: "tool_call",
      tool_call: { mytool: {} },
    }));
    expect(calls[0]).toContain("tool_call:");
  });

  it("prints tool_call without tool_call object gracefully", () => {
    const calls = capture(line({ type: "tool_call", subtype: "started" }));
    expect(calls[0]).toContain("tool_call");
  });
});

// ============================================================================
// result events
// ============================================================================

describe("printCursorStreamEvent — result events", () => {
  it("prints result with token and cost info", () => {
    const calls = capture(line({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      total_cost_usd: 0.001234,
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("result:");
    expect(combined).toContain("tokens:");
    expect(combined).toContain("in=100");
    expect(combined).toContain("out=50");
  });

  it("includes result text when present", () => {
    const calls = capture(line({ type: "result", subtype: "success", result: "Task done." }));
    const combined = calls.join("\n");
    expect(combined).toContain("assistant:");
    expect(combined).toContain("Task done.");
  });

  it("uses camelCase token field variants", () => {
    const calls = capture(line({
      type: "result",
      usage: { inputTokens: 200, outputTokens: 80, cachedInputTokens: 5 },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("in=200");
    expect(combined).toContain("out=80");
  });

  it("marks result as error when subtype=error", () => {
    const calls = capture(line({ type: "result", subtype: "error", result: "fail" }));
    const combined = calls.join("\n");
    // error result text should still show but not as assistant
    expect(combined).toContain("result:");
  });

  it("prints errors array when present", () => {
    const calls = capture(line({ type: "result", errors: ["err1", "err2"] }));
    const combined = calls.join("\n");
    expect(combined).toContain("errors:");
    expect(combined).toContain("err1");
    expect(combined).toContain("err2");
  });
});

// ============================================================================
// error events
// ============================================================================

describe("printCursorStreamEvent — error events", () => {
  it("prints error message from message field", () => {
    const calls = capture(line({ type: "error", message: "something went wrong" }));
    expect(calls[0]).toContain("error:");
    expect(calls[0]).toContain("something went wrong");
  });

  it("prints error from error field when message absent", () => {
    const calls = capture(line({ type: "error", error: { code: "ENOENT" } }));
    expect(calls[0]).toContain("error:");
    expect(calls[0]).toContain("ENOENT");
  });

  it("falls back to raw line when error event has no extractable message", () => {
    // Empty error event — message is "" and error is absent, falls back to raw line
    const raw = line({ type: "error" });
    const calls = capture(raw);
    expect(calls[0]).toContain("error");
  });
});

// ============================================================================
// legacy event shapes (step_start, text, tool_use, step_finish)
// ============================================================================

describe("printCursorStreamEvent — legacy event shapes", () => {
  it("prints step_start with sessionID", () => {
    const calls = capture(line({ type: "step_start", sessionID: "legacy-sess" }));
    expect(calls[0]).toContain("step started");
    expect(calls[0]).toContain("legacy-sess");
  });

  it("prints step_start without session when sessionID absent", () => {
    const calls = capture(line({ type: "step_start" }));
    expect(calls[0]).toContain("step started");
    expect(calls[0]).not.toContain("session");
  });

  it("prints assistant text from text event with part.text", () => {
    const calls = capture(line({ type: "text", part: { text: "legacy text" } }));
    expect(calls[0]).toContain("assistant:");
    expect(calls[0]).toContain("legacy text");
  });

  it("prints tool_use event via printLegacyToolEvent", () => {
    const calls = capture(line({
      type: "tool_use",
      part: {
        tool: "bash",
        callID: "id-1",
        state: { status: "completed", input: { cmd: "echo hi" }, output: "hi" },
      },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("tool_call:");
    expect(combined).toContain("bash");
    expect(combined).toContain("tool_result");
    expect(combined).toContain("hi");
  });

  it("marks tool_use as error when status=failed", () => {
    const calls = capture(line({
      type: "tool_use",
      part: { tool: "bash", state: { status: "failed", output: "bad" } },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("status=failed");
  });

  it("prints step_finish with token info", () => {
    const calls = capture(line({
      type: "step_finish",
      part: { reason: "end_turn", tokens: { input: 100, output: 50, cache: { read: 5 } }, cost: 0.001 },
    }));
    const combined = calls.join("\n");
    expect(combined).toContain("step finished:");
    expect(combined).toContain("tokens:");
    expect(combined).toContain("in=100");
    expect(combined).toContain("out=50");
  });
});
