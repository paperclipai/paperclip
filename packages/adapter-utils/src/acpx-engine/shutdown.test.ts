import { describe, expect, it, vi } from "vitest";
import {
  closeAcpxEngineRuntimesForShutdown,
  type RuntimeCacheEntry,
} from "./execute.js";

describe("ACP engine shutdown", () => {
  it("awaits and removes every retained warm runtime", async () => {
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
    expect(close).toHaveBeenCalledWith({
      handle: { sessionId: "session" },
      reason: "paperclip server shutdown",
      discardPersistentState: false,
    });
  });

  it("fails closed and retains ownership when a runtime cannot be closed", async () => {
    const closeError = new Error("runtime close failed");
    const entry = {
      runtime: { close: vi.fn().mockRejectedValue(closeError) } as never,
      handle: { sessionId: "session" } as never,
      childStderrState: { pendingLiveLine: "" } as never,
      processIdentitySink: { current: undefined, latest: null },
      fingerprint: "fingerprint",
      lastUsedAt: Date.now(),
    } satisfies RuntimeCacheEntry;
    const handles = new Map<string, RuntimeCacheEntry>([["session", entry]]);

    await expect(closeAcpxEngineRuntimesForShutdown({ warmHandles: handles })).rejects.toBe(closeError);
    expect(handles.get("session")).toBe(entry);
  });
});
