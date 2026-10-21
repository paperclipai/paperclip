import { describe, expect, it, vi, afterEach } from "vitest";

const { runAdapterExecutionTargetProcess, ensureAdapterExecutionTargetCommandResolvable, executeClaudeAcp } = vi.hoisted(() => ({
  // The CLI command probe must not depend on a real `claude` binary in PATH:
  // CI runners do not install one (workspaces-b, PR #16440).
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error("ACP lane must not run in this test");
  }),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

// Newer bases probe `claude --version` through the same process runner before
// the main run (minimum-CLI-version gate); older bases call it once for the
// main run. Dispatch on argv so the same fixture passes on both: the probe
// gets a satisfying version, the main run gets the test's fixture. The gate
// itself is not under test here. (Upstream workspaces-b, PR #16440: without
// this the probe consumed the main-run fixture and every test failed with
// claude_cli_version_incompatible.)
function mockCliRun(mainResult: Record<string, unknown>) {
  runAdapterExecutionTargetProcess.mockImplementation((async (...call: unknown[]) => {
    const argv = call[3];
    if (Array.isArray(argv) && argv.includes("--version")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "2.1.999 (Claude Code)\n",
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      } as never;
    }
    return mainResult as never;
  }) as never);
}

function buildContext() {
  return {
    runId: "run-f5fa47c8",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude QA",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { engine: "cli", command: "claude" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

// Shape grounded on host evidence for run f5fa47c8 (TOG-25165): the CLI
// emitted a terminal result event with subtype=success, is_error=false,
// stop_reason=end_turn and no api error, after ~1.79M input tokens of real
// work. The runner then SIGTERMed the lingering process during
// teardown/finalization (exit 143). Pre-fix the adapter reported
// errorCode=claude_auth_required and the heartbeat marked the completed run
// failed, triggering retries.
function successStdoutWithAuthProse() {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-f5fa47c8",
    model: "claude-sonnet",
  });
  const assistant = JSON.stringify({
    type: "assistant",
    session_id: "sess-f5fa47c8",
    message: {
      content: [
        {
          type: "text",
          // Benign prose that trips the broad legacy login-prompt matcher
          // ("unauthorized"). A parsed success must stay authoritative over it.
          text: "Checked the endpoint handling; the probe returned unauthorized once, then succeeded on retry.",
        },
      ],
    },
  });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    api_error_status: null,
    session_id: "sess-f5fa47c8",
    result: "QA pass complete.",
    usage: {
      input_tokens: 1790000,
      cache_read_input_tokens: 0,
      output_tokens: 1200,
    },
    total_cost_usd: 4.2,
    model: "claude-sonnet",
  });
  return [init, assistant, result].join("\n");
}

describe("claude CLI teardown kill after success (TOG-25014)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("records success with a teardown warning instead of an auth failure on exit 143 after a success result", async () => {
    mockCliRun({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: false,
      stdout: successStdoutWithAuthProse(),
      stderr: "",
      pid: 456,
      startedAt: new Date().toISOString(),
      terminalResultCleanup: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task",
        reason: "terminal result seen; stopping lingering process",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    // Normalized so the heartbeat outcome seam (exit 0 + no signal + no
    // error) records success instead of "Adapter failed".
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    const resultJson = (result.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.subtype).toBe("success");
    expect(resultJson.teardownWarning).toMatchObject({
      kind: "teardown_kill_after_success",
      exitCode: 143,
      signal: "SIGTERM",
    });
    expect(resultJson.unmanagedBackgroundTask).toMatchObject({ stopped: true });
  });

  it("keeps a lost duplex channel as a transport failure despite a parsed success", async () => {
    mockCliRun({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: successStdoutWithAuthProse(),
      stderr: "",
      pid: 456,
      startedAt: new Date().toISOString(),
      errorCode: "duplex_channel_lost",
      errorMessage: "control channel closed before clean completion",
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("duplex_channel_lost");
    expect(result.exitCode).toBe(1);
  });

  it("keeps a lost duplex channel as a failure when the teardown kill also fired", async () => {
    // CLI emitted success, the duplex channel was lost (exit 1 + typed
    // error), AND the terminal-result cleanup kill fired. Pre-fix the
    // teardown normalization rewrote exit 1 -> 0, and the heartbeat outcome
    // seam (exit 0 + no errorMessage + no signal, errorCode ignored)
    // recorded a clean success, dropping the preserved duplex code.
    mockCliRun({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: successStdoutWithAuthProse(),
      stderr: "",
      pid: 456,
      startedAt: new Date().toISOString(),
      errorCode: "duplex_channel_lost",
      errorMessage: "control channel closed before clean completion",
      terminalResultCleanup: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task",
        reason: "terminal result seen; stopping lingering process",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("duplex_channel_lost");
    // The real exit is preserved (not normalized to 0), so the heartbeat
    // records failed instead of a clean success. errorMessage stays null
    // (parsed success is not a CLI failure); the exit code alone carries it.
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBeNull();
    expect(result.signal).toBeNull();
    // The kill evidence is still recorded alongside the failure.
    const resultJson = (result.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.teardownWarning).toMatchObject({
      kind: "teardown_kill_after_success",
      exitCode: 1,
      signal: null,
    });
  });

  it("still classifies a genuine 401 bearer-token failure as auth required", async () => {
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-auth",
      model: "claude-sonnet",
    });
    const resultEvent = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      error: "authentication_failed",
      session_id: "sess-auth",
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    });
    mockCliRun({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: [init, resultEvent].join("\n"),
      stderr: "",
      pid: 789,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});
