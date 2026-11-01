import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, statfs } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { DuplexChannelSession } from "./duplex-command-stream.js";

const { openSession } = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock("./duplex-command-stream.js", () => ({ openDaytonaDuplexChannelSession: openSession }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), statfs: vi.fn(actual.statfs) };
});
import { streamSandboxArchive } from "./archive-stream.js";

const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each(["missing receipt", "tar failure", "transport loss", "invalid base64", "oversized frame", "timeout", "host reserve", "archive budget"])("rejects %s and closes the transfer", async fault => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-stream-"));
  roots.push(root);
  const close = vi.fn(async () => {});
  if (fault === "host reserve") vi.mocked(statfs).mockResolvedValue({ bavail: 0, bsize: 4096 } as never);
  openSession.mockImplementation(async (_process, command: string[]) => {
    const marker = command.join(" ").match(/paperclip-archive-[a-f0-9-]+/)![0];
    let listener: (bytes: Uint8Array) => void;
    let end!: (exit: { exitCode: number | null; transportClosed: boolean }) => void;
    const completion = new Promise<{ exitCode: number | null; transportClosed: boolean }>(resolve => { end = resolve; });
    let writes = 0;
    const emit = (text: string) => listener(Buffer.from(text));
    return {
      onData: (callback: typeof listener) => { listener = callback; emit(`${marker}:ready\n`); },
      write: () => {
        queueMicrotask(() => {
          if (++writes === 1) {
            emit(`${marker}:start\n`);
            if (fault === "timeout") return;
            if (fault === "invalid base64") emit("data:not!base64\n");
            else if (fault === "oversized frame") emit(`data:${"a".repeat(6 * 1024 * 1024)}`);
            else emit(`data:${Buffer.from("partial archive").toString("base64")}\n`);
          } else {
            if (fault === "tar failure") emit(`${marker}:done\n`);
            end({ exitCode: fault === "tar failure" ? 2 : fault === "transport loss" ? null : 0, transportClosed: fault === "transport loss" });
          }
        });
      },
      wait: () => completion,
      kill: () => {},
      close,
    } satisfies DuplexChannelSession;
  });
  await expect(streamSandboxArchive({ process: {} as never, cwd: "/workspace", archiveScript: "tar -cf - .", destination: path.join(root, "archive.tar"), maxBytes: fault === "archive budget" ? 8 : 1024, timeoutSeconds: fault === "timeout" ? 0.02 : 5 })).rejects.toThrow(/archive stream/i);
  if (fault === "host reserve" || fault === "archive budget") expect((await fs.stat(path.join(root, "archive.tar"))).size).toBe(0);
  expect(close).toHaveBeenCalledOnce();
});

it("closes the host file and bounds a stalled provider teardown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-stream-"));
  roots.push(root);
  vi.useFakeTimers();
  const close = vi.fn(() => new Promise<void>(() => {}));
  openSession.mockResolvedValue({ onData: vi.fn(), write: vi.fn(), wait: () => new Promise(() => {}), kill: vi.fn(), close });
  const transfer = streamSandboxArchive({ process: {} as never, cwd: "/workspace", archiveScript: "tar -cf - .", destination: path.join(root, "archive.tar"), maxBytes: 1024, timeoutSeconds: 0.02 });
  const rejected = expect(transfer).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(openSession).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(20);
  const file = await vi.mocked(open).mock.results[0].value;
  await vi.waitFor(async () => { await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" }); });
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect(close).toHaveBeenCalledOnce();
});

it("closes a session that connects after the deadline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-stream-"));
  roots.push(root);
  let connect!: (session: DuplexChannelSession) => void;
  openSession.mockReturnValue(new Promise<DuplexChannelSession>(resolve => { connect = resolve; }));
  await expect(streamSandboxArchive({ process: {} as never, cwd: "/workspace", archiveScript: "tar -cf - .", destination: path.join(root, "archive.tar"), maxBytes: 1024, timeoutSeconds: 0.02 })).rejects.toThrow("timed out");
  const close = vi.fn(async () => {});
  const onData = vi.fn();
  connect({ close, onData, write: vi.fn(), wait: vi.fn(), kill: vi.fn() });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(onData).not.toHaveBeenCalled();
});
