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

// Tool output the agent itself printed while reading an HTTP client config.
// It carries a phrase the login-prompt detector scans the raw stdout for, but
// the provider never asked anybody to log in.
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
    // The CLI reported `subtype: "success"` with `is_error: false`, so the run
    // did not fail. A login marker scanned out of the agent's own stdout must
    // not override that, because a non-null errorCode suppresses the
    // server-side reclassification of an otherwise-clean run.
    runAdapterExecutionTargetProcess.mockResolvedValue(
      buildProcResult(
        { subtype: "success", is_error: false, result: "done" },
        { exitCode: 0, extraStdout: "the API replied 401 Unauthorized, retrying with a fresh client" },
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("does not seal claude_auth_required on an unrelated identifier in the transcript", async () => {
    // `rejectUnauthorized` is an ordinary TLS option name that an agent reads
    // out of an HTTP client config. It shares a substring with a login marker
    // and nothing else. The gate holds whatever the detector decides.
    runAdapterExecutionTargetProcess.mockResolvedValue(
      buildProcResult(
        { subtype: "success", is_error: false, result: "done" },
        { exitCode: 0, extraStdout: POISONED_TOOL_OUTPUT },
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("still reports claude_auth_required when the run fails on a real auth error", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
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

  it("still reports claude_auth_required when the CLI prints a login prompt and exits non-zero", async () => {
    // No parsed result event at all: the unparsed path, gated on the exit code.
    runAdapterExecutionTargetProcess.mockResolvedValue({
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
