const schedule = globalThis.setTimeout;

export function drainQueuedTimers(): Promise<void> {
  return new Promise((resolve) => {
    schedule(resolve, 0);
  });
}
