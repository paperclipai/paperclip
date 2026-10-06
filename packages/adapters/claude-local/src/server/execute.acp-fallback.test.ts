import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const { wakeEnv } = vi.hoisted(() => ({ wakeEnv: {} as Record<string, string> }));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils");
  return { ...actual, buildPaperclipEnv: (...args: Parameters<typeof actual.buildPaperclipEnv>) => ({ ...actual.buildPaperclipEnv(...args), ...wakeEnv }) };
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
    config,
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
});


describe("large wake prompts", () => {
  it.each([false, true])("keeps the file instruction on resume and fresh fallback (retry=%s)", async (retry) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-claude-wake-"));
    const payload = JSON.stringify({ history: "private-history".repeat(50000) });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    try {
      vi.clearAllMocks();
      Object.assign(wakeEnv, { PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_RUN_SCRATCH_DIR: dir });
      const ctx = buildContext({ engine: "cli", cwd: dir });
      Object.assign(ctx.runtime, { sessionId, sessionParams: { sessionId, cwd: dir } });
      if (retry) runAdapterExecutionTargetProcess.mockResolvedValueOnce({
        exitCode: 1, signal: null, timedOut: false,
        stdout: JSON.stringify({ type: "result", is_error: true, result: "No conversation found with session ID: " + sessionId }),
        stderr: "", pid: 123, startedAt: new Date().toISOString(),
      });
      await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[], { stdin: string; env: Record<string, string> }]>;
      expect(calls).toHaveLength(retry ? 2 : 1);
      expect(calls[0]![3]).toContain("--resume");
      if (retry) expect(calls[1]![3]).not.toContain("--resume");
      for (const call of calls) {
        expect(call[4].stdin).toContain("Read that file before you act");
        expect(call[4].stdin).toContain("PAPERCLIP_WAKE_PAYLOAD_PATH");
        expect(call[4].stdin).not.toContain("private-history");
        expect(await fs.readFile(call[4].env.PAPERCLIP_WAKE_PAYLOAD_PATH!, "utf8")).toBe(payload);
      }
    } finally {
      for (const key of Object.keys(wakeEnv)) delete wakeEnv[key];
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
