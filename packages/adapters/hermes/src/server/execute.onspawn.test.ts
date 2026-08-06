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
