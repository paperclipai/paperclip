import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

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

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = ""): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: RunProcessResult) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

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
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local failure classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps max_turns_exhausted when stdout mentions model_not_found", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });

  it.each([
    "The page says login required for guests.",
    "Login test: authentication failed, the bearer token is invalid as expected.",
  ])("keeps a max-turns stop when its summary quotes auth prose: %s", async (summary) => {
    mockExecutionResult(buildProcResult({ subtype: "error_max_turns", is_error: true, result: summary }));
    const result = await execute(buildContext() as never);
    expect(result.errorCode).toBe("max_turns_exhausted");
    expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted", result: summary });
    expect(result.clearSession).toBe(true);
  });

  it.each([
    { api_error_status: 401 },
    { error: "authentication_failed" },
    { errors: ["Invalid bearer token"] },
  ])("keeps genuine provider auth evidence ahead of a max-turns stop: %j", async (evidence) => {
    mockExecutionResult(buildProcResult({ subtype: "error_max_turns", is_error: true, ...evidence }));
    const result = await execute(buildContext() as never);
    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("keeps a plain CLI login diagnostic ahead of a max-turns stop", async () => {
    mockExecutionResult({
      ...buildProcResult({ subtype: "error_max_turns", is_error: true }),
      stderr: "Invalid API key · Please run /login",
    });
    const result = await execute(buildContext() as never);
    expect(result.errorCode).toBe("claude_auth_required");
  });

  const cleanup: NonNullable<RunProcessResult["terminalResultCleanup"]> = {
    kind: "terminal_result_cleanup",
    stopped: true,
    stopReason: "unmanaged_background_task_stopped",
    reason: "unmanaged background task stopped; no durable live path",
    terminalResultSeen: true,
    signal: "SIGTERM",
    forceKilled: false,
  };

  it.each([
    { exitCode: 143, signal: null, forceKilled: false },
    { exitCode: null, signal: "SIGTERM", forceKilled: false },
    { exitCode: null, signal: "SIGKILL", forceKilled: true },
  ] as const)("does not turn transcript auth prose into an auth error during cleanup: %j", async (stop) => {
    const terminalResultCleanup = { ...cleanup, signal: stop.signal ?? "SIGTERM", forceKilled: stop.forceKilled };
    mockExecutionResult({
      ...buildProcResult({ subtype: "success", is_error: false, result: "Snapshot refresh is still running." },
        "PhoneAuth rejects (unauthorized, reason identity_mismatch) an unexpected OTP identity."),
      exitCode: stop.exitCode,
      signal: stop.signal,
      terminalResultCleanup,
    });

    const result = await execute(buildContext() as never);

    expect(result).toMatchObject({
      exitCode: stop.exitCode,
      signal: stop.signal,
      errorCode: null,
      resultJson: { unmanagedBackgroundTask: terminalResultCleanup },
    });
    expect(result.resultJson).not.toHaveProperty("stopReason", cleanup.stopReason);
  });

  it("does not infer cleanup from exit 143 without cleanup evidence", async () => {
    mockExecutionResult({ ...buildProcResult({ subtype: "success", is_error: false }), exitCode: 143 });
    const result = await execute(buildContext() as never);
    expect(result.exitCode).toBe(143);
    expect(result.errorCode).toBeNull();
    expect(result.resultJson).not.toHaveProperty("stopReason");
  });

  it("preserves genuine provider authentication failure over background cleanup", async () => {
    mockExecutionResult({
      ...buildProcResult({ subtype: "success", is_error: true, api_error_status: 401, result: "Invalid bearer token" }),
      terminalResultCleanup: cleanup,
    });
    const result = await execute(buildContext() as never);
    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.resultJson).not.toHaveProperty("stopReason", cleanup.stopReason);
  });

  it("does not replace an unclassified provider failure with cleanup", async () => {
    mockExecutionResult({
      ...buildProcResult({ subtype: "error", is_error: true, result: "Unknown provider failure" }),
      terminalResultCleanup: cleanup,
    });
    const result = await execute(buildContext() as never);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toContain("Unknown provider failure");
    expect(result.resultJson).not.toHaveProperty("stopReason", cleanup.stopReason);
  });
});
