import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to Claude CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Claude ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("returns a typed no-recovery result when live CLI message usage reaches the cap", async () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      uuid: "event-cap",
      session_id: "claude-session-cap",
      message: {
        id: "msg-cap",
        content: [{ type: "text", text: "working" }],
        usage: {
          input_tokens: 95_000,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 90_000,
          output_tokens: 1,
        },
      },
    });
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onLog("stdout", `${assistantEvent}\n`);
      return {
        exitCode: 143,
        signal: null,
        timedOut: false,
        stdout: assistantEvent,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });
    const ctx = buildContext({ maxTokensPerRun: 100_000 });

    const result = await execute(ctx as never);

    // Budget-weighted (TSMC-20840): 95_001 fresh + 1 out + 0.1 * 90_000 cached
    // = 104_002 >= 100_000.
    expect(result).toMatchObject({
      errorCode: "token_budget_exhausted",
      clearSession: true,
      usage: {
        inputTokens: 95_001,
        cachedInputTokens: 90_000,
        outputTokens: 1,
      },
      resultJson: {
        stopReason: "token_budget_exhausted",
        maxTokensPerRun: 100_000,
        observedTokens: 104_002,
      },
    });
  });

  it("does not exhaust the budget on a cache-read-heavy multi-turn run (TSMC-20840)", async () => {
    // The Kestrel shape: ~28K fresh input, ~360K cache reads, ~5K output.
    // Full-weight accounting charged this 393K; weighted it is ~69K.
    const assistantEvent = JSON.stringify({
      type: "assistant",
      uuid: "event-cache-heavy",
      session_id: "claude-session-cache-heavy",
      message: {
        id: "msg-cache-heavy",
        content: [{ type: "text", text: "report written" }],
        usage: {
          input_tokens: 28_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 360_000,
          output_tokens: 5_000,
        },
      },
    });
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onLog("stdout", `${assistantEvent}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: assistantEvent,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });
    const ctx = buildContext({ maxTokensPerRun: 100_000 });

    const result = await execute(ctx as never);

    expect(result.errorCode).not.toBe("token_budget_exhausted");
  });

  it("stops before a tool call when the next context-bearing turn cannot fit", async () => {
    const firstMessage = {
      type: "assistant",
      uuid: "event-1",
      message: {
        id: "msg-1",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 20_000,
          cache_read_input_tokens: 30_000,
          output_tokens: 10,
        },
      },
    };
    const secondMessage = {
      type: "assistant",
      uuid: "event-2",
      message: {
        id: "msg-2",
        content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: {} }],
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 20_000,
          output_tokens: 10,
        },
      },
    };
    const stdout = [JSON.stringify(firstMessage), JSON.stringify(secondMessage)].join("\n");
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onLog("stdout", `${stdout}\n`);
      return {
        exitCode: 143,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    const result = await execute(buildContext({ maxTokensPerRun: 40_000 }) as never);

    // Budget-weighted (TSMC-20840): observed = (20_001 + 10_001 fresh) + 20 out
    // + 0.1 * 50_000 cached = 35_022; weighted next-turn projection from msg-2
    // = 10_001 + 0.1 * 20_000 = 12_001; 35_022 + 12_001 >= 40_000.
    expect(result).toMatchObject({
      errorCode: "token_budget_exhausted",
      clearSession: true,
      resultJson: {
        stopReason: "token_budget_exhausted",
        maxTokensPerRun: 40_000,
        observedTokens: 35_022,
        predictedNextTurnTokens: 12_001,
      },
    });
  });
});
