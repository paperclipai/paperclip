import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  execute,
  isCursorUnknownSessionError,
  parseCursorJsonl,
  sessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  parseCursorStdoutLine,
  buildCursorLocalConfig,
} from "@paperclipai/adapter-cursor-local/ui";
import { printCursorStreamEvent } from "@paperclipai/adapter-cursor-local/cli";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const capturedRunChildProcessArgs = vi.hoisted(() => ({
  args: null as string[] | null,
  opts: null as { cwd: string } | null,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...mod,
    runChildProcess: vi.fn().mockImplementation(
      async (_runId: string, _command: string, args: string[], _opts: { cwd: string }) => {
        capturedRunChildProcessArgs.args = args;
        capturedRunChildProcessArgs.opts = _opts;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"type":"result","result":"ok","session_id":"s1"}\n',
          stderr: "",
        };
      },
    ),
  };
});

describe("cursor_local parser", () => {
  it("extracts sessionId, summary, usage, and errorMessage from stream-json NDJSON", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-uuid-123",
        cwd: "/home/proj",
        model: "gpt-5.2",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess-uuid-123",
        result: "Done.",
        duration_ms: 1000,
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("sess-uuid-123");
    expect(parsed.summary).toBe("Done.");
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts session_id from system init when result has no session_id", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "init-only-uuid",
        cwd: "/tmp",
        model: "sonnet-4.5",
      }),
      JSON.stringify({ type: "result", result: "OK", duration_ms: 500 }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("init-only-uuid");
    expect(parsed.summary).toBe("OK");
  });

  it("prefers result.result as summary over accumulated assistant content", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        cwd: "/x",
        model: "gpt-5.2",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Partial" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "s1",
        result: "Final summary",
        duration_ms: 100,
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.summary).toBe("Final summary");
  });
});

describe("cursor_local stale session detection", () => {
  it("returns true for session not found style messages", () => {
    expect(isCursorUnknownSessionError("", "session not found")).toBe(true);
    expect(isCursorUnknownSessionError("", "unknown session")).toBe(true);
    expect(isCursorUnknownSessionError("error: invalid session", "")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCursorUnknownSessionError("", "network timeout")).toBe(false);
    expect(isCursorUnknownSessionError("", "API key invalid")).toBe(false);
  });
});

describe("cursor_local session codec", () => {
  it("round-trips valid raw with session_id and cwd", () => {
    const raw = { session_id: "sid-1", cwd: "/home/x" };
    const params = sessionCodec.deserialize(raw);
    expect(params).not.toBeNull();
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual({ session_id: "sid-1", cwd: "/home/x" });
  });

  it("accepts sessionId (camelCase) in raw", () => {
    const raw = { sessionId: "sid-2", cwd: "/tmp" };
    const params = sessionCodec.deserialize(raw);
    expect(params).not.toBeNull();
    expect(sessionCodec.serialize(params)).toMatchObject({ session_id: "sid-2" });
  });

  it("deserialize returns null for invalid input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize({ cwd: "/x" })).toBeNull();
  });

  it("getDisplayId returns short session id", () => {
    const params = { session_id: "sess-abc-123", cwd: "/x" };
    expect(sessionCodec.getDisplayId?.(params)).toBe("sess-abc-123");
  });
});

describe("cursor_local ui buildConfig", () => {
  it("buildCursorLocalConfig produces cwd, command, model, promptTemplate, outputFormat, timeoutSec, graceSec, force, trust", () => {
    const values: CreateConfigValues = {
      adapterType: "cursor_local",
      cwd: "/home/agent",
      instructionsFilePath: "/path/to/AGENTS.md",
      promptTemplate: "Hello {{agent.name}}",
      model: "gpt-5.2",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "agent",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: false,
      intervalSec: 0,
    };
    const config = buildCursorLocalConfig(values);
    expect(config.cwd).toBe("/home/agent");
    expect(config.command).toBe("agent");
    expect(config.model).toBe("gpt-5.2");
    expect(config.promptTemplate).toBe("Hello {{agent.name}}");
    expect(config.outputFormat).toBe("stream-json");
    expect(config.timeoutSec).toBeDefined();
    expect(config.graceSec).toBeDefined();
    expect(config.instructionsFilePath).toBe("/path/to/AGENTS.md");
    expect(typeof config.force).toBe("boolean");
    expect(typeof config.trust).toBe("boolean");
  });
});

describe("cursor_local ui stdout parser", () => {
  it("parses system init to init TranscriptEntry", () => {
    const ts = "2026-03-05T12:00:00.000Z";
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      cwd: "/proj",
      model: "gpt-5.2",
    });
    expect(parseCursorStdoutLine(line, ts)).toEqual([
      { kind: "init", ts, model: "gpt-5.2", sessionId: "sess-1" },
    ]);
  });

  it("parses user event to user TranscriptEntry", () => {
    const ts = "2026-03-05T12:00:01.000Z";
    const line = JSON.stringify({
      type: "user",
      message: "Run tests",
      session_id: "sess-1",
    });
    expect(parseCursorStdoutLine(line, ts)).toEqual([
      { kind: "user", ts, text: "Run tests" },
    ]);
  });

  it("parses assistant event to assistant TranscriptEntry", () => {
    const ts = "2026-03-05T12:00:02.000Z";
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Running tests..." }] },
    });
    expect(parseCursorStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "Running tests..." },
    ]);
  });

  it("parses tool_call to tool_call TranscriptEntry", () => {
    const ts = "2026-03-05T12:00:03.000Z";
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      readToolCall: { path: "/tmp/x" },
    });
    const entries = parseCursorStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_call");
    if (entries[0].kind === "tool_call") {
      expect(entries[0].ts).toBe(ts);
      expect(entries[0].name).toBeDefined();
      expect(entries[0].input).toBeDefined();
    }
  });

  it("parses result event to result TranscriptEntry", () => {
    const ts = "2026-03-05T12:00:10.000Z";
    const line = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "All tests passed.",
      duration_ms: 5000,
    });
    const entries = parseCursorStdoutLine(line, ts);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("result");
    if (entries[0].kind === "result") {
      expect(entries[0].ts).toBe(ts);
      expect(entries[0].text).toBe("All tests passed.");
    }
  });

  it("fallback to stdout for unknown event type", () => {
    const ts = "2026-03-05T12:00:00.000Z";
    const line = JSON.stringify({ type: "unknown_event", data: "x" });
    expect(parseCursorStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: line },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("cursor_local cli formatter", () => {
  it("prints init, assistant, tool_call, and result events with expected labels", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printCursorStreamEvent(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          cwd: "/proj",
          model: "gpt-5.2",
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
        false,
      );
      printCursorStreamEvent(
        JSON.stringify({
          type: "result",
          session_id: "s1",
          result: "Done",
          duration_ms: 100,
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines.some((l) => l.toLowerCase().includes("init") || l.includes("s1"))).toBe(true);
      expect(lines.some((l) => l.toLowerCase().includes("assistant") || l.includes("Hello"))).toBe(true);
      expect(lines.some((l) => l.toLowerCase().includes("result") || l.includes("Done"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cursor_local execute (skills injection)", () => {
  let testCursorHome: string;

  beforeAll(async () => {
    testCursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-home-test-"));
    process.env.CURSOR_HOME = testCursorHome;
  });

  afterAll(() => {
    delete process.env.CURSOR_HOME;
  });

  async function makeContext(overrides: {
    cwd?: string;
    onLog?: AdapterExecutionContext["onLog"];
  } = {}): Promise<AdapterExecutionContext> {
    const tempCwd = overrides.cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), "cursor-adapter-test-"));
    const onLog = overrides.onLog ?? vi.fn();
    return {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "cursor_local",
      },
      runtime: {
        sessionParams: {},
        sessionId: null,
      },
      config: {
        cwd: tempCwd,
        command: process.execPath,
        promptTemplate: "Continue",
        outputFormat: "stream-json",
      },
      context: {
        paperclipWorkspace: { cwd: tempCwd },
      },
      onLog,
      onMeta: undefined,
    };
  }

  function getWorkspaceFromCapturedArgs(): string | null {
    const args = capturedRunChildProcessArgs.args;
    if (!args) return null;
    const idx = args.indexOf("--workspace");
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1] ?? null;
  }

  it("execute runs with opts.cwd and --workspace both equal to resolved user config.cwd", async () => {
    const ctx = await makeContext();
    const resolvedCwd = path.resolve(ctx.config.cwd as string);
    await execute(ctx);
    expect(capturedRunChildProcessArgs.opts?.cwd).toBe(resolvedCwd);
    expect(getWorkspaceFromCapturedArgs()).toBe(resolvedCwd);
  });

  it("injects skills into CURSOR_HOME/skills and skill file exists after execute", async () => {
    const ctx = await makeContext();
    await execute(ctx);
    const skillPath = path.join(testCursorHome, "skills", "paperclip", "SKILL.md");
    const exists = await fs.stat(skillPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("original cwd does not contain .cursor or .agents after execute", async () => {
    const ctx = await makeContext();
    const cwd = path.resolve(ctx.config.cwd as string);
    await execute(ctx);
    const cursorInCwd = path.join(cwd, ".cursor");
    const agentsInCwd = path.join(cwd, ".agents");
    const hasCursor = await fs.stat(cursorInCwd).then(() => true).catch(() => false);
    const hasAgents = await fs.stat(agentsInCwd).then(() => true).catch(() => false);
    expect(hasCursor).toBe(false);
    expect(hasAgents).toBe(false);
  });

  it("onLog(stderr) was called with [paperclip] and injection message", async () => {
    const freshCursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-home-onlog-"));
    const prev = process.env.CURSOR_HOME;
    process.env.CURSOR_HOME = freshCursorHome;
    try {
      const onLog = vi.fn();
      const ctx = await makeContext({ onLog });
      await execute(ctx);
      const stderrCalls = (onLog as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, string]) => call[0] === "stderr",
      );
      const chunks = stderrCalls.map((call: [string, string]) => call[1]).join("");
      expect(chunks).toMatch(/\[paperclip\]/);
      expect(chunks).toMatch(/skill|injected|Injected/i);
    } finally {
      process.env.CURSOR_HOME = prev;
    }
  });
});
