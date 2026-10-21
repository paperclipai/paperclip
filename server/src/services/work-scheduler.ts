/** In-process deadlines. Owners restore durable tasks at startup. */
export function createWorkScheduler() {
  const tasks = new Map<string, { at: number; run: () => void }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const nextWakeAt = () => tasks.size ? Math.min(...Array.from(tasks.values(), task => task.at)) : null;

  function arm() {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = nextWakeAt();
    if (stopped || next === null) return;
    timer = setTimeout(() => {
      timer = null;
      const now = Date.now();
      const due = Array.from(tasks.entries()).filter(([, task]) => task.at <= now);
      for (const [key, task] of due) {
        // Another due callback can cancel or replace this task.
        if (tasks.get(key) !== task) continue;
        tasks.delete(key);
        try { task.run(); }
        catch (error) { process.emitWarning(`Scheduled work failed: ${String(error)}`); }
      }
      arm();
    }, Math.min(2_147_483_647, Math.max(0, next - Date.now())));
    timer.unref?.();
  }

  return {
    nextWakeAt,
    schedule(key: string, at: number, run: () => void) {
      if (stopped) return;
      if (!Number.isFinite(at)) throw new Error("Work deadline must be finite");
      tasks.set(key, { at, run });
      arm();
    },
    cancel(key: string) { tasks.delete(key); arm(); },
    stop() {
      stopped = true;
      tasks.clear();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
