import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

const modelUsage = (cost: number, input: number, output: number) => ({
  "claude-sonnet": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost },
});

function procResult(cost: number, input: number, output: number, timedOut: boolean) {
  return {
    exitCode: timedOut ? null : 0,
    signal: timedOut ? "SIGTERM" : null,
    timedOut,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: "done",
        total_cost_usd: cost,
        modelUsage: modelUsage(cost, input, output),
      }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof procResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, timedOut: false, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function resumedContext(sessionParams: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId, sessionParams, sessionDisplayId: sessionId, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local resumed session usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stored = {
    sessionId,
    usageTotals: { sessionId, totalCostUsd: 1, modelUsage: modelUsage(1, 1000, 100) },
  };

  it("moves the stored totals forward when a resumed run times out after its result", async () => {
    mockExecutionResult(procResult(2, 2000, 300, true));

    const result = await execute(resumedContext(stored) as never);

    expect(result.timedOut).toBe(true);
    expect(result.costUsd).toBeCloseTo(1, 6);
    expect(result.sessionParams).toEqual({
      ...stored,
      usageTotals: { sessionId, totalCostUsd: 2, modelUsage: modelUsage(2, 2000, 300) },
    });
  });

  it("keeps a legacy session id when a run resumed without session params times out", async () => {
    mockExecutionResult(procResult(2, 2000, 300, true));

    const result = await execute(resumedContext(null as never) as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionParams).toEqual({
      sessionId,
      usageTotals: { sessionId, totalCostUsd: 2, modelUsage: modelUsage(2, 2000, 300) },
    });
  });

  it("leaves session params alone when a timed-out run printed no result", async () => {
    mockExecutionResult({
      ...procResult(2, 2000, 300, true),
      stdout: JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
    });

    const result = await execute(resumedContext(stored) as never);

    expect(result.timedOut).toBe(true);
    expect(result.sessionParams).toBeUndefined();
  });
});
