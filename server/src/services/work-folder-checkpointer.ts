import { WORK_FOLDER_SYNC_INTERVAL_MS } from "@paperclipai/shared";

/** One scheduler for both execution generations. A tick never queues a backlog. */
export function startWorkFolderCheckpointer(input: {
  checkpoint(): Promise<void>;
  onError(error: unknown): Promise<void>;
}) {
  let active: Promise<void> | null = null;
  let finalFlush: Promise<void> | null = null;
  let stopped = false;
  function checkpoint() {
    const pending = (async () => {
      try { await input.checkpoint(); }
      catch (error) { await input.onError(error); throw error; }
    })();
    active = pending;
    void pending.finally(() => { if (active === pending) active = null; }).catch(() => {});
    return pending;
  }
  const timer = setInterval(() => {
    if (!stopped && !active) void checkpoint().catch(() => {});
  }, WORK_FOLDER_SYNC_INTERVAL_MS);
  timer.unref();
  // Explicit flushes serialize too. They must checkpoint once more after an
  // in-flight tick, since the agent may have edited during that tick.
  let flushTail: Promise<void> = Promise.resolve();
  function flush() {
    const pending = flushTail.catch(() => {}).then(async () => {
      await active?.catch(() => {});
      await checkpoint();
    });
    flushTail = pending;
    return pending;
  }
  return {
    flush,
    stop() {
      stopped = true;
      clearInterval(timer);
      // Success and error teardown can both call stop. Never begin another
      // save after the caller has already terminalized this run on failure.
      finalFlush ??= flush();
      return finalFlush;
    },
  };
}
