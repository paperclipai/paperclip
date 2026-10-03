import { beforeEach, describe, expect, it, vi } from "vitest";

const successStream = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
  JSON.stringify({
    type: "assistant",
    session_id: "claude-session-1",
    message: { content: [{ type: "text", text: "done" }] },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-session-1",
    result: "done",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  }),
].join("\n");

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  formatClaudeAcpFallbackMessage: (reason: string) => reason,
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

function buildContext() {
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
    config: {},
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

function procResult(extra: Record<string, unknown>) {
  return {
    exitCode: 143,
    signal: null,
    timedOut: false,
    stdout: successStream,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("claude_local terminal-result cleanup exit code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not report the harness's own cleanup SIGTERM as an adapter failure", async () => {
    // The cleanup fires only after the turn's terminal result is already on the
    // wire: the CLI is still held open by an unmanaged background task, so
    // Paperclip SIGTERMs the process group and the CLI exits 143. That code is
    // ours, not the CLI's — reporting it verbatim makes the heartbeat record a
    // completed turn as `failed` with the default "Adapter failed" message, and
    // the issue is then pushed to `blocked` by terminal run recovery.
    runAdapterExecutionTargetProcess.mockResolvedValue(
      procResult({
        terminalResultCleanup: {
          kind: "terminal_result_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
          terminalResultSeen: true,
          signal: "SIGTERM",
          forceKilled: false,
        },
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.resultJson).toMatchObject({
      unmanagedBackgroundTask: { stopReason: "unmanaged_background_task_stopped" },
    });
  });

  it("treats a force-killed cleanup the same way", async () => {
    // SIGKILL after the grace period only means the leftover background task
    // ignored SIGTERM. Both signals land after the terminal result was parsed,
    // so the turn is no less complete than in the SIGTERM case.
    runAdapterExecutionTargetProcess.mockResolvedValue(
      procResult({
        exitCode: 137,
        terminalResultCleanup: {
          kind: "terminal_result_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
          terminalResultSeen: true,
          signal: "SIGKILL",
          forceKilled: true,
        },
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage ?? null).toBeNull();
  });

  it("still reports a non-zero exit code when the cleanup did not stop the run", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(procResult({ terminalResultCleanup: null }));

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(143);
  });
});
