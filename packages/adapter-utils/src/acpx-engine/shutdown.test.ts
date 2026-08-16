import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closeAcpxEngineRuntimesForShutdown,
  createAcpxEngineExecutor,
  type RuntimeCacheEntry,
} from "./execute.js";

describe("ACP engine shutdown", () => {
  it("quarantines and awaits every retained warm runtime", async () => {
    let releaseClose!: () => void;
    const closeBlocked = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = vi.fn(async () => {
      await closeBlocked;
    });
    const cleanupTimer = setTimeout(() => {}, 60_000);
    cleanupTimer.unref?.();
    const handles = new Map<string, RuntimeCacheEntry>([
      [
        "paperclip:company:agent:task:fingerprint",
        {
          runtime: { close } as never,
          handle: { sessionId: "session" } as never,
          childStderrState: { pendingLiveLine: "" } as never,
          processIdentitySink: { current: undefined, latest: null },
          fingerprint: "fingerprint",
          lastUsedAt: Date.now(),
          cleanupTimer,
        },
      ],
    ]);

    let settled = false;
    const shutdown = closeAcpxEngineRuntimesForShutdown({ warmHandles: handles }).finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(handles.size).toBe(0);
    expect(settled).toBe(false);
    releaseClose();
    await expect(shutdown).resolves.toEqual({ closedWarmHandles: 1 });
    expect(handles.size).toBe(0);
    expect(close).toHaveBeenCalledWith({
      handle: { sessionId: "session" },
      reason: "paperclip server shutdown",
      discardPersistentState: false,
    });
  });

  it("fails closed and retains failed runtimes in the shutdown quarantine", async () => {
    const closeError = new Error("runtime close failed");
    const close = vi.fn().mockRejectedValue(closeError);
    const entry = {
      runtime: { close } as never,
      handle: { sessionId: "session" } as never,
      childStderrState: { pendingLiveLine: "" } as never,
      processIdentitySink: { current: undefined, latest: null },
      fingerprint: "fingerprint",
      lastUsedAt: Date.now(),
    } satisfies RuntimeCacheEntry;
    const handles = new Map<string, RuntimeCacheEntry>([["session", entry]]);

    await expect(closeAcpxEngineRuntimesForShutdown({ warmHandles: handles })).rejects.toBe(closeError);
    expect(handles.size).toBe(0);
    await expect(closeAcpxEngineRuntimesForShutdown({ warmHandles: handles })).rejects.toBe(closeError);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("waits for every concurrent close failure before returning ownership to the retry path", async () => {
    const fastError = new Error("fast close failed");
    const slowError = new Error("slow close failed");
    let rejectSlow!: (error: Error) => void;
    const slowClose = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSlow = reject;
    }));
    const fastClose = vi.fn().mockRejectedValue(fastError);
    const fastEntry = {
      runtime: { close: fastClose } as never,
      handle: { sessionId: "fast" } as never,
      childStderrState: { pendingLiveLine: "" } as never,
      processIdentitySink: { current: undefined, latest: null },
      fingerprint: "fast",
      lastUsedAt: Date.now(),
    } satisfies RuntimeCacheEntry;
    const slowEntry = {
      runtime: { close: slowClose } as never,
      handle: { sessionId: "slow" } as never,
      childStderrState: { pendingLiveLine: "" } as never,
      processIdentitySink: { current: undefined, latest: null },
      fingerprint: "slow",
      lastUsedAt: Date.now(),
    } satisfies RuntimeCacheEntry;
    const handles = new Map<string, RuntimeCacheEntry>([
      ["fast", fastEntry],
      ["slow", slowEntry],
    ]);

    let settled = false;
    const shutdown = closeAcpxEngineRuntimesForShutdown({ warmHandles: handles }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    rejectSlow(slowError);
    await expect(shutdown).rejects.toBeInstanceOf(AggregateError);
    expect(handles.size).toBe(0);
    slowClose.mockRejectedValueOnce(slowError);
    await expect(closeAcpxEngineRuntimesForShutdown({ warmHandles: handles })).rejects.toBeInstanceOf(AggregateError);
    expect(fastClose).toHaveBeenCalledTimes(2);
    expect(slowClose).toHaveBeenCalledTimes(2);
  });

  it("keeps an idle-close failure visible to shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-idle-close-"));
    const closeError = new Error("idle close failed");
    const close = vi.fn().mockRejectedValue(closeError);
    const warmHandles = new Map<string, RuntimeCacheEntry>();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close,
      }) as never,
    });

    try {
      await execute({
        runId: "idle-close-run",
        agent: { id: "agent", companyId: "company" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          cwd: root,
          stateDir: path.join(root, "state"),
          mode: "persistent",
          warmHandleIdleMs: 1,
        },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 1_000 });

      expect(warmHandles.size).toBe(0);
      await expect(closeAcpxEngineRuntimesForShutdown({ warmHandles })).rejects.toBe(closeError);
      expect(warmHandles.size).toBe(0);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
