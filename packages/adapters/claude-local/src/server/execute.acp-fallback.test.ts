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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecretEnvRedactionScanner, redactKnownSecretEnvValues } from "@paperclipai/adapter-utils/secret-env-redaction";

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

  it.each([false, true].flatMap(timedOut => [false, true].flatMap(checkpoints =>
    [false, true].flatMap(collision => [false, true].map(modelLedger => ({ timedOut, checkpoints, collision, modelLedger }))))))(
    "keeps lost accounting incomplete ($timedOut, $checkpoints, $collision, $modelLedger)", async ({ timedOut, checkpoints, collision, modelLedger }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "claude-accounting-loss-"));
      const input = collision ? 123456 : 17;
      const raw = JSON.stringify({ duration_ms: 123456, type: "result", result: "done", total_cost_usd: 0.2,
        ...(modelLedger
          ? { modelUsage: { "claude-test": { inputTokens: input, outputTokens: 7, cacheReadInputTokens: 2, costUSD: 0.2 } } }
          : { usage: { input_tokens: input, output_tokens: 7, cache_read_input_tokens: 2 } }),
      }) + "\n";
      const control = createSecretEnvRedactionScanner(["123456"], 4 * 1024 * 1024);
      control.append(raw);
      const stdout = redactKnownSecretEnvValues(raw, ["123456"]);
      const onUsage = vi.fn(async () => {});
      runAdapterExecutionTargetProcess.mockImplementationOnce((async (...args: unknown[]) => {
        const opts = args[4] as { onLog: (stream: "stdout", text: string) => Promise<void> };
        await opts.onLog("stdout", stdout);
        return { exitCode: 0, signal: null, timedOut, stdout, stderr: "", pid: 123,
          startedAt: new Date().toISOString(), controlOutput: { stdout: control.snapshot(), stderr: "" } };
      }) as never);
      try {
        const result = await execute({ ...buildContext({ engine: "cli", cwd }),
          ...(checkpoints ? { onUsage } : {}),
        });
        expect(result.timedOut).toBe(timedOut);
        expect(result.usage).toMatchObject({ inputTokens: collision ? 0 : 17, outputTokens: 7, cachedInputTokens: 2 });
        expect(result.costUsd).toBe(0.2);
        expect(result.usageComplete).toBe(!collision);
        expect(stdout).not.toContain("123456");
        expect(control.snapshot()).not.toContain("123456");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

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
});
