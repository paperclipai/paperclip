import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
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

function buildContext(config: Record<string, unknown> = {}) {
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
    config: { model: "claude-opus-5", ...config },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  // AGE-807: a heartbeat wake on an append-only monitor thread (AGE-741) must
  // not grow the process launch past the OS argv+env limit. The wake context —
  // including the full comment history — travels in the prompt over stdin,
  // never on argv and never through the retired PAPERCLIP_WAKE_PAYLOAD_JSON env
  // entry, so a multi-megabyte thread still spawns without `E2BIG`.
  it("keeps a multi-megabyte AGE-741 wake history off argv and env (no spawn E2BIG)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:4310");
    const marker = "monitor-digest-entry";
    // ~64 KB per comment x 64 comments ~= 4 MB of history: well past the Linux
    // per-arg (128 KB) and total argv+env (~2 MB) process-launch limits.
    const hugeBody = `${marker} `.repeat(3_200);
    const comments = Array.from({ length: 64 }, (_, index) => ({
      id: `comment-${index}`,
      body: `${hugeBody}#${index}`,
      authorType: "user" as const,
      authorId: "user-1",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
      deleted: false,
      sourceTrust: "human" as const,
    }));
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });
    ctx.context = {
      paperclipWake: {
        reason: "issue_commented",
        issue: {
          id: "issue-741",
          identifier: "AGE-741",
          title: "MHA client monitoring thread",
          description: hugeBody,
          status: "in_progress",
          workMode: "standard",
        },
        comments,
        commentWindow: {
          requestedCount: comments.length,
          includedCount: comments.length,
          missingCount: 0,
        },
        fallbackFetchNeeded: false,
      },
    } as Record<string, unknown>;

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const [, , , args, options] = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string[],
      { stdin?: string; env: Record<string, string> },
    ];

    // The prompt that carries the wake context is delivered over stdin, and it
    // genuinely carries this wake (not an empty prompt) — the issue identifier
    // survives even when the oversized bodies are trimmed.
    expect(typeof options.stdin).toBe("string");
    expect(options.stdin).toContain("AGE-741");

    // No argv entry and no env value carries the multi-megabyte history.
    expect(args.some((arg) => arg.includes(marker))).toBe(false);
    expect(Object.values(options.env).some((value) => value.includes(marker))).toBe(false);

    // The retired env transport must never reappear.
    expect(options.env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");

    // argv + env stay far under the OS process-launch ceiling no matter how long
    // the monitor thread grows — this is what prevents `spawn E2BIG`.
    const argvBytes = Buffer.byteLength(args.join("\u0000"), "utf8");
    const envBytes = Object.entries(options.env).reduce(
      (total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`, "utf8") + 1,
      0,
    );
    expect(argvBytes + envBytes).toBeLessThan(256 * 1024);
  });
});
