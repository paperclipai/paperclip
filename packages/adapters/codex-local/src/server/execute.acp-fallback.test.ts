import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeCodexAcp,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeCodexAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  tempCodexHome: "/tmp/paperclip-codex-acp-fallback-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => executeCodexAcp,
  resolveCodexExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
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

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
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
      name: "Codex Coder",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("codex_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true].flatMap(timedOut => [false, true].flatMap(checkpoints =>
    [false, true].flatMap(collision =>
      (["turn.completed", "turn.failed", "error"] as const).map(recordType => ({ timedOut, checkpoints, collision, recordType })))))) (
    "keeps lost accounting incomplete ($timedOut, $checkpoints, $collision, $recordType)", async ({ timedOut, checkpoints, collision, recordType }) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "codex-accounting-loss-"));
      // Redact output, not input: the remaining input/cache pair stays valid.
      const raw = JSON.stringify({ duration_ms: 123456, type: recordType,
        ...(recordType === "error" ? { message: "boom" } : {}),
        usage: { input_tokens: 500000, output_tokens: collision ? 123456 : 7, cached_input_tokens: 2 },
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
        expect(result.usage).toEqual({ inputTokens: 499998, outputTokens: collision ? 0 : 7, cachedInputTokens: 2 });
        expect(result.costUsd).toBeNull();
        expect(result.usageComplete).toBe(!collision);
        expect(result.costStatus).toBe(collision ? "unpriced" : undefined);
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
    expect(executeCodexAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
