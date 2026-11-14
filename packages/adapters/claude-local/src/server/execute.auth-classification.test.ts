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

const POISONED_TOOL_OUTPUT = 'read config.json: { "rejectUnauthorized": true, "timeout": 30 }';

function buildProcResult(
  resultEvent: Record<string, unknown>,
  opts: { exitCode: number; extraStdout?: string },
) {
  const extraStdout = opts.extraStdout ?? "";
  return {
    exitCode: opts.exitCode,
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

function mockExecutionResult(result: Record<string, unknown>) {
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

describe("claude_local auth classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not seal claude_auth_required on a run the adapter classified as succeeded", async () => {
    mockExecutionResult(
      buildProcResult(
        { subtype: "success", is_error: false, result: "done" },
        { exitCode: 0, extraStdout: "the API replied 401 Unauthorized, retrying with a fresh client" },
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("does not seal claude_auth_required on an unrelated identifier in the transcript", async () => {
    mockExecutionResult(
      buildProcResult(
        { subtype: "success", is_error: false, result: "done" },
        { exitCode: 0, extraStdout: POISONED_TOOL_OUTPUT },
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("still reports claude_auth_required when the run fails on a real auth error", async () => {
    mockExecutionResult(
      buildProcResult(
        {
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          error: "authentication_failed",
          result: "Failed to authenticate. API Error: 401 Invalid bearer token",
        },
        { exitCode: 1 },
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("does not seal claude_auth_required on an unparsed run that exits zero", async () => {
    mockExecutionResult({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "checked the client config: rejectUnauthorized stays on, please run /login was only in the docs",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("still reports claude_auth_required when the CLI prints a login prompt and exits non-zero", async () => {
    mockExecutionResult({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Invalid API key · Please run /login",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});
