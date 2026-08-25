/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("binds MOA to Planner without changing the Executor route", async () => {
    const binding = { planner: "LagunaS-Qwen" };

    const { ctx: plannerCtx } = makeCtx({
      profile: "planner",
      model: "qwen3.6:27b",
      provider: "ollama-launch",
      moaProfileBindings: binding,
    });
    await execute(plannerCtx as any);

    const plannerArgs = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(plannerArgs[plannerArgs.indexOf("-m") + 1]).toBe("moa:LagunaS-Qwen");
    expect(plannerArgs[plannerArgs.indexOf("--provider") + 1]).toBe("moa");

    const { ctx: executorCtx } = makeCtx({
      profile: "executor",
      model: "qwen3.6:27b",
      provider: "ollama-launch",
      moaProfileBindings: binding,
      extraArgs: ["--profile", "planner"],
    });
    await execute(executorCtx as any);

    const executorArgs = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(executorArgs.slice(0, 3)).toEqual(["--profile", "executor", "chat"]);
    expect(executorArgs[executorArgs.indexOf("-m") + 1]).toBe("qwen3.6:27b");
    expect(executorArgs[executorArgs.indexOf("--provider") + 1]).toBe("ollama-launch");
    expect(executorArgs).not.toContain("moa:LagunaS-Qwen");
    expect(executorArgs).not.toContain("planner");
  });

  it("keeps Planner MOA and Executor single-model routing authoritative over conflicting passthrough flags", async () => {
    const conflictingExtraArgs = [
      "-m", "wrong-short-model",
      "-m=wrong-equals-model",
      "--model", "wrong-model",
      "--model=wrong-equals-model",
      "--provider", "openrouter",
      "--provider=wrong-provider",
      "--keep", "value",
    ];
    const binding = { planner: "LagunaS-Qwen" };

    const { ctx: plannerCtx } = makeCtx({
      profile: "planner",
      model: "qwen3.6:27b",
      provider: "auto",
      moaProfileBindings: binding,
      extraArgs: conflictingExtraArgs,
    });
    await execute(plannerCtx as any);

    const plannerArgs = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(plannerArgs[plannerArgs.indexOf("-m") + 1]).toBe("moa:LagunaS-Qwen");
    expect(plannerArgs[plannerArgs.indexOf("--provider") + 1]).toBe("moa");
    expect(plannerArgs).toContain("--keep");
    expect(plannerArgs).toContain("value");
    expect(plannerArgs).not.toContain("wrong-short-model");
    expect(plannerArgs).not.toContain("wrong-equals-model");
    expect(plannerArgs).not.toContain("wrong-model");
    expect(plannerArgs).not.toContain("openrouter");
    expect(plannerArgs).not.toContain("wrong-provider");

    const { ctx: executorCtx } = makeCtx({
      profile: "executor",
      model: "qwen3.6:27b",
      provider: "auto",
      moaProfileBindings: binding,
      extraArgs: conflictingExtraArgs,
    });
    await execute(executorCtx as any);

    const executorArgs = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(executorArgs[executorArgs.indexOf("-m") + 1]).toBe("qwen3.6:27b");
    expect(executorArgs).not.toContain("--provider");
    expect(executorArgs).not.toContain("moa:LagunaS-Qwen");
    expect(executorArgs).not.toContain("wrong-short-model");
    expect(executorArgs).not.toContain("wrong-equals-model");
    expect(executorArgs).not.toContain("wrong-model");
    expect(executorArgs).not.toContain("openrouter");
    expect(executorArgs).not.toContain("wrong-provider");
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("preserves a specific stderr diagnostic for a nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: provider unavailable\n",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("reports the exit code when a nonzero exit has no diagnostic", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 130,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves timeout diagnostics to the heartbeat timeout path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not label signal cancellation as a silent nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});
