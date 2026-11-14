import { setTimeout } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export async function withWorkspaceLockKeepalive<T>(
  lock: Pick<Db, "execute">,
  idleTimeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return work();
  const stop = new AbortController();
  const interval = Math.max(1, Math.min(30_000, Math.floor(idleTimeoutMs / 3)));
  const keeper = (async () => {
    while (!stop.signal.aborted) {
      await setTimeout(interval, undefined, { signal: stop.signal, ref: false });
      await lock.execute(sql`select 1`);
    }
  })().catch(() => undefined);
  try {
    return await work();
  } finally {
    stop.abort();
    await keeper;
  }
}
