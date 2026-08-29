import { beforeEach, describe, expect, it, vi } from "vitest";

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
    throw new Error("ACP unavailable in this test");
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: () => "[paperclip] falling back to CLI\n",
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
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

function assistantMessageEvent(sessionId: string, messageId: string, inputTokens: number, outputTokens: number) {
  return JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: messageId,
      content: [{ type: "tool_use", name: "Bash", input: {} }],
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: outputTokens,
      },
    },
  });
}

function streamResult(input: {
  sessionId: string;
  turns: number;
  finalUsage?: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
  subtype?: string;
  isError?: boolean;
}) {
  const { sessionId, turns, finalUsage, subtype = "error_max_turns", isError = true } = input;
  const lines: string[] = [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(assistantMessageEvent(sessionId, `msg-${i}`, 500, 20));
  }
  lines.push(
    JSON.stringify({
      type: "result",
      subtype,
      is_error: isError,
      session_id: sessionId,
      result: "",
      ...(finalUsage ? { usage: finalUsage } : {}),
    }),
  );
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: lines.join("\n"),
    stderr: "",
    pid: 456,
    startedAt: new Date().toISOString(),
  };
}

function buildContext(context: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context,
    onLog: vi.fn(async () => {}),
  };
}

// TSMC-21459: 21 overnight claude_local runs burned their 45-turn budget on
// error_max_turns with zero recorded token usage, making them invisible to
// the weighted token governor despite spending real, tracked tokens.
describe("claude_local usage accumulator on error_max_turns (TSMC-21459)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockReset();
  });

  it("returns the accumulated assistant-message usage instead of a zero-valued terminal usage", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      streamResult({ sessionId: "claude-session-1", turns: 45 }),
    );

    const result: any = await execute(buildContext({}) as any);

    expect(result.usage).toEqual({ inputTokens: 45 * 500, cachedInputTokens: 0, outputTokens: 45 * 20 });
  });

  it("still prefers a real non-zero terminal usage ledger over the accumulator", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      streamResult({
        sessionId: "claude-session-2",
        turns: 2,
        finalUsage: { input_tokens: 9999, cache_read_input_tokens: 0, output_tokens: 123 },
      }),
    );

    const result: any = await execute(buildContext({}) as any);

    expect(result.usage.inputTokens).toBe(9999);
    expect(result.usage.outputTokens).toBe(123);
  });
});
