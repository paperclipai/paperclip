import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  execute,
  isAgyTurnLimitResult,
  isAgyUnknownSessionError,
  parseAgyOutput,
  detectAgyQuotaExhausted,
  detectAgyAuthRequired,
  parseAgyResetDurationMs,
  sessionCodec,
  testEnvironment,
} from "@paperclipai/adapter-agy-local/server";
import { DEFAULT_AGY_LOCAL_MODEL, models } from "@paperclipai/adapter-agy-local";
import { parseAgyStdoutLine, buildAgyLocalConfig } from "@paperclipai/adapter-agy-local/ui";
import { printAgyStreamEvent } from "@paperclipai/adapter-agy-local/cli";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";

describe("agy_local parser", () => {
  it("extracts session, summary, and terminal error message from text output", () => {
    const stdout = [
      "Antigravity CLI init (session: 45127642-4fab-4b98-9928-dc5527f2222a)",
      "Checking codebase...",
      "Done with task.",
    ].join("\n");
    const stderr = "Warning: low API budget";

    const parsed = parseAgyOutput(stdout, stderr);
    expect(parsed.sessionId).toBe("45127642-4fab-4b98-9928-dc5527f2222a");
    expect(parsed.summary).toContain("Done with task.");
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts session from fallback uuid in text", () => {
    const stdout = "Traversed workspace for conversation 36fb199d-4706-4eb4-ad46-653e9db5af2a";
    const parsed = parseAgyOutput(stdout, "");
    expect(parsed.sessionId).toBe("36fb199d-4706-4eb4-ad46-653e9db5af2a");
  });

  it("extracts session, summary, usage, and cost from JSON events", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "77777777-7777-4777-8777-777777777777" }),
      JSON.stringify({ type: "assistant", text: "Finished analysis." }),
      JSON.stringify({
        type: "result",
        stats: {
          input_tokens: 1500,
          output_tokens: 250,
          cached_input_tokens: 500,
          total_cost_usd: 0.0042,
        },
      }),
    ].join("\n");

    const parsed = parseAgyOutput(stdout, "");
    expect(parsed.sessionId).toBe("77777777-7777-4777-8777-777777777777");
    expect(parsed.summary).toBe("Finished analysis.");
    expect(parsed.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 250,
      cachedInputTokens: 500,
    });
    expect(parsed.costUsd).toBe(0.0042);
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts errors from stderr", () => {
    const stdout = "Antigravity CLI output";
    const stderr = "Error: Anthropic API key is invalid";
    const parsed = parseAgyOutput(stdout, stderr);
    expect(parsed.errorMessage).toBe("Error: Anthropic API key is invalid");
  });
});

describe("agy_local stale session detection", () => {
  it("treats missing session messages as an unknown session error", () => {
    expect(isAgyUnknownSessionError("", "unknown conversation abc")).toBe(true);
    expect(isAgyUnknownSessionError("", "conversation not found")).toBe(true);
    expect(isAgyUnknownSessionError("", "unknown session")).toBe(true);
    expect(isAgyUnknownSessionError("", "session not found")).toBe(true);
    expect(isAgyUnknownSessionError("", "failed to resume")).toBe(true);
    expect(isAgyUnknownSessionError("", "cannot resume")).toBe(true);
    expect(isAgyUnknownSessionError("", "no conversation found")).toBe(true);
  });

  it("does not false-positive on normal output", () => {
    expect(isAgyUnknownSessionError("Checked files successfully", "")).toBe(false);
  });
});

describe("agy_local turn-limit detection", () => {
  it("detects structured turn-limit signals and exit code 53", () => {
    expect(isAgyTurnLimitResult("turn_limit_exhausted", "")).toBe(true);
    expect(isAgyTurnLimitResult("max_turns_exhausted", "")).toBe(true);
    expect(isAgyTurnLimitResult("", "", 53)).toBe(true);
    expect(isAgyTurnLimitResult("completed task", "", 0)).toBe(false);
  });
});

describe("agy_local quota detection", () => {
  it("detects individual quota reached message and computes retryNotBefore", () => {
    const before = Date.now();
    const result = detectAgyQuotaExhausted({
      stdout: "",
      stderr: "Individual quota reached. Contact your administrator to enable overages. Resets in 4h3m21s.",
    });
    expect(result.exhausted).toBe(true);
    expect(result.resetHint).toMatch(/resets?\s+in/i);
    expect(result.retryNotBefore).not.toBeNull();
    const retryMs = new Date(result.retryNotBefore!).getTime();
    const expectedMs = before + (4 * 3600 + 3 * 60 + 21 + 60) * 1000;
    expect(retryMs).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(retryMs).toBeLessThanOrEqual(expectedMs + 5000);
  });

  it("detects resource_exhausted, 429, and rate-limit errors", () => {
    expect(detectAgyQuotaExhausted({ stdout: "resource_exhausted", stderr: "" }).exhausted).toBe(true);
    expect(detectAgyQuotaExhausted({ stdout: "", stderr: "rate limit exceeded" }).exhausted).toBe(true);
    expect(detectAgyQuotaExhausted({ stdout: "", stderr: "429 Too Many Requests" }).exhausted).toBe(true);
  });

  it("does not flag normal output as quota exhausted", () => {
    const r = detectAgyQuotaExhausted({ stdout: "Task completed successfully", stderr: "" });
    expect(r.exhausted).toBe(false);
    expect(r.retryNotBefore).toBeNull();
  });

  it("parseAgyResetDurationMs handles mixed durations", () => {
    expect(parseAgyResetDurationMs("4h3m21s")).toBe((4 * 3600 + 3 * 60 + 21) * 1000);
    expect(parseAgyResetDurationMs("30m")).toBe(30 * 60 * 1000);
    expect(parseAgyResetDurationMs("90s")).toBe(90 * 1000);
    expect(parseAgyResetDurationMs("2h")).toBe(2 * 3600 * 1000);
    expect(parseAgyResetDurationMs("")).toBeNull();
  });
});

describe("agy_local auth required detection", () => {
  it("detects unauthenticated states", () => {
    expect(detectAgyAuthRequired({ stdout: "", stderr: "Authentication required. Sign in through the AGY account flow." }).requiresAuth).toBe(true);
    expect(detectAgyAuthRequired({ stdout: "Not logged in", stderr: "" }).requiresAuth).toBe(true);
    expect(detectAgyAuthRequired({ stdout: "Success", stderr: "" }).requiresAuth).toBe(false);
  });
});

describe("agy_local session codec", () => {
  it("round trips session parameters", () => {
    const params = {
      sessionId: "12345678-1234-4234-8234-123456789abc",
      cwd: "/workspace/project",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/org/repo",
      repoRef: "main",
      remoteExecution: { driver: "ssh", target: "dev-box" },
      cumulativeUsage: { inputTokens: 1200, outputTokens: 120, cachedInputTokens: 60 },
    };

    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);

    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(params);

    expect(sessionCodec.getDisplayId?.(serialized)).toBe("12345678-1234-4234-8234-123456789abc");
  });

  it("returns null for invalid session parameters", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.serialize({})).toBeNull();
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});

describe("agy_local ui stdout parser", () => {
  it("parses assistant message, init, tool_call, tool_result, and raw text", () => {
    const ts = "2026-09-28T12:00:00.000Z";

    expect(
      parseAgyStdoutLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          sessionId: "sess-1",
          model: "gemini-3.8-flash-high",
        }),
        ts,
      ),
    ).toEqual([
      { kind: "init", ts, model: "gemini-3.8-flash-high", sessionId: "sess-1" },
    ]);

    expect(
      parseAgyStdoutLine(
        JSON.stringify({
          type: "assistant",
          text: "I checked the repo.",
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I checked the repo." },
    ]);

    expect(
      parseAgyStdoutLine(
        JSON.stringify({
          type: "tool_call",
          name: "view_file",
          input: { AbsolutePath: "/foo/bar" },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "view_file",
        input: { AbsolutePath: "/foo/bar" },
      },
    ]);

    expect(
      parseAgyStdoutLine(
        JSON.stringify({
          type: "tool_result",
          toolUseId: "call-1",
          content: "file content",
          isError: false,
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "call-1",
        content: "file content",
        isError: false,
      },
    ]);

    expect(
      parseAgyStdoutLine("raw text line", ts),
    ).toEqual([
      { kind: "stdout", ts, text: "raw text line" },
    ]);
  });
});

describe("agy_local ui build config", () => {
  it("builds adapterConfig with defaults and canonical model", () => {
    const config = buildAgyLocalConfig({
      cwd: "/repo",
      model: "gemini-3.8-flash-high",
      instructionsFilePath: "/repo/AGENTS.md",
      command: "agy",
      extraArgs: "--verbose, --timeout=60",
      envVars: "FOO=BAR\nBAZ=QUX",
      dangerouslyBypassSandbox: true,
    });

    expect(config.cwd).toBe("/repo");
    expect(config.model).toBe("gemini-3.8-flash-high");
    expect(config.instructionsFilePath).toBe("/repo/AGENTS.md");
    expect(config.command).toBe("agy");
    expect(config.extraArgs).toEqual(["--verbose", "--timeout=60"]);
    expect(config.sandbox).toBe(false);
    expect(config.env).toEqual({
      FOO: { type: "plain", value: "BAR" },
      BAZ: { type: "plain", value: "QUX" },
    });
  });

  it("defaults model to DEFAULT_AGY_LOCAL_MODEL when empty", () => {
    const config = buildAgyLocalConfig({});
    expect(config.model).toBe(DEFAULT_AGY_LOCAL_MODEL);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("agy_local cli formatter", () => {
  it("prints stream events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printAgyStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", sessionId: "45127642-4fab-4b98-9928-dc5527f2222a" }),
        false,
      );
      printAgyStreamEvent(
        JSON.stringify({
          type: "assistant",
          text: "hello",
        }),
        false,
      );
      printAgyStreamEvent("plain stdout text", false);
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Antigravity CLI init");
    expect(joined).toContain("assistant: hello");
    expect(joined).toContain("plain stdout text");
  });
});

describe("agy_local models catalog", () => {
  it("includes canonical model IDs such as gemini-3.8-flash-high", () => {
    const modelIds = models.map((m) => m.id);
    expect(modelIds).toContain("auto");
    expect(modelIds).toContain("gemini-3.8-flash-high");
    expect(modelIds).toContain("gemini-3.8-flash-medium");
    expect(modelIds).toContain("gemini-3.8-flash-low");
    expect(modelIds).toContain("gemini-3.7-flash-high");
    expect(modelIds).toContain("gemini-3.1-pro-high");
    expect(modelIds).toContain("claude-sonnet-4-6");
  });
});

describe("agy_local execute argument construction & session retry", () => {
  let commandResolvableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    commandResolvableSpy = vi
      .spyOn(executionTarget, "ensureAdapterExecutionTargetCommandResolvable")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    commandResolvableSpy?.mockRestore();
  });

  it("omits --model when auto is configured and leaves permission skipping disabled by default", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Antigravity CLI init (session: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)\nDone",
      stderr: "",
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
      config: {
        command: "agy",
        model: "auto",
        cwd: process.cwd(),
      },
      context: {},
      onLog: vi.fn(),
    });

    expect(runProcessSpy).toHaveBeenCalled();
    const callArgs = runProcessSpy.mock.calls[0][3];
    expect(callArgs).not.toContain("--dangerously-skip-permissions");
    expect(callArgs).toContain("--input-format");
    expect(callArgs[callArgs.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(callArgs).not.toContain("--print");
    expect(callArgs).not.toContain("--model");
    const processOptions = runProcessSpy.mock.calls[0][4];
    const stdinMessage = JSON.parse(processOptions.stdin?.trim() ?? "{}") as {
      event?: string;
      message?: { content?: string };
    };
    expect(stdinMessage).toMatchObject({
      event: "user",
      message: { content: expect.stringMatching(/^\/goal\s/) },
    });
    expect(result.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    runProcessSpy.mockRestore();
  });

  it("injects granted runtime MCP servers for the AGY process and removes them after the run", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-runtime-mcp-execute-"));
    const configPath = path.join(cwd, ".agents", "mcp_config.json");
    let configDuringRun: Record<string, unknown> | null = null;
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Done",
      stderr: "",
    });

    try {
      await execute({
        runId: "run-runtime-mcp",
        agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
        config: { command: "agy", model: "auto", cwd, promptTemplate: "Use the GitHub server and get_me." },
        context: {},
        runtimeMcp: {
          getServers: () => [
            {
              name: "GitHub",
              url: "http://127.0.0.1:3100/api/mcp/runtime-tools",
              token: "test-run-token",
              connectionId: "github-connection",
            },
          ],
        },
        onLog: vi.fn(),
        onMeta: async () => {
          configDuringRun = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
        },
      });

      expect(configDuringRun).toMatchObject({
        mcpServers: {
          GitHub: {
            serverUrl: "http://127.0.0.1:3100/api/mcp/runtime-tools",
            headers: { Authorization: "Bearer test-run-token" },
          },
        },
      });
      const processOptions = runProcessSpy.mock.calls[0][4];
      const stdinMessage = JSON.parse(processOptions.stdin?.trim() ?? "{}") as {
        message?: { content?: string };
      };
      expect(stdinMessage.message?.content).toContain(
        "inspect the tool definitions exposed for the Paperclip assigned-tools gateway",
      );
      expect(stdinMessage.message?.content).toContain(
        "If the task refers to a `github` server or raw upstream names such as `get_me`",
      );
      expect(stdinMessage.message?.content).toContain(
        "provider actions are on the assigned-tools gateway",
      );
      expect(stdinMessage.message?.content).toContain(
        "Run-scoped gateway credentials permit only the MCP methods `tools/list` and `tools/call`",
      );
      expect(stdinMessage.message?.content).toContain(
        "do not call `resources/list`, `resources/read`, `prompts/list`, or `prompts/get`",
      );
      expect(stdinMessage.message?.content.indexOf("Use the GitHub server and get_me.")).toBeLessThan(
        stdinMessage.message?.content.indexOf("Paperclip runtime clarification:"),
      );
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      runProcessSpy.mockRestore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("passes --dangerously-skip-permissions only when explicitly configured", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Done",
      stderr: "",
    });

    await execute({
      runId: "run-skip-permissions",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
      config: {
        command: "agy",
        model: "auto",
        cwd: process.cwd(),
        dangerouslySkipPermissions: true,
      },
      context: {},
      onLog: vi.fn(),
    });

    const callArgs = runProcessSpy.mock.calls[0][3];
    expect(callArgs).toContain("--dangerously-skip-permissions");
    runProcessSpy.mockRestore();
  });

  it("normalizes packed legacy flags without bypassing the typed permission setting", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Done",
      stderr: "",
    });

    await execute({
      runId: "run-goal-prefix",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
      config: {
        command: "agy",
        model: "auto",
        cwd: process.cwd(),
        promptTemplate: "/goal Continue the assigned task.",
        extraArgs: ["--dangerously-skip-permissions --goal", "--example-flag"],
      },
      context: {},
      onLog: vi.fn(),
    });

    const callArgs = runProcessSpy.mock.calls[0][3];
    expect(callArgs).not.toContain("--goal");
    expect(callArgs).not.toContain("--dangerously-skip-permissions");
    expect(callArgs).toContain("--example-flag");
    const processOptions = runProcessSpy.mock.calls[0][4];
    const stdinMessage = JSON.parse(processOptions.stdin?.trim() ?? "{}") as {
      message?: { content?: string };
    };
    expect(stdinMessage.message?.content).toMatch(/^\/goal\s/);
    expect(stdinMessage.message?.content?.match(/\/goal/g)).toHaveLength(1);

    runProcessSpy.mockRestore();
  });

  it("passes canonical model unchanged when specified", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Done",
      stderr: "",
    });

    await execute({
      runId: "run-2",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
      config: {
        command: "agy",
        model: "gemini-3.8-flash-high",
        cwd: process.cwd(),
      },
      context: {},
      onLog: vi.fn(),
    });

    expect(runProcessSpy).toHaveBeenCalled();
    const callArgs = runProcessSpy.mock.calls[0][3];
    const modelIndex = callArgs.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(callArgs[modelIndex + 1]).toBe("gemini-3.8-flash-high");

    runProcessSpy.mockRestore();
  });

  it("resumes with --conversation when matching session exists", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Resumed",
      stderr: "",
    });

    await execute({
      runId: "run-3",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: {
        sessionId: "sess-resumed",
        sessionParams: { sessionId: "sess-resumed", cwd: process.cwd() },
        sessionDisplayId: "sess-resumed",
      },
      config: {
        cwd: process.cwd(),
      },
      context: {},
      onLog: vi.fn(),
    });

    expect(runProcessSpy).toHaveBeenCalled();
    const callArgs = runProcessSpy.mock.calls[0][3];
    const convIndex = callArgs.indexOf("--conversation");
    expect(convIndex).toBeGreaterThanOrEqual(0);
    expect(callArgs[convIndex + 1]).toBe("sess-resumed");

    runProcessSpy.mockRestore();
  });

  it("retries with a fresh session when unknown session error occurs, setting clearSession: true", async () => {
    let attempt = 0;
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "Error: unknown conversation sess-stale",
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Started fresh conversation 99999999-9999-4999-8999-999999999999\nDone",
        stderr: "",
      };
    });

    const onLog = vi.fn();
    const result = await execute({
      runId: "run-4",
      agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
      runtime: {
        sessionId: "sess-stale",
        sessionParams: { sessionId: "sess-stale", cwd: process.cwd() },
        sessionDisplayId: "sess-stale",
      },
      config: {
        cwd: process.cwd(),
      },
      context: {},
      onLog,
    });

    expect(runProcessSpy).toHaveBeenCalledTimes(2);
    // First attempt resumed with --conversation sess-stale
    expect(runProcessSpy.mock.calls[0][3]).toContain("--conversation");
    // Second attempt had no --conversation
    expect(runProcessSpy.mock.calls[1][3]).not.toContain("--conversation");
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining('resume session "sess-stale" is unavailable; retrying with a fresh session'),
    );
    expect(commandResolvableSpy).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);

    runProcessSpy.mockRestore();
  });

  it("fails execution when command is not resolvable", async () => {
    commandResolvableSpy.mockRejectedValueOnce(new Error('Command not found in PATH: "agy"'));

    await expect(
      execute({
        runId: "run-unresolvable",
        agent: { id: "a1", companyId: "c1", name: "Agent", adapterType: "agy_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
        config: {
          command: "agy",
          cwd: process.cwd(),
        },
        context: {},
        onLog: vi.fn(),
      }),
    ).rejects.toThrow('Command not found in PATH: "agy"');
  });
});

describe("agy_local testEnvironment", () => {
  let commandResolvableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    commandResolvableSpy = vi
      .spyOn(executionTarget, "ensureAdapterExecutionTargetCommandResolvable")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    commandResolvableSpy?.mockRestore();
  });

  it("probes help without model generation and returns auth guidance", async () => {
    const runProcessSpy = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Usage of agy:\n  --help",
      stderr: "",
    });

    const result = await testEnvironment({
      companyId: "c1",
      adapterType: "agy_local",
      config: { command: "agy", cwd: process.cwd() },
    });

    expect(result.status).toBe("pass");
    expect(runProcessSpy).toHaveBeenCalled();
    // Probed with ["help"], not a prompt or generation
    expect(runProcessSpy.mock.calls[0][3]).toEqual(["help"]);

    expect(commandResolvableSpy).toHaveBeenCalled();
    // Contains the explicit auth guidance check
    const authGuidance = result.checks.find((c) => c.code === "agy_auth_preflight_guidance");
    expect(authGuidance).toBeDefined();
    expect(authGuidance?.level).toBe("info");
    expect(authGuidance?.message).toContain("verifies CLI installation and command execution only");

    runProcessSpy.mockRestore();
  });

  it("fails environment check when agy command is not resolvable", async () => {
    commandResolvableSpy.mockRejectedValueOnce(new Error('Command not found in PATH: "agy"'));

    const result = await testEnvironment({
      companyId: "c1",
      adapterType: "agy_local",
      config: { command: "agy", cwd: process.cwd() },
    });

    expect(result.status).toBe("fail");
    const unresolvableCheck = result.checks.find((c) => c.code === "agy_command_unresolvable");
    expect(unresolvableCheck).toBeDefined();
    expect(unresolvableCheck?.level).toBe("error");
    expect(unresolvableCheck?.message).toContain('Command not found in PATH: "agy"');
  });
});
