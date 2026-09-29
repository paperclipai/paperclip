import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runCheckpointCommand } from "./native-checkpoint-command.js";
import { loopbackCheckpointChannel as localChannel } from "./native-checkpoint-transfer.test-support.js";

describe("history-sized checkpoint command", () => {
  it("uses an owned long-lived process instead of a short execute RPC", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("single-command RPC deadline"));
    const openDuplexChannel = vi.fn(async ({ command }) => localChannel(command));
    const runner = { execute, openDuplexChannel } as CommandManagedRuntimeRunner;
    expect(await runCheckpointCommand(runner, "sleep 0.05; printf checkpoint-finished")).toBe("checkpoint-finished");
    expect(execute).not.toHaveBeenCalled();
    expect(openDuplexChannel).toHaveBeenCalledOnce();
  });
  it("rejects a real failed command and reaps its owned process", async () => {
    const close = vi.fn();
    const runner = { execute: vi.fn(), openDuplexChannel: async ({ command }) => {
      const channel = localChannel(command);
      const finish = channel.close;
      channel.close = async () => { await finish(); close(); };
      return channel;
    } } as CommandManagedRuntimeRunner;
    await expect(runCheckpointCommand(runner, "exit 7")).rejects.toThrow("checkpoint_transfer_failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("fails closed on truncated transport and bounds diagnostic output", async () => {
    for (const flood of [false, true]) {
      const stop = vi.fn(), close = vi.fn(async () => {});
      const runner = { execute: vi.fn(), openDuplexChannel: async () => ({
        stop, close, write() {},
        onData: (listener: (chunk: Uint8Array) => void) => { if (flood) queueMicrotask(() => listener(Buffer.alloc(65 * 1024))); },
        onExit: (listener: (exit: { exitCode: number | null; transportClosed?: boolean }) => void) => {
          if (!flood) queueMicrotask(() => listener({ exitCode: null, transportClosed: true }));
        },
      }) } as CommandManagedRuntimeRunner;
      await expect(runCheckpointCommand(runner, "private checkpoint")).rejects.toThrow("checkpoint_transfer_failed");
      expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    }
  });
});
