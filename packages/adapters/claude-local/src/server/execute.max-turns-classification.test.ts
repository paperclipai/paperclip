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

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
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

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
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

  it("keeps max_turns_exhausted when stdout mentions Unauthorized in tool output", async () => {
    mockExecutionResult(
      buildProcResult(
        { is_error: true, subtype: "error_max_turns" },
        'assert response.json() == {"error": "Unauthorized"}',
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports claude_auth_required when the CLI result asks to log in", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "success",
        result: "Not logged in · Please run /login",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("still reports claude_auth_required when only stderr asks to log in", async () => {
    mockExecutionResult({
      ...buildProcResult({ is_error: true, subtype: "error_during_execution" }),
      stderr: "Not logged in · Please run /login",
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("keeps max_turns_exhausted when the max-turns result itself mentions Unauthorized", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_max_turns",
        result: "Stopped; last tool said Unauthorized",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("keeps max_turns_exhausted when the max-turns result errors carry a login prompt", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_max_turns",
        errors: ["Not logged in · Please run /login"],
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("keeps max_turns_exhausted when the max-turns result carries a token failure marker", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_max_turns",
        errors: ["authentication_error: invalid bearer token"],
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("does not report claude_auth_required for a successful run that mentions 401 Unauthorized", async () => {
    mockExecutionResult({
      ...buildProcResult({
        is_error: false,
        subtype: "success",
        result: "The endpoint returns 401 Unauthorized when the token is missing.",
      }),
      exitCode: 0,
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("reports claude_auth_required when only raw stdout asks to log in and no result was parsed", async () => {
    mockExecutionResult({
      ...buildProcResult({ is_error: true }),
      stdout: "Not logged in · Please run /login",
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });
});
