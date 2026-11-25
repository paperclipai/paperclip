import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
  type RunProcessResult,
  type TerminalResultCleanupEvidence,
} from "@paperclipai/adapter-utils/server-utils";

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

const SESSION_ID = "51b8a66f-49cc-43e7-8b79-0d57b61b984a";

function buildCleanup(
  overrides: Partial<TerminalResultCleanupEvidence> = {},
): TerminalResultCleanupEvidence {
  return {
    kind: "terminal_result_cleanup",
    stopped: true,
    stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
    reason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
    terminalResultSeen: true,
    signal: "SIGTERM",
    forceKilled: false,
    ...overrides,
  };
}

function buildResultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    session_id: SESSION_ID,
    num_turns: 55,
    total_cost_usd: 3.5697056,
    result: "Waiting for background test run completion before editing.",
    usage: {
      input_tokens: 108,
      cache_creation_input_tokens: 189040,
      cache_read_input_tokens: 8278968,
      output_tokens: 20058,
    },
    modelUsage: {
      "claude-sonnet-4-5": {
        inputTokens: 108,
        outputTokens: 20058,
        cacheReadInputTokens: 8278968,
        cacheCreationInputTokens: 189040,
        costUSD: 3.5697056,
      },
    },
    subagent_stats: {
      spawned: 0,
    },
    ...overrides,
  };
}

function buildPostResultReapStdout(resultOverrides: Record<string, unknown> = {}): string {
  const events = [
    {
      type: "system",
      subtype: "init",
      cwd: "/workspace/project",
      session_id: SESSION_ID,
      model: "claude-sonnet-4-5",
      claude_code_version: "2.1.330",
    },
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "bg-task-1",
          run_id: "bg-run-1",
          task_type: "local_bash",
          description: "Run test suite",
        },
      ],
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "task_updated",
      task_id: "bg-task-1",
      run_id: "bg-run-1",
      patch: { is_backgrounded: true },
      session_id: SESSION_ID,
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_bg_1",
            type: "tool_result",
            content: "Command did not complete within its 600s timeout and was moved to the background (ID: bg-task-1).",
            is_error: false,
          },
        ],
      },
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "bg-monitor-1",
      run_id: "bg-run-2",
      description: "Wait for background test run completion",
      is_backgrounded: true,
      task_type: "local_bash",
      session_id: SESSION_ID,
    },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-5",
        id: "msg_final_1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Waiting for background test run completion before editing.",
          },
        ],
      },
      session_id: SESSION_ID,
    },
    buildResultEvent(resultOverrides),
    {
      type: "system",
      subtype: "task_notification",
      task_id: "bg-task-1",
      status: "stopped",
      summary: "Run test suite",
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "bg-monitor-1",
      status: "stopped",
      summary: "Wait for background test run completion",
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "task_updated",
      task_id: "bg-monitor-1",
      patch: { status: "killed" },
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "task_updated",
      task_id: "bg-task-1",
      patch: { status: "killed" },
      session_id: SESSION_ID,
    },
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      session_id: SESSION_ID,
    },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function buildProc(overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 143,
    signal: null,
    timedOut: false,
    stdout: buildPostResultReapStdout(),
    stderr: "",
    pid: 4321,
    startedAt: "2026-11-22T01:08:43.315Z",
    terminalResultCleanup: buildCleanup(),
    ...overrides,
  };
}

function mockExecutionResult(result: RunProcessResult) {
  runAdapterExecutionTargetProcess.mockImplementation(
    async (_runId: string, _target: unknown, _command: string, args: string[]) =>
      args.includes("--version")
        ? { ...result, exitCode: 0, signal: null, timedOut: false, stdout: "2.1.330 (Claude Code)", terminalResultCleanup: null }
        : result,
  );
}

function buildContext(sessionId: string | null = null) {
  return {
    runId: "run-post-result-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Engineer",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId,
      sessionParams: sessionId ? { sessionId, cwd: process.cwd() } : null,
      sessionDisplayId: sessionId,
      taskKey: "task-1",
    },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local post-result terminalResultCleanup classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies trapped SIGTERM exit 143 after clean end_turn as unmanaged_background_task_stopped while preserving session, usage, cost, and summary without retrying", async () => {
    const cleanup = buildCleanup({ signal: "SIGTERM", forceKilled: false });
    mockExecutionResult(buildProc({ exitCode: 143, signal: null, terminalResultCleanup: cleanup }));

    const result = await execute(buildContext(SESSION_ID) as never);

    expect(result.exitCode).toBe(143);
    expect(result.signal).toBeNull();
    expect(result.errorCode).toBe(UNMANAGED_BACKGROUND_TASK_STOP_REASON);
    expect(result.errorMessage).toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
    expect(result.resultJson?.unmanagedBackgroundTask).toEqual(cleanup);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams?.sessionId).toBe(SESSION_ID);
    expect(result.costUsd).toBe(3.5697056);
    expect(result.usage?.outputTokens).toBe(20058);
    expect(result.summary).toContain("Waiting for background test run completion");
    expect(result.clearSession).toBe(false);
    const cliInvocations = runAdapterExecutionTargetProcess.mock.calls.filter(
      (call) => !(call[3] as string[]).includes("--version"),
    );
    expect(cliInvocations).toHaveLength(1);
  });

  it("classifies untrapped SIGTERM after clean end_turn as unmanaged_background_task_stopped", async () => {
    mockExecutionResult(
      buildProc({
        exitCode: null,
        signal: "SIGTERM",
        terminalResultCleanup: buildCleanup({ signal: "SIGTERM", forceKilled: false }),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorCode).toBe(UNMANAGED_BACKGROUND_TASK_STOP_REASON);
    expect(result.errorMessage).toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
  });

  it.each([
    { label: "untrapped SIGKILL", exitCode: null, signal: "SIGKILL" as const },
    { label: "exit code 137", exitCode: 137, signal: null },
    { label: "parent exited 143 on SIGTERM before child SIGKILL escalation", exitCode: 143, signal: null },
    { label: "parent died on SIGTERM before child SIGKILL escalation", exitCode: null, signal: "SIGTERM" as const },
  ])("classifies force-killed SIGKILL escalation ($label) as unmanaged_background_task_stopped", async ({ exitCode, signal }) => {
    const cleanup = buildCleanup({ signal: "SIGKILL", forceKilled: true });
    mockExecutionResult(buildProc({ exitCode, signal, terminalResultCleanup: cleanup }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe(UNMANAGED_BACKGROUND_TASK_STOP_REASON);
    expect(result.errorMessage).toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
    expect(result.resultJson?.unmanagedBackgroundTask).toEqual(cleanup);
  });

  it.each([
    { label: "SIGKILL without forceKilled", exitCode: null, signal: "SIGKILL" as const, forceKilled: false },
    { label: "exit 143 with SIGKILL without forceKilled", exitCode: 143, signal: null, forceKilled: false },
    { label: "crash exit 1 with forceKilled SIGKILL", exitCode: 1, signal: null, forceKilled: true },
    { label: "crash exit 139 with forceKilled SIGKILL", exitCode: 139, signal: null, forceKilled: true },
  ])("fails closed on invalid SIGKILL escalation combination ($label)", async ({ exitCode, signal, forceKilled }) => {
    mockExecutionResult(
      buildProc({
        exitCode,
        signal,
        terminalResultCleanup: buildCleanup({ signal: "SIGKILL", forceKilled }),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("fails closed on external SIGTERM without terminalResultCleanup evidence", async () => {
    mockExecutionResult(buildProc({ exitCode: 143, signal: null, terminalResultCleanup: null }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("preserves timeout classification when proc.timedOut is true", async () => {
    mockExecutionResult(buildProc({ exitCode: 143, signal: null, timedOut: true, terminalResultCleanup: buildCleanup() }));

    const result = await execute(buildContext() as never);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toMatch(/^Timed out after \d+s$/);
  });

  it.each([
    {
      label: "stream without result event",
      stdout: `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "assistant", partial: true })}\n`,
    },
    {
      label: "truncated trailing JSON",
      stdout: `${JSON.stringify({ type: "assistant", partial: true })}\n{"type":"result","subtype":"suc`,
    },
  ])("fails closed on unparsed output ($label) even when terminalResultCleanup is set", async ({ stdout }) => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout,
        stderr: "process terminated",
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toContain("Claude exited with code 143");
    expect(result.errorMessage).not.toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
  });

  it.each([
    {
      label: "is_error true with success subtype",
      overrides: { subtype: "success", is_error: true, result: "Tool execution failed" },
      expectedCode: null,
    },
    {
      label: "error_during_execution",
      overrides: { subtype: "error_during_execution", is_error: false, result: "Runtime crash" },
      expectedCode: null,
    },
    {
      label: "error_max_turns",
      overrides: { subtype: "error_max_turns", is_error: true, result: "Reached max turns" },
      expectedCode: "max_turns_exhausted",
    },
  ])("retains failure classification for error result ($label) even with terminalResultCleanup", async ({ overrides, expectedCode }) => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout: `${JSON.stringify(buildResultEvent(overrides))}\n`,
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe(expectedCode);
    expect(result.errorCode).not.toBe(UNMANAGED_BACKGROUND_TASK_STOP_REASON);
    expect(result.errorMessage).toContain("Claude run failed");
    expect(result.errorMessage).not.toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
  });

  it("retains claude_refusal and avoids setting unmanaged_background_task_stopped errorMessage on policy refusal", async () => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout: `${JSON.stringify(buildResultEvent({ subtype: "success", is_error: false, stop_reason: "refusal", result: "I cannot comply." }))}\n`,
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_refusal");
    expect(result.errorFamily).toBe("model_refusal");
    expect(result.errorMessage).toBeNull();
  });

  it.each(["max_tokens", "tool_use"])("fails closed for non-end_turn stop_reason %s", async (stopReason) => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout: `${JSON.stringify(buildResultEvent({ subtype: "success", is_error: false, stop_reason: stopReason }))}\n`,
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("treats missing stop_reason on a clean success result as eligible for cleanup classification", async () => {
    const event = buildResultEvent({ subtype: "success", is_error: false });
    delete event.stop_reason;
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout: `${JSON.stringify(event)}\n`,
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe(UNMANAGED_BACKGROUND_TASK_STOP_REASON);
    expect(result.errorMessage).toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
  });

  it("gives proc.errorCode precedence and keeps errorMessage null on duplex_channel_lost", async () => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        errorCode: "duplex_channel_lost",
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("duplex_channel_lost");
    expect(result.errorMessage).toBeNull();
  });

  it("gives auth failure precedence and keeps failure errorMessage when login is required", async () => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stdout: `${JSON.stringify(buildResultEvent({ subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" }))}\n`,
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMessage).toContain("Not logged in");
    expect(result.errorMessage).not.toBe(UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
  });

  it("keeps errorMessage null when loginRequired triggers on a clean success stdout alongside cleanup", async () => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        stderr: "Please run /login to continue",
        terminalResultCleanup: buildCleanup(),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMessage).toBeNull();
  });

  it.each([1, 139])("fails closed when process exits with non-matching crash code %i during cleanup", async (crashCode) => {
    mockExecutionResult(
      buildProc({
        exitCode: crashCode,
        signal: null,
        terminalResultCleanup: buildCleanup({ signal: "SIGTERM", forceKilled: false }),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it.each([
    { label: "wrong kind", overrides: { kind: "other_cleanup" as unknown as "terminal_result_cleanup" } },
    { label: "stopped false", overrides: { stopped: false as unknown as true } },
    { label: "terminalResultSeen false", overrides: { terminalResultSeen: false } },
  ])("fails closed when cleanup provenance is invalid ($label)", async ({ overrides }) => {
    mockExecutionResult(
      buildProc({
        exitCode: 143,
        signal: null,
        terminalResultCleanup: buildCleanup(overrides),
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });
});
