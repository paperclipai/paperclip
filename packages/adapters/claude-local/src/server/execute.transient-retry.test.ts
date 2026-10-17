import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Helpers to build mock stdout payloads
// ---------------------------------------------------------------------------

function buildSuccessStdout(sessionId = "s-ok"): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
    JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: "done", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
  ].join("\n");
}

function buildTransientProc(message = "Claude.ai is currently overloaded"): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: message,
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function buildSuccessProc(sessionId = "s-ok"): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: buildSuccessStdout(sessionId),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function buildAuthErrorProc(): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "Invalid API key · Please run /login",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function buildProviderQuotaProc(): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "You've hit your usage limit for this session.",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function buildTimedOutProc(): RunProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted runs before imports)
// ---------------------------------------------------------------------------

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  executeClaudeAcp,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async (): Promise<RunProcessResult> => buildSuccessProc()),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error("ACP not available in transient retry tests");
  }),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (r: string) => r,
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: false }),
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildCtx(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      // Zero-delay so tests don't wait for real backoff timers.
      transientRetryBaseDelayMs: 0,
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claude_local transient upstream retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries on transient overloaded error and returns success on the second attempt", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(buildTransientProc("Claude.ai is currently overloaded"))
      .mockResolvedValueOnce(buildSuccessProc());

    const ctx = buildCtx();
    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect(result.errorCode ?? null).toBeNull();
  });

  it("retries on 429 rate-limit and surfaces the last error when all retries exhausted", async () => {
    const transient = buildTransientProc("Too many requests — rate limit exceeded (HTTP 429)");
    runAdapterExecutionTargetProcess.mockResolvedValue(transient);

    const ctx = buildCtx({ transientRetryMaxAttempts: 2 });
    const result = await execute(ctx as never);

    // 1 initial + 2 retries = 3 total
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("logs a retry message for each transient retry attempt", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(buildTransientProc("service unavailable (503)"))
      .mockResolvedValueOnce(buildSuccessProc());

    const ctx = buildCtx();
    await execute(ctx as never);

    const logged = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => String((args as unknown[])[1] ?? ""))
      .filter((msg) => msg.includes("Transient upstream error"));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/attempt 1\/2/);
  });

  it("does NOT retry when transientRetryMaxAttempts is 0", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(buildTransientProc("overloaded_error"));

    const ctx = buildCtx({ transientRetryMaxAttempts: 0 });
    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_transient_upstream");
  });

  it("does NOT retry auth errors (claude_auth_required)", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(buildAuthErrorProc());

    const ctx = buildCtx();
    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry provider quota errors (spend limit)", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(buildProviderQuotaProc());

    const ctx = buildCtx();
    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("provider_quota");
  });

  it("does NOT retry timed-out runs", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(buildTimedOutProc());

    const ctx = buildCtx();
    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(true);
  });

  it("passes the default 2 retries when transientRetryMaxAttempts is not configured", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      buildTransientProc("service unavailable"),
    );

    const ctx = buildCtx();
    // Remove explicit setting so the default applies.
    delete (ctx.config as Record<string, unknown>).transientRetryMaxAttempts;

    await execute(ctx as never);

    // 1 initial + 2 default retries = 3 total
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
  });

  it("uses the session id from the failed attempt's init event on retry (maintains conversation)", async () => {
    const transientWithSession: RunProcessResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ type: "system", subtype: "init", session_id: "s-partial", model: "claude-sonnet" }),
      stderr: "service unavailable",
      pid: 123,
      startedAt: new Date().toISOString(),
    };

    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(transientWithSession)
      .mockResolvedValueOnce(buildSuccessProc("s-partial"));

    const ctx = buildCtx({ transientRetryMaxAttempts: 1 });
    await execute(ctx as never);

    // The second call should have passed --resume s-partial.
    // runAdapterExecutionTargetProcess(runId, target, command, args, opts)
    // so args are at index [3].
    const retryCall = runAdapterExecutionTargetProcess.mock.calls[1] as unknown as unknown[];
    const retryArgs = (retryCall?.[3] ?? []) as string[];
    const resumeIdx = retryArgs.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(retryArgs[resumeIdx + 1]).toBe("s-partial");
  });
});
