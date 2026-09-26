import { beforeEach, describe, expect, it, vi } from "vitest";

// Paperclip stops a process itself once it has seen the CLI's terminal result line
// (`runWithTerminalResultCleanup`), so an unmanaged background task cannot outlive the run. The process then
// exits 143 with a good result already parsed. The adapter knew that and discarded it, so the server judged the
// run on `exitCode` alone and recorded our own cleanup as an adapter failure.
//
// Measured on one board over 200 runs: 26 completed runs recorded `failed`/`adapter_failed`/exit 143, every one
// carrying subtype "success", is_error false and unmanagedBackgroundTask.terminalResultSeen true. Because
// `adapter_failed` is in TRANSIENT_INFRA_CONTINUATION_ERROR_CODES, recovery then re-ran work that had finished.
const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  formatClaudeAcpFallbackMessage: () => "",
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

const resultLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s-1",
    result: "the work is done",
    total_cost_usd: 1.4,
    usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
    ...over,
  });

const proc = (over: Record<string, unknown> = {}) => ({
  exitCode: 143,
  signal: null,
  timedOut: false,
  stdout: resultLine(),
  stderr: "",
  pid: 1,
  startedAt: new Date().toISOString(),
  terminalResultCleanup: {
    kind: "terminal_result_cleanup",
    stopped: true,
    stopReason: "unmanaged_background_task_stopped",
    reason: "unmanaged background task stopped; no durable live path",
    terminalResultSeen: true,
    signal: "SIGTERM",
    forceKilled: false,
  },
  ...over,
});

const ctx = () => ({
  runId: "run-1",
  agent: { id: "a-1", companyId: "c-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config: { engine: "cli" },
  context: {},
  onLog: vi.fn(async () => {}),
});

describe("claude_local: our own terminal-result cleanup is not the run's failure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags a success we stopped ourselves, and keeps exitCode/signal truthful", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(proc());
    const r = await execute(ctx() as never);
    expect(r.stoppedAfterTerminalResult).toBe(true);
    expect(r.exitCode).toBe(143);          // forensics survive: the fix is not to fake a zero
    expect(r.errorCode ?? null).toBeNull();
    expect(r.resultJson?.unmanagedBackgroundTask).toMatchObject({ terminalResultSeen: true });
  });

  it("does NOT flag a run that genuinely failed, even when cleanup also fired", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      proc({ stdout: resultLine({ subtype: "error_during_execution", is_error: true }) }),
    );
    const r = await execute(ctx() as never);
    expect(r.stoppedAfterTerminalResult).toBeUndefined();
  });

  it("does NOT flag a non-zero exit with no cleanup — an ordinary failure stays a failure", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(proc({ exitCode: 1, terminalResultCleanup: null }));
    const r = await execute(ctx() as never);
    expect(r.stoppedAfterTerminalResult).toBeUndefined();
  });

  it("leaves a clean exit alone — the flag is only for a non-zero exit we caused", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(proc({ exitCode: 0, terminalResultCleanup: null }));
    const r = await execute(ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stoppedAfterTerminalResult).toBeUndefined();
  });
});
