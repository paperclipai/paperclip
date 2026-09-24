import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeGeminiAcp,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeGeminiAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "gemini"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "init", session_id: "gemini-session-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createGeminiAcpExecutor: () => executeGeminiAcp,
  resolveGeminiExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
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

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gemini Coder",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      env: { GEMINI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("gemini_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeGeminiAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it.each(["fresh", "resumed", "missing"] as const)(
    "supplies initial communication guidance at the CLI attempt boundary (%s)", async (state) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "gemini-communication-"));
      const prompts: string[] = [];
      try {
        if (state === "missing") {
          runAdapterExecutionTargetProcess.mockResolvedValueOnce({
            exitCode: 1, signal: null, timedOut: false, stdout: "",
            stderr: "Unknown session 'previous'", pid: 123, startedAt: new Date().toISOString(),
          });
        }
        const ctx = buildContext({ engine: "cli", cwd });
        await execute({
          ...ctx,
          runtime: { ...ctx.runtime, sessionId: state === "fresh" ? null : "previous" },
          context: { paperclipTaskCommunicationGuidance: "Frozen Slack preferences." },
          onMeta: async (meta) => { prompts.push(meta.prompt ?? ""); },
        });
        if (state === "fresh") {
          expect(prompts).toHaveLength(1);
          expect(prompts[0]?.match(/Frozen Slack preferences\./g)).toHaveLength(1);
        } else {
          expect(prompts[0]).not.toContain("Frozen Slack preferences.");
          expect(prompts).toHaveLength(state === "missing" ? 2 : 1);
          if (state === "missing") {
            expect(prompts[1]?.match(/Frozen Slack preferences\./g)).toHaveLength(1);
          }
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
