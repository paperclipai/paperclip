import { promises as fs, watch as watchLogFile, type FSWatcher } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// AGE-656: local (same-host) counterpart to `SandboxRunLogTailFactory`
// (`./sandbox-run-log-stream.ts`). That factory tails output through a
// remote `CommandManagedRuntimeRunner.execute()` RPC because a sandbox
// provider has no direct filesystem access; a local child process's log
// file is already on this host's disk, so this tailer reads it directly.
//
// Used by `runChildProcess` in `server-utils.ts` when a run's stdout/stderr
// are backed by files instead of pipes, so the read side survives losing
// the process that first opened the file (a control-plane restart) as long
// as it re-tails from a remembered byte offset.
//
// Wake-up is `fs.watch` (inotify on Linux), not a tight poll loop, with a
// slow poll as a correctness backstop (fs.watch can miss events on some
// filesystems/platforms) — not the primary delivery path. This matters
// because a `runChildProcess` caller can legitimately abandon a still-
// running process without killing it (the sandbox/remote "process session"
// bridge documents exactly this: "execute has no cancel, so a lingering
// process cannot be forced to resolve"). A tight poll loop is cheap in
// isolation, but that pattern means MANY tails can be simultaneously alive
// and idle for the lifetime of an abandoned process (up to its full
// `timeoutSec`), and many idle tails all doing real fs syscalls every few
// milliseconds measurably degrades an already-loaded host — confirmed via
// `packages/adapter-utils/src/execution-target-sandbox.test.ts`, which spawns
// several such abandoned sessions and intermittently timed out downstream
// tests under load with a 25ms poll, with zero fallout at the same load
// once wake-up moved to `fs.watch`.

const FALLBACK_POLL_INTERVAL_MS = 1_000;

export interface LocalRunLogTailHandle {
  /** Begin watching/polling; safe to call once. Chunks flow to `onLog` as they land. */
  start(onLog: (chunk: string) => void | Promise<void>): void;
  /**
   * Stop watching/polling. Performs one final read past the last-seen offset
   * so a chunk written between the last wake-up and process exit is not
   * dropped, then flushes any bytes buffered mid-multibyte-character in the
   * decoder.
   */
  stop(): Promise<void>;
  /** Byte offset already delivered to `onLog`. Persist this to resume a tail across a process restart. */
  offset(): number;
}

export interface LocalRunLogTailOptions {
  /** Overrides the fallback poll interval (default 1000ms). fs.watch is still the primary wake-up. */
  pollIntervalMs?: number;
  /** Resume tailing from this byte offset instead of the start of the file (adoption/reattach path). */
  startOffset?: number;
}

export function createLocalRunLogTail(
  logFilePath: string,
  options: LocalRunLogTailOptions = {},
): LocalRunLogTailHandle {
  const fallbackPollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : FALLBACK_POLL_INTERVAL_MS;
  let currentOffset = options.startOffset && options.startOffset > 0 ? Math.trunc(options.startOffset) : 0;
  const decoder = new StringDecoder("utf8");
  let sink: ((chunk: string) => void | Promise<void>) | null = null;
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
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

  function scheduleTick(): void {
    if (stopped) return;
    tickChain = tickChain.then(tickOnce).catch(() => undefined);
  }

  function startWatching(): void {
    try {
      watcher = watchLogFile(logFilePath, { persistent: false }, () => scheduleTick());
      watcher.on("error", () => {
        // Swallow — the fallback poll still covers delivery; a watch error
        // (e.g. the file was replaced, or watch is unsupported on this fs)
        // must never take the run down.
        watcher?.close();
        watcher = null;
      });
    } catch {
      // fs.watch can throw synchronously (e.g. ENOENT in a tight race with
      // the file's creation, or an unsupported filesystem). The fallback
      // poll below is the correctness backstop for exactly this case.
      watcher = null;
    }
  }

  return {
    start(onLog) {
      if (sink || stopped) return;
      sink = onLog;
      startWatching();
      fallbackTimer = setInterval(() => scheduleTick(), fallbackPollIntervalMs);
      // Covers output written between file-open and this call.
      scheduleTick();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      watcher = null;
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
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
