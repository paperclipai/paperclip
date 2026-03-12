import { describe, expect, it, vi } from "vitest";
import { parseKiroJsonOutput, isKiroUnknownSessionError } from "@paperclipai/adapter-kiro-local/server";
import { sessionCodec as kiroSessionCodec } from "@paperclipai/adapter-kiro-local/server";
import { parseKiroStdoutLine } from "@paperclipai/adapter-kiro-local/ui";
import { buildKiroLocalConfig } from "@paperclipai/adapter-kiro-local/ui";
import { printKiroStreamEvent } from "@paperclipai/adapter-kiro-local/cli";

// ---------------------------------------------------------------------------
// Server: parseKiroJsonOutput
// ---------------------------------------------------------------------------

describe("kiro_local parser", () => {
  it("extracts session, summary, and usage from stream JSON", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "kiro-sess-42", model: "auto" }),
      JSON.stringify({
        type: "assistant",
        session_id: "kiro-sess-42",
        message: { content: [{ type: "text", text: "Hello from Kiro!" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "kiro-sess-42",
        result: "Hello from Kiro!",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 },
        total_cost_usd: 0.005,
      }),
    ].join("\n");

    const parsed = parseKiroJsonOutput(stdout);
    expect(parsed.sessionId).toBe("kiro-sess-42");
    expect(parsed.model).toBe("auto");
    expect(parsed.summary).toBe("Hello from Kiro!");
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBe(0.005);
    expect(parsed.resultJson).not.toBeNull();
  });

  it("handles plain text output from Kiro", () => {
    const stdout = "Hello from Kiro!\nI can help you with that.";
    const parsed = parseKiroJsonOutput(stdout);
    expect(parsed.summary).toBe("Hello from Kiro!\n\nI can help you with that.");
    expect(parsed.sessionId).toBeNull();
  });

  it("captures error messages", () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "authentication required" }),
    ].join("\n");

    const parsed = parseKiroJsonOutput(stdout);
    expect(parsed.errorMessage).toBe("authentication required");
  });
});

// ---------------------------------------------------------------------------
// Server: unknown session detection
// ---------------------------------------------------------------------------

describe("kiro_local stale session detection", () => {
  it("detects unknown session errors in stdout", () => {
    expect(isKiroUnknownSessionError("unknown session id abc-123", "")).toBe(true);
  });

  it("detects session not found in stderr", () => {
    expect(isKiroUnknownSessionError("", "Error: session abc not found")).toBe(true);
  });

  it("detects no conversation found", () => {
    expect(isKiroUnknownSessionError("no conversation found with session id abc", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isKiroUnknownSessionError('{"type":"result","result":"done"}', "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server: session codec
// ---------------------------------------------------------------------------

describe("kiro_local session codec", () => {
  it("normalizes session params with cwd", () => {
    const parsed = kiroSessionCodec.deserialize({
      session_id: "kiro-session-1",
      folder: "/tmp/workspace",
    });
    expect(parsed).toEqual({
      sessionId: "kiro-session-1",
      cwd: "/tmp/workspace",
    });

    const serialized = kiroSessionCodec.serialize(parsed);
    expect(serialized).toEqual({
      sessionId: "kiro-session-1",
      cwd: "/tmp/workspace",
    });
    expect(kiroSessionCodec.getDisplayId?.(serialized ?? null)).toBe("kiro-session-1");
  });

  it("handles sessionId field name", () => {
    const parsed = kiroSessionCodec.deserialize({
      sessionId: "kiro-session-2",
      cwd: "/tmp/kiro",
    });
    expect(parsed).toEqual({
      sessionId: "kiro-session-2",
      cwd: "/tmp/kiro",
    });
  });

  it("returns null for empty or invalid input", () => {
    expect(kiroSessionCodec.deserialize(null)).toBeNull();
    expect(kiroSessionCodec.deserialize({})).toBeNull();
    expect(kiroSessionCodec.deserialize({ sessionId: "" })).toBeNull();
    expect(kiroSessionCodec.serialize(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UI: parseKiroStdoutLine
// ---------------------------------------------------------------------------

describe("kiro_local ui stdout parser", () => {
  const ts = "2026-03-11T00:00:00.000Z";

  it("parses init events", () => {
    expect(
      parseKiroStdoutLine(
        JSON.stringify({ type: "system", subtype: "init", model: "auto", session_id: "sess-1" }),
        ts,
      ),
    ).toEqual([{ kind: "init", ts, model: "auto", sessionId: "sess-1" }]);
  });

  it("parses assistant text blocks", () => {
    expect(
      parseKiroStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello!" }] },
        }),
        ts,
      ),
    ).toEqual([{ kind: "assistant", ts, text: "Hello!" }]);
  });

  it("parses tool_use blocks", () => {
    expect(
      parseKiroStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", input: { path: "/tmp/test.ts" } }],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "tool_call", ts, name: "Read", input: { path: "/tmp/test.ts" } },
    ]);
  });

  it("parses error events", () => {
    expect(
      parseKiroStdoutLine(
        JSON.stringify({ type: "error", message: "login required" }),
        ts,
      ),
    ).toEqual([{ kind: "stderr", ts, text: "login required" }]);
  });

  it("parses result events with usage", () => {
    const result = parseKiroStdoutLine(
      JSON.stringify({
        type: "result",
        result: "Done.",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        total_cost_usd: 0.01,
        subtype: "success",
        is_error: false,
      }),
      ts,
    );
    expect(result).toEqual([
      {
        kind: "result",
        ts,
        text: "Done.",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        costUsd: 0.01,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("falls back to stdout for non-JSON lines", () => {
    expect(parseKiroStdoutLine("some plain text", ts)).toEqual([
      { kind: "stdout", ts, text: "some plain text" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// UI: buildKiroLocalConfig
// ---------------------------------------------------------------------------

describe("kiro_local config builder", () => {
  it("builds minimal config with defaults", () => {
    const config = buildKiroLocalConfig({
      adapterType: "kiro_local",
      cwd: "/tmp/project",
      promptTemplate: "",
      model: "",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: false,
      intervalSec: 0,
    });
    expect(config.cwd).toBe("/tmp/project");
    expect(config.trustAllTools).toBe(true);
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });

  it("includes model and prompt template when provided", () => {
    const config = buildKiroLocalConfig({
      adapterType: "kiro_local",
      cwd: "",
      promptTemplate: "Hello {{agent.name}}",
      model: "claude-opus-4-6",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "kiro-cli",
      args: "",
      extraArgs: "--verbose",
      envVars: "FOO=bar\nBAZ=qux",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: false,
      intervalSec: 0,
    });
    expect(config.promptTemplate).toBe("Hello {{agent.name}}");
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.command).toBe("kiro-cli");
    expect(config.extraArgs).toEqual(["--verbose"]);
    expect(config.env).toEqual({
      FOO: { type: "plain", value: "bar" },
      BAZ: { type: "plain", value: "qux" },
    });
  });
});

// ---------------------------------------------------------------------------
// CLI: printKiroStreamEvent
// ---------------------------------------------------------------------------

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("kiro_local cli formatter", () => {
  it("prints init, assistant, error, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printKiroStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", model: "auto", session_id: "sess-1" }),
        false,
      );
      printKiroStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello!" }] },
        }),
        false,
      );
      printKiroStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        }),
        false,
      );
      printKiroStreamEvent(
        JSON.stringify({ type: "error", message: "something went wrong" }),
        false,
      );
      printKiroStreamEvent(
        JSON.stringify({
          type: "result",
          result: "Done.",
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
          total_cost_usd: 0.005,
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(expect.arrayContaining([
        "Kiro initialized (model: auto, session: sess-1)",
        "assistant: Hello!",
        "tool_call: Bash",
        "error: something went wrong",
        "result:",
        "Done.",
        "tokens: in=100 out=50 cached=10 cost=$0.005000",
      ]));
    } finally {
      spy.mockRestore();
    }
  });

  it("suppresses unrecognized lines in non-debug mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printKiroStreamEvent(JSON.stringify({ type: "unknown_event" }), false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("shows unrecognized lines in debug mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printKiroStreamEvent(JSON.stringify({ type: "unknown_event" }), true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
