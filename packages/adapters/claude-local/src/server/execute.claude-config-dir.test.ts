import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "11111111-1111-4111-8111-111111111111",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "11111111-1111-4111-8111-111111111111",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "11111111-1111-4111-8111-111111111111",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
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

import { execute, runClaudeLogin } from "./execute.js";

function buildContext(input: {
  config?: Record<string, unknown>;
  sessionParams?: Record<string, unknown> | null;
} = {}) {
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
      sessionParams: input.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { engine: "cli", ...(input.config ?? {}) },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

function invocation() {
  expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  const call = (runAdapterExecutionTargetProcess as unknown as { mock: { calls: unknown[][] } })
    .mock.calls[0]!;
  return {
    args: call[3] as string[],
    options: call[4] as {
      env: Record<string, string | undefined>;
      localProcessSandbox: { managedPaths: Array<{ path: string; access: string }> } | null;
    },
  };
}

describe("claude_local subscription profile isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the explicit profile for both the sandbox mount and Claude environment", async () => {
    const sharedDir = "/var/tmp/paperclip-claude-shared/.claude";
    const explicitDir = "/var/tmp/paperclip-claude-account-b/.claude";
    vi.stubEnv("CLAUDE_CONFIG_DIR", sharedDir);

    const result = await execute(buildContext({
      config: {
        filesystemScope: "workspace",
        env: { CLAUDE_CONFIG_DIR: explicitDir },
      },
    }) as never);
    const { options } = invocation();

    expect(options.env.CLAUDE_CONFIG_DIR).toBe(explicitDir);
    expect(options.localProcessSandbox?.managedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: explicitDir, access: "rw" }),
      ]),
    );
    expect(options.localProcessSandbox?.managedPaths.some((entry) => entry.path === sharedDir)).toBe(false);
    expect(result.sessionParams).toEqual(
      expect.objectContaining({ claudeConfigDir: explicitDir }),
    );
  });

  it("normalizes a relative local profile independently of the agent workspace", async () => {
    const workspaceDir = "/var/tmp/paperclip-agent-workspace";
    const relativeDir = "../claude-profiles/account-b/.claude";
    const expectedDir = path.resolve(relativeDir);

    const result = await execute(buildContext({
      config: {
        cwd: workspaceDir,
        env: { CLAUDE_CONFIG_DIR: relativeDir },
      },
    }) as never);
    const { options } = invocation();

    expect(options.env.CLAUDE_CONFIG_DIR).toBe(expectedDir);
    expect(result.sessionParams).toEqual(
      expect.objectContaining({ claudeConfigDir: expectedDir }),
    );
  });

  it("uses the same normalized relative profile for Claude login", async () => {
    const workspaceDir = "/var/tmp/paperclip-agent-workspace";
    const relativeDir = "../claude-profiles/account-b/.claude";
    const expectedDir = path.resolve(relativeDir);

    await runClaudeLogin({
      runId: "login-1",
      agent: buildContext().agent,
      config: {
        cwd: workspaceDir,
        env: { CLAUDE_CONFIG_DIR: relativeDir },
      },
    } as never);
    const { args, options } = invocation();

    expect(args).toEqual(["login"]);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(expectedDir);
  });

  it("starts a fresh session when an agent is moved to another subscription profile", async () => {
    const previousDir = "/var/tmp/paperclip-claude-account-a/.claude";
    const selectedDir = "/var/tmp/paperclip-claude-account-b/.claude";
    const previousSessionId = "22222222-2222-4222-8222-222222222222";
    const ctx = buildContext({
      config: { env: { CLAUDE_CONFIG_DIR: selectedDir } },
      sessionParams: {
        sessionId: previousSessionId,
        cwd: process.cwd(),
        claudeConfigDir: previousDir,
      },
    });

    const result = await execute(ctx as never);
    const { args } = invocation();

    expect(args).not.toContain("--resume");
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("belongs to a different Claude profile"),
    );
    expect(result.sessionParams).toEqual(
      expect.objectContaining({ claudeConfigDir: selectedDir }),
    );
  });

  it("starts fresh once when a legacy session first selects an explicit profile", async () => {
    const selectedDir = "/var/tmp/paperclip-claude-account-b/.claude";
    const previousSessionId = "33333333-3333-4333-8333-333333333333";
    const ctx = buildContext({
      config: { env: { CLAUDE_CONFIG_DIR: selectedDir } },
      sessionParams: {
        sessionId: previousSessionId,
        cwd: process.cwd(),
      },
    });

    await execute(ctx as never);
    const { args } = invocation();

    expect(args).not.toContain("--resume");
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("belongs to a different Claude profile"),
    );
  });
});
