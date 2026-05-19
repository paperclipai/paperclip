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
    for (const res of snapshot) {
      try {
        if (res.writable) {
          res.write(`event: shutdown\ndata: ${payload}\n\n`);
          res.end();
        }
      } catch {
        // best effort — broken pipes / already-closed responses are fine
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      for (const res of Array.from(active)) {
        if (!res.writable) active.delete(res);
      }
    }
    active.clear();
  },
};
