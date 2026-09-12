import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for honoring an explicit `adapterConfig.env.CLAUDE_CONFIG_DIR`
// in the local sandboxed execution path. Before the fix, the sandbox bind mount and
// the in-sandbox `CLAUDE_CONFIG_DIR` both resolved against `process.env` (the shared
// directory), ignoring the per-agent value. A version that wires only one of the two
// looks correct from inside the sandbox until something tries to write, so this test
// asserts on both.

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  // Force the ACP lane to fail so execute() falls back to the local CLI runner,
  // which is the path that builds the filesystem sandbox.
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
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
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
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local local sandbox honors adapterConfig.env.CLAUDE_CONFIG_DIR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points both the writable bind mount and the in-sandbox env at the explicit value", async () => {
    // The shared directory implied by process.env must differ from the per-agent
    // value so the assertion can distinguish them.
    const sharedDir = "/var/tmp/paperclip-claude-shared-process-env";
    const explicitDir = "/var/tmp/paperclip-claude-explicit-adapter-env";
    vi.stubEnv("CLAUDE_CONFIG_DIR", sharedDir);

    const ctx = buildContext({
      filesystemScope: "workspace",
      env: { CLAUDE_CONFIG_DIR: explicitDir },
    });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const options = (runAdapterExecutionTargetProcess as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![4] as {
        env: Record<string, string | undefined>;
        localProcessSandbox: { managedPaths: Array<{ path: string; access: string }> };
      };

    // The in-sandbox environment variable follows the explicit per-agent value...
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(explicitDir);
    // ...and so does the writable bind mount that backs it.
    expect(options.localProcessSandbox.managedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: explicitDir, access: "rw" }),
      ]),
    );
    // Neither surface should still point at the shared process.env directory.
    expect(options.env.CLAUDE_CONFIG_DIR).not.toBe(sharedDir);
    expect(
      options.localProcessSandbox.managedPaths.some((entry) => entry.path === sharedDir),
    ).toBe(false);
  });
});
