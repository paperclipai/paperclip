import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeGeminiAcp,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => {
  const runAdapterExecutionTargetProcess = vi.fn(
    async (_runId: string, _target: unknown, _command: string, _args: string[]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ event: "init", conversation_id: "agy-conv-1", init: { cwd: "C:\\ws" } }),
        JSON.stringify({
          event: "step_update",
          step_update: { conversation_id: "agy-conv-1", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "AGY-READY" },
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "agy-conv-1",
            status: "SUCCESS",
            response: "AGY-READY",
            usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, total_tokens: 110 },
          },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    }),
  );
  return {
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    executeGeminiAcp: vi.fn(async () => {
      throw new Error("ACP not used in cli lane");
    }),
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "agy"),
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("./acp.js", () => ({
  createGeminiAcpExecutor: () => executeGeminiAcp,
  formatGeminiAcpFallbackMessage: (reason: string) =>
    `[paperclip] Gemini ACP default unavailable; falling back to Gemini CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveGeminiExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) => {
    // Mirrors acp.ts: cliCompat="agy" pins the CLI lane unless engine=acp.
    const cliCompat = typeof ctx.config.cliCompat === "string" ? ctx.config.cliCompat.trim().toLowerCase() : "";
    const rawEngine = typeof ctx.config.engine === "string" ? ctx.config.engine.trim().toLowerCase() : "";
    if (cliCompat === "agy" && rawEngine !== "acp") return { engine: "cli", explicit: true };
    if (ctx.config.engine === "cli") return { engine: "cli", explicit: true };
    if (ctx.config.engine === "acp") return { engine: "acp", explicit: true };
    return { engine: "acp", explicit: false };
  },
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

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Antigravity Coder",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...runtime,
    },
    config: {
      engine: "cli",
      env: {},
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("gemini_local cliCompat=agy CLI lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits agy flags and parses agy stream-json output", async () => {
    const ctx = buildContext({ cliCompat: "agy", command: "agy" });

    const result = await execute(ctx as never);

    expect(executeGeminiAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    const [, , , args] = vi.mocked(runAdapterExecutionTargetProcess).mock.calls[0] as unknown as [unknown, unknown, unknown, string[]];
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--prompt");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("yolo");
    expect(args.some((arg) => String(arg).startsWith("--sandbox"))).toBe(false);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("AGY-READY");
    expect(result.sessionId).toBe("agy-conv-1");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it("maps session resume to --conversation in agy mode", async () => {
    const ctx = buildContext(
      { cliCompat: "agy", command: "agy" },
      { sessionId: "agy-conv-9", sessionParams: { cwd: process.cwd() } },
    );

    await execute(ctx as never);

    const [, , , args] = vi.mocked(runAdapterExecutionTargetProcess).mock.calls[0] as unknown as [unknown, unknown, unknown, string[]];
    expect(args).toContain("--conversation");
    expect(args).toContain("agy-conv-9");
    expect(args).not.toContain("--resume");
  });

  it("keeps gemini flags and parser when cliCompat is unset", async () => {
    const ctx = buildContext({ command: "gemini" });

    await execute(ctx as never);

    const [, , , args] = vi.mocked(runAdapterExecutionTargetProcess).mock.calls[0] as unknown as [unknown, unknown, unknown, string[]];
    expect(args).toContain("--approval-mode");
    expect(args).toContain("yolo");
    expect(args).toContain("--sandbox=none");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("forces the CLI lane when cliCompat=agy and engine is auto", async () => {
    // engine left unset (auto): agy has no ACP server, so the run must go
    // through the CLI lane with agy flags instead of Gemini ACP.
    const ctx = buildContext({ cliCompat: "agy", command: "agy", engine: undefined });

    const result = await execute(ctx as never);

    expect(executeGeminiAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const [, , , args] = vi.mocked(runAdapterExecutionTargetProcess).mock.calls[0] as unknown as [unknown, unknown, unknown, string[]];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(result.exitCode).toBe(0);
  });

  it("passes through extraArgs in agy mode", async () => {
    const ctx = buildContext({ cliCompat: "agy", command: "agy", extraArgs: ["--effort", "high"] });

    await execute(ctx as never);

    const [, , , args] = vi.mocked(runAdapterExecutionTargetProcess).mock.calls[0] as unknown as [unknown, unknown, unknown, string[]];
    expect(args).toContain("--effort");
    expect(args).toContain("high");
  });
});
