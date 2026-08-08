import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runChildProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";

function makeCtx(quiet: boolean) {
  const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined);
  return {
    ctx: {
      runId: "test-run-quiet-liveness",
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
        provider: "openrouter",
        timeoutSec: 120,
        graceSec: 5,
        quiet,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog,
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async (): Promise<void> => undefined),
    },
    onLog,
  };
}

describe("hermes-local quiet-mode liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runChildProcessMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits post-spawn alive heartbeats without contaminating response or session capture", async () => {
    let resolveChild!: (result: {
      exitCode: number;
      signal: null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }) => void;
    runChildProcessMock.mockImplementation(async (_runId, _command, _args, options) => {
      await options.onSpawn?.({
        pid: 12345,
        processGroupId: 12345,
        startedAt: new Date().toISOString(),
      });
      return await new Promise((resolve) => {
        resolveChild = resolve;
      });
    });

    const { ctx, onLog } = makeCtx(true);
    const execution = execute(ctx as any);
    await vi.advanceTimersByTimeAsync(30_000);

    resolveChild({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "[hermes] alive: 30s\nCompleted the requested action.\nsession_id: quiet-session-1\n",
      stderr: "",
    });
    const result = await execution;

    const aliveLogs = onLog.mock.calls.filter(([, chunk]) =>
      typeof chunk === "string" && chunk.includes("[hermes] alive:"),
    );
    expect(aliveLogs.length).toBeGreaterThanOrEqual(1);
    expect(result.summary).toBe("Completed the requested action.");
    expect(result.summary).not.toContain("[hermes] alive:");
    expect(result.sessionParams).toEqual({ sessionId: "quiet-session-1" });

    const heartbeatCountAfterExit = aliveLogs.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onLog.mock.calls.filter(([, chunk]) =>
      typeof chunk === "string" && chunk.includes("[hermes] alive:"),
    )).toHaveLength(heartbeatCountAfterExit);
  });

  it("serializes alive heartbeats behind in-flight child output", async () => {
    let releaseChildLog!: () => void;
    let resolveChild!: (result: {
      exitCode: number;
      signal: null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }) => void;
    const { ctx, onLog } = makeCtx(true);
    onLog.mockImplementation(async (_stream, chunk) => {
      if (chunk === "child output\n") {
        await new Promise<void>((resolve) => {
          releaseChildLog = resolve;
        });
      }
    });
    runChildProcessMock.mockImplementation(async (_runId, _command, _args, options) => {
      await options.onSpawn?.({
        pid: 12345,
        processGroupId: 12345,
        startedAt: new Date().toISOString(),
      });
      const childLog = options.onLog("stdout", "child output\n");
      return await new Promise((resolve) => {
        resolveChild = (result) => {
          void childLog.then(() => resolve(result));
        };
      });
    });

    const execution = execute(ctx as any);
    await vi.advanceTimersByTimeAsync(15_000);

    try {
      expect(onLog.mock.calls.some(([, chunk]) =>
        typeof chunk === "string" && chunk.includes("[hermes] alive:"),
      )).toBe(false);
    } finally {
      releaseChildLog();
      resolveChild({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Completed after child output.\nsession_id: quiet-session-ordered\n",
        stderr: "",
      });
      await execution;
    }

    const orderedChunks = onLog.mock.calls
      .map(([, chunk]) => chunk)
      .filter((chunk) => chunk === "child output\n" || chunk.includes("[hermes] alive:"));
    expect(orderedChunks[0]).toBe("child output\n");
    expect(orderedChunks[1]).toContain("[hermes] alive:");
  });

  it("does not start a phantom heartbeat after execution finishes before onSpawn resolves", async () => {
    let releaseOnSpawn!: () => void;
    const { ctx, onLog } = makeCtx(true);
    ctx.onSpawn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseOnSpawn = resolve;
        }),
    );
    runChildProcessMock.mockImplementation(async (_runId, _command, _args, options) => {
      void options.onSpawn?.({
        pid: 12345,
        processGroupId: 12345,
        startedAt: new Date().toISOString(),
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Completed quickly.\nsession_id: quiet-session-2\n",
        stderr: "",
      };
    });

    const result = await execute(ctx as any);
    expect(result.sessionParams).toEqual({ sessionId: "quiet-session-2" });

    releaseOnSpawn();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onLog.mock.calls.some(([, chunk]) =>
      typeof chunk === "string" && chunk.includes("[hermes] alive:"),
    )).toBe(false);
  });

  it("reports heartbeat write failures without failing the child execution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let resolveChild!: (result: {
      exitCode: number;
      signal: null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }) => void;
    runChildProcessMock.mockImplementation(async (_runId, _command, _args, options) => {
      await options.onSpawn?.({
        pid: 12345,
        processGroupId: 12345,
        startedAt: new Date().toISOString(),
      });
      return await new Promise((resolve) => {
        resolveChild = resolve;
      });
    });

    const { ctx, onLog } = makeCtx(true);
    onLog.mockImplementation(async (_stream, chunk) => {
      if (chunk.includes("[hermes] alive:")) throw new Error("log store unavailable");
    });
    const execution = execute(ctx as any);
    await vi.advanceTimersByTimeAsync(15_000);
    resolveChild({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Completed.\nsession_id: quiet-session-3\n",
      stderr: "",
    });

    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        runId: "test-run-quiet-liveness",
      }),
      "failed to append Hermes quiet heartbeat log",
    );
  });

  it("does not start alive heartbeats or change session capture in legacy mode", async () => {
    runChildProcessMock.mockImplementation(async (_runId, _command, args, options) => {
      await options.onSpawn?.({
        pid: 12345,
        processGroupId: 12345,
        startedAt: new Date().toISOString(),
      });
      expect(args).not.toContain("-Q");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Completed the requested action.\nSession ID: legacy-session-1\n",
        stderr: "",
      };
    });

    const { ctx, onLog } = makeCtx(false);
    const result = await execute(ctx as any);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onLog.mock.calls.some(([, chunk]) =>
      typeof chunk === "string" && chunk.includes("[hermes] alive:"),
    )).toBe(false);
    expect(result.sessionParams).toEqual({ sessionId: "legacy-session-1" });
  });
});
