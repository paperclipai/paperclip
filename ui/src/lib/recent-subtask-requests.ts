/** Shared across sidebar groups. Aborted queued reads never start HTTP work. */
export const RECENT_SUBTASK_CONCURRENCY = 3;
let active = 0;
const waiting = new Set<() => void>();

export async function readRecentSubtasks<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      waiting.delete(start);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      if (active >= RECENT_SUBTASK_CONCURRENCY) return;
      waiting.delete(start);
      signal.removeEventListener("abort", abort);
      active++;
      resolve();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    waiting.add(start);
    start();
  });
  try {
    signal.throwIfAborted();
    return await read();
  } finally {
    active--;
    for (const start of waiting) {
      if (active >= RECENT_SUBTASK_CONCURRENCY) break;
      start();
    }
  }
}
