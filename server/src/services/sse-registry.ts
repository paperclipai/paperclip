import type { Response } from "express";

const active = new Set<Response>();

/**
 * Max bytes allowed to sit un-drained in an SSE response socket before the
 * connection is force-closed. An SSE client that has fallen this far behind is
 * effectively wedged; continuing to res.write() to it queues the event frames
 * as native socket buffers (off-heap) without bound — the same failure shape as
 * the plugin-worker stdin backlog addressed in #216, but for HTTP responses.
 * Disconnecting (rather than silently dropping individual frames, which would
 * corrupt the event stream) lets the browser's EventSource auto-reconnect and
 * resume cleanly.
 */
export const MAX_SSE_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * Pure predicate: should an SSE connection be closed because its un-drained
 * write backlog has exceeded the cap? Extracted for testability.
 */
export function sseBacklogExceeded(
  writableLength: number,
  cap: number = MAX_SSE_BACKLOG_BYTES,
): boolean {
  return writableLength > cap;
}

/**
 * Write an SSE frame with backpressure. Returns true if written; false if the
 * connection is not writable or was closed due to an over-cap backlog. On an
 * over-cap backlog the response is ended so the caller can tear down its
 * subscription; the browser reconnects via EventSource.
 */
export function writeSseFrame(res: Response, frame: string): boolean {
  if (!res.writable) return false;
  if (sseBacklogExceeded(res.writableLength)) {
    try {
      res.end();
    } catch {
      // already closing / broken pipe — nothing to do
    }
    return false;
  }
  try {
    res.write(frame);
    return true;
  } catch {
    return false;
  }
}

export const sseRegistry = {
  register(res: Response): void {
    active.add(res);
  },
  unregister(res: Response): void {
    active.delete(res);
  },
  size(): number {
    return active.size;
  },
  async drain(opts: { timeoutMs: number; reason: string }): Promise<void> {
    const { timeoutMs, reason } = opts;
    const payload = JSON.stringify({ reason, ts: new Date().toISOString() });
    const snapshot = Array.from(active);

    // Issue the shutdown frame + res.end() on every tracked response, then
    // await each socket's actual 'finish' (or 'close' / 'error') event. We
    // can't trust res.writable — it flips false synchronously on .end()
    // even though the kernel may still be flushing the buffered bytes, so a
    // polling check resolves the drain before the shutdown frame is on the
    // wire and process.exit then races libuv to a torn connection.
    const finishes = snapshot.map(
      (res) =>
        new Promise<void>((resolve) => {
          const done = () => {
            active.delete(res);
            resolve();
          };
          try {
            if (res.writable) {
              res.once("finish", done);
              res.once("close", done);
              res.once("error", done);
              res.write(`event: shutdown\ndata: ${payload}\n\n`);
              res.end();
            } else {
              done();
            }
          } catch {
            // best effort — broken pipes / already-closed responses are fine
            done();
          }
        }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.all(finishes), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // Anything still in active after the timeout is treated as drained — the
      // SIGTERM handler will move on; the kubelet's terminationGracePeriod
      // SIGKILL backstop bounds total shutdown time.
      active.clear();
    }
  },
};
