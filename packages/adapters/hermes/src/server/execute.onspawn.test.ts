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

import { execute, realFaultBeyondTeardown } from "./execute.js";
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

const TEARDOWN_STDERR = [
  'Traceback (most recent call last):',
  '  File "/opt/hermes/tools/code_execution_tool.py", line 673, in accept',
  '    client, addr = sock.accept()',
  '  File "/usr/lib/python3.11/socket.py", line 924, in accept',
  '    return self._accept()',
  'OSError: [Errno 9] Bad file descriptor',
].join("\n");

describe("realFaultBeyondTeardown", () => {
  it("does not treat RPC socket teardown as a fault", () => {
    expect(realFaultBeyondTeardown(TEARDOWN_STDERR)).toBe(false);
  });

  it("still reports a fault that appears alongside teardown", () => {
    expect(
      realFaultBeyondTeardown(
        `${TEARDOWN_STDERR}\nValueError: could not parse tool arguments`,
      ),
    ).toBe(true);
    expect(
      realFaultBeyondTeardown(
        `${TEARDOWN_STDERR}\nMemoryError`,
      ),
    ).toBe(true);
    expect(
      realFaultBeyondTeardown(
        `${TEARDOWN_STDERR}\nJavaScript heap out of memory`,
      ),
    ).toBe(true);
  });

  it("reports a bare OSError that is not the teardown errno", () => {
    expect(
      realFaultBeyondTeardown("Traceback (most recent call last):\nOSError: [Errno 2] No such file or directory"),
    ).toBe(true);
  });

  it("reports a traceback whose final exception line has no message", () => {
    expect(
      realFaultBeyondTeardown(`${TEARDOWN_STDERR}\nValueError`),
    ).toBe(true);
  });

  it("reports a fault that appears before the teardown traceback", () => {
    expect(
      realFaultBeyondTeardown(
        `Error: provider unavailable\n${TEARDOWN_STDERR}`,
      ),
    ).toBe(true);
  });
});

describe("teardown-only stderr does not fail a run", () => {
  async function runWith(stderr: string, exitCode: number) {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode,
      signal: null,
      timedOut: false,
      stdout: "work produced\n",
      stderr,
      pid: null,
      startedAt: null,
    });
    const { ctx } = makeCtx();
    return execute(ctx as any);
  }

  it("stays clean when the only stderr is the RPC socket closing", async () => {
    const result = await runWith(TEARDOWN_STDERR, 0);
    expect(result.errorMessage).toBeUndefined();
  });

  it("does not fail on a non-zero exit that is teardown only", async () => {
    const result = await runWith(TEARDOWN_STDERR, 1);
    expect(result.errorMessage).toBeUndefined();
  });

  it("reports the exit code the run completion path uses for a teardown-only exit", async () => {
    const result = await runWith(TEARDOWN_STDERR, 1);
    expect(result.errorMessage).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.signal ?? null).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("still fails when a real fault accompanies the teardown", async () => {
    const result = await runWith(
      `${TEARDOWN_STDERR}\nValueError: tool arguments were malformed`,
      1,
    );
    expect(result.errorMessage).toBeDefined();
  });

  it("still reports a plain non-zero exit with no teardown", async () => {
    const result = await runWith("", 130);
    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("keeps the real exit code when a fault accompanies the teardown", async () => {
    const result = await runWith(
      `${TEARDOWN_STDERR}\nValueError: tool arguments were malformed`,
      1,
    );
    expect(result.exitCode).toBe(1);
  });
});
