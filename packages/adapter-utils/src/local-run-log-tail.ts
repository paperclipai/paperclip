import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// AGE-656: local (same-host) counterpart to `SandboxRunLogTailFactory`
// (`./sandbox-run-log-stream.ts`). That factory tails output through a
// remote `CommandManagedRuntimeRunner.execute()` RPC because a sandbox
// provider has no direct filesystem access; a local child process's log
// file is already on this host's disk, so this tailer reads it directly
// with a simple poll loop instead of round-tripping through a shell tick
// script. Same shape (append-only file -> incremental `onLog` chunks), no
// second wire protocol.
//
// Used by `runChildProcess` in `server-utils.ts` when a run's stdout/stderr
// are backed by files instead of pipes, so the read side survives losing
// the process that first opened the file (a control-plane restart) as long
// as it re-tails from a remembered byte offset.
//
// Deliberately NOT `fs.watch`: a `runChildProcess` caller can legitimately
// abandon a still-running process without killing it (the sandbox/remote
// "process session" bridge documents exactly this — "execute has no
// cancel, so a lingering process cannot be forced to resolve" — and keeps
// it alive up to its full timeout). That means many tails can be
// simultaneously alive for a while after their own test/caller has moved
// on. `fs.watch` (inotify on Linux) is a per-instance kernel resource with
// a small default ceiling (`fs.inotify.max_user_instances`, 128 on a
// standard host) shared across every process for the whole user — two
// watchers per spawn (stdout + stderr) exhausts that under real load and
// surfaces as confusing, unrelated `spawn` failures elsewhere on the host
// (reproduced in CI: `ENOENT spawn /usr/bin/sh` while running
// `execution-target-sandbox.test.ts` grouped with other suites). A poll
// loop has no such hard ceiling — it costs CPU/syscalls per tick, which
// scales down cleanly (slower interval, less cost) instead of hitting a
// wall. Matches the existing `SandboxRunLogTailFactory` precedent
// (`DEFAULT_TAIL_POLL_INTERVAL_MS = 250` in `sandbox-run-log-stream.ts`).
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface LocalRunLogTailHandle {
  /** Begin polling; safe to call once. Chunks flow to `onLog` as they land. */
  start(onLog: (chunk: string) => void | Promise<void>): void;
  /**
   * Stop polling. Performs one final read past the last-seen offset so a
   * chunk written between the last tick and process exit is not dropped,
   * then flushes any bytes buffered mid-multibyte-character in the decoder.
   */
  stop(): Promise<void>;
  /** Byte offset already delivered to `onLog`. Persist this to resume a tail across a process restart. */
  offset(): number;
}

export interface LocalRunLogTailOptions {
  pollIntervalMs?: number;
  /** Resume tailing from this byte offset instead of the start of the file (adoption/reattach path). */
  startOffset?: number;
}

export function createLocalRunLogTail(
  logFilePath: string,
  options: LocalRunLogTailOptions = {},
): LocalRunLogTailHandle {
  const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  let currentOffset = options.startOffset && options.startOffset > 0 ? Math.trunc(options.startOffset) : 0;
  const decoder = new StringDecoder("utf8");
  let sink: ((chunk: string) => void | Promise<void>) | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickChain: Promise<void> = Promise.resolve();

  async function tickOnce(): Promise<void> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(logFilePath, "r");
      const stat = await handle.stat();
      if (stat.size <= currentOffset) return;
      const length = stat.size - currentOffset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, currentOffset);
      if (bytesRead <= 0) return;
      currentOffset += bytesRead;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      if (text.length > 0 && sink) {
        await sink(text);
      }
    } catch (err) {
      // The log file may not exist yet in the brief window between spawn
      // and the child's first write; treat as "nothing to read yet" rather
      // than a hard failure. Any other error is swallowed too — a stalled
      // tail must never take the run down, it only degrades live streaming
      // (the file itself remains the durable record).
      void err;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      tickChain = tickChain.then(tickOnce).finally(scheduleNext);
    }, pollIntervalMs);
  }

  return {
    start(onLog) {
      if (sink || stopped) return;
      sink = onLog;
      scheduleNext();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await tickChain;
      await tickOnce();
      const rest = decoder.end();
      if (rest.length > 0 && sink) {
        await sink(rest);
      }
    },
    offset() {
      return currentOffset;
    },
  };
}
