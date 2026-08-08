import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function successProcess(sessionId = "claude-session-1") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: sessionId,
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function overloadedProcess() {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr:
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    pid: 124,
    startedAt: new Date().toISOString(),
  };
}

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  procQueue,
  envSnapshots,
} = vi.hoisted(() => {
  const procQueue: Array<Record<string, unknown>> = [];
  const envSnapshots: Array<{ baseUrl?: string; apiKey?: string }> = [];
  const runAdapterExecutionTargetProcess = vi.fn(
    async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      opts: { env?: Record<string, string> },
    ) => {
      envSnapshots.push({
        baseUrl: opts?.env?.ANTHROPIC_BASE_URL,
        apiKey: opts?.env?.ANTHROPIC_API_KEY,
      });
      const next = procQueue.shift();
      if (!next) throw new Error("execute.openrouter-fallback.test: no queued process result");
      return next;
    },
  );
  return {
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
    procQueue,
    envSnapshots,
  };
});

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(async () => {
    throw new Error("acp should not be used in these tests");
  }),
  formatClaudeAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  // Force the CLI engine so these tests exercise runAttempt directly.
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
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

let fetchMock: ReturnType<typeof vi.fn>;

function buildContext(config: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { engine: "cli", ...config },
    context,
    authToken: "pc-test-key",
    onLog: vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {}),
  };
}

function loggedWith(ctx: ReturnType<typeof buildContext>, needle: string): boolean {
  return ctx.onLog.mock.calls.some(([, chunk]) => typeof chunk === "string" && chunk.includes(needle));
}

describe("claude_local OpenRouter 529 fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    procQueue.length = 0;
    envSnapshots.length = 0;
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "http://127.0.0.1:4310");
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:4310");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("retries on OpenRouter after a 529, completes, alerts the Founder, and persists the flag", async () => {
    procQueue.push(overloadedProcess(), successProcess());
    const ctx = buildContext({ openrouterApiKey: "or-test-key" }, { taskId: "issue-xyz" });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorFamily ?? null).toBeNull();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    // First attempt on Anthropic, retry on OpenRouter.
    expect(envSnapshots[0].baseUrl).toBeUndefined();
    expect(envSnapshots[1].baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(envSnapshots[1].apiKey).toBe("or-test-key");
    expect(loggedWith(ctx, "Anthropic 529 detected; retrying via OpenRouter fallback")).toBe(true);

    // Founder alert comment + config persistence.
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain("http://127.0.0.1:4310/api/issues/issue-xyz/comments");
    expect(urls).toContain("http://127.0.0.1:4310/api/agents/agent-1");
    const patchCall = fetchMock.mock.calls.find(([url]) => url === "http://127.0.0.1:4310/api/agents/agent-1");
    expect(patchCall?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({
      adapterConfig: { openrouterFallbackActive: true },
    });
  });

  it("leaves transient_upstream unchanged when no OpenRouter key is available", async () => {
    procQueue.push(overloadedProcess());
    const ctx = buildContext({}, { taskId: "issue-xyz" });

    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(loggedWith(ctx, "retrying via OpenRouter fallback")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts on OpenRouter from the first attempt when openrouterFallbackActive is set", async () => {
    procQueue.push(successProcess());
    const ctx = buildContext({ openrouterApiKey: "or-test-key", openrouterFallbackActive: true });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(envSnapshots[0].baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(envSnapshots[0].apiKey).toBe("or-test-key");
    expect(loggedWith(ctx, "starting this turn on the OpenRouter endpoint")).toBe(true);
    // No fallback event on a clean OpenRouter start → no Founder alert.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not persist the flag or claim completion when the OpenRouter retry also fails", async () => {
    // 529 on Anthropic, then the OpenRouter retry itself fails (e.g. bad model id).
    procQueue.push(overloadedProcess(), overloadedProcess());
    const ctx = buildContext({ openrouterApiKey: "or-test-key" }, { taskId: "issue-xyz" });

    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    // The retry was attempted on OpenRouter...
    expect(envSnapshots[1].baseUrl).toBe(OPENROUTER_BASE_URL);
    // ...but it failed, so we return the failed result and do NOT alert/persist.
    expect(result.errorFamily).toBe("transient_upstream");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedWith(ctx, "did not succeed")).toBe(true);
  });

  it("does not loop when a 529 recurs while already on OpenRouter", async () => {
    procQueue.push(overloadedProcess());
    const ctx = buildContext(
      { openrouterApiKey: "or-test-key", openrouterFallbackActive: true },
      { taskId: "issue-xyz" },
    );

    const result = await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(loggedWith(ctx, "retrying via OpenRouter fallback")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
