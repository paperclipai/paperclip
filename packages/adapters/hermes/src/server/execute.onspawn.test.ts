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

  it("keeps wake data in the prompt and drops configured JSON env copies", async () => {
    const { ctx } = makeCtx({ env: { PAPERCLIP_WAKE_PAYLOAD_JSON: "stale configured wake" } });
    const wake = { reason: "issue_assigned", issue: { id: "issue-1", description: "Current task brief" } };
    await execute({ ...ctx, context: { ...ctx.context, paperclipWake: wake } } as any);
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[3].env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(call[2]).toContainEqual(expect.stringContaining("Current task brief"));
  });

  it("launches in the assigned task workspace when no cwd was configured", async () => {
    const { ctx } = makeCtx();
    await execute({ ...ctx, context: { ...ctx.context, paperclipWorkspace: { cwd: "/private/qa/agent-workspace" } } } as any);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3].cwd).toBe("/private/qa/agent-workspace");
  });

  it("preserves an explicitly configured cwd", async () => {
    const { ctx } = makeCtx({ cwd: "/private/qa/configured-workspace" });
    await execute({ ...ctx, context: { ...ctx.context, paperclipWorkspace: { cwd: "/private/qa/agent-workspace" } } } as any);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3].cwd).toBe("/private/qa/configured-workspace");
  });

  it("passes the configured thinking effort as --reasoning", async () => {
    const { ctx } = makeCtx({ effort: "High" });
    await execute(ctx as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args.slice(args.indexOf("--reasoning"), args.indexOf("--reasoning") + 2)).toEqual(["--reasoning", "high"]);
    expect(args).not.toContain("--reasoning-effort");
  });

  it("skips an unsupported effort and defers to an explicit --reasoning extra arg", async () => {
    const { ctx } = makeCtx({ effort: "turbo" });
    await execute(ctx as any);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2]).not.toContain("--reasoning");
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("unsupported thinking effort"));
    const explicit = makeCtx({ effort: "high", extraArgs: ["--reasoning", "low"] });
    await execute(explicit.ctx as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args.filter((arg) => arg === "--reasoning")).toHaveLength(1);
    expect(args[args.indexOf("--reasoning") + 1]).toBe("low");
  });

  it("repairs a saved --reasoning-effort extra arg from older agent configs", async () => {
    const { ctx } = makeCtx({ extraArgs: ["--reasoning-effort", "medium", "--checkpoints"] });
    await execute(ctx as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).not.toContain("--reasoning-effort");
    expect(args[args.indexOf("--reasoning") + 1]).toBe("medium");
    expect(args).toContain("--checkpoints");
    const both = makeCtx({ effort: "high", extraArgs: ["--reasoning-effort=low"] });
    await execute(both.ctx as any);
    const bothArgs = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(bothArgs.some((arg) => arg.startsWith("--reasoning-effort"))).toBe(false);
    expect(bothArgs[bothArgs.indexOf("--reasoning") + 1]).toBe("high");
  });

  describe("resuming a session with a thinking effort", () => {
    function withSession(overrides: Record<string, unknown>, sessionParams: Record<string, unknown>) {
      const { ctx } = makeCtx(overrides);
      return { ...ctx, runtime: { ...ctx.runtime, sessionId: "s-old", sessionParams } };
    }
    function returnSession(id: string) {
      vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `ok\n\nsession_id: ${id}\n`,
        stderr: "",
      } as any);
    }
    const lastArgs = () => vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];

    it("starts a new session when the saved session was launched without --reasoning", async () => {
      returnSession("s-new");
      const result = await execute(withSession({ effort: "high" }, { sessionId: "s-old" }) as any);
      const args = lastArgs();
      expect(args).not.toContain("--resume");
      expect(args[args.indexOf("--reasoning") + 1]).toBe("high");
      expect(result.sessionParams).toEqual({ sessionId: "s-new", reasoning: "high" });
    });

    it("loads the fresh-session handoff only when it starts a new session", async () => {
      const handoff = vi.fn(async () => "EARLIER TASK HISTORY");
      returnSession("s-new");
      const taskContext = { issueId: "issue-1", wakeReason: "manual", paperclipWake: null, paperclipTaskMarkdown: "Task brief" };
      await execute({
        ...withSession({ effort: "high" }, { sessionId: "s-old" }),
        context: { ...taskContext },
        getFreshSessionHandoff: handoff,
      } as any);
      expect(handoff).toHaveBeenCalledTimes(1);
      expect(lastArgs()[lastArgs().indexOf("-q") + 1]).toContain("EARLIER TASK HISTORY");

      handoff.mockClear();
      returnSession("s-old");
      await execute({
        ...withSession({ effort: "high" }, { sessionId: "s-old", reasoning: "high" }),
        context: { ...taskContext },
        getFreshSessionHandoff: handoff,
      } as any);
      expect(handoff).not.toHaveBeenCalled();
      expect(lastArgs()[lastArgs().indexOf("-q") + 1]).not.toContain("EARLIER TASK HISTORY");
    });

    it("starts a new session when the saved launch level differs", async () => {
      returnSession("s-new");
      const result = await execute(withSession({ effort: "low" }, { sessionId: "s-old", reasoning: "high" }) as any);
      expect(lastArgs()).not.toContain("--resume");
      expect(result.sessionParams).toEqual({ sessionId: "s-new", reasoning: "low" });
    });

    it("resumes when the saved launch level matches", async () => {
      returnSession("s-old");
      const result = await execute(withSession({ effort: "high" }, { sessionId: "s-old", reasoning: "high" }) as any);
      const args = lastArgs();
      expect(args[args.indexOf("--resume") + 1]).toBe("s-old");
      expect(args[args.indexOf("--reasoning") + 1]).toBe("high");
      expect(result.sessionParams).toEqual({ sessionId: "s-old", reasoning: "high" });
    });

    it("resumes without --reasoning and keeps the saved level when no effort is set", async () => {
      returnSession("s-old");
      const result = await execute(withSession({}, { sessionId: "s-old", reasoning: "high" }) as any);
      const args = lastArgs();
      expect(args[args.indexOf("--resume") + 1]).toBe("s-old");
      expect(args).not.toContain("--reasoning");
      expect(result.sessionParams).toEqual({ sessionId: "s-old", reasoning: "high" });
    });
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
