import type { Response } from "express";

const active = new Set<Response>();

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
