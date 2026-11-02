const EMBEDDED_POSTGRES_EXIT_EVENTS = [
  "exit",
  "beforeExit",
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
  "SIGBREAK",
  "message",
] as const;

type EmbeddedPostgresExitTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * embedded-postgres installs async-exit-hook listeners as an import side effect.
 * Paperclip-managed clusters have an explicit owner and shutdown path, so those
 * global listeners must not be allowed to stop a cluster independently of that
 * owner (for example while a worktree seed restore is still streaming).
 *
 * Remove only listeners added by the supplied import and preserve every listener
 * that was already registered by Paperclip or its host process.
 */
export async function loadWithoutEmbeddedPostgresExitHooks<T>(
  load: () => Promise<T>,
  target: EmbeddedPostgresExitTarget = process,
): Promise<T> {
  const listenersBeforeLoad = new Map(
    EMBEDDED_POSTGRES_EXIT_EVENTS.map((eventName) => [
      eventName,
      target.rawListeners(eventName),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const eventName of EMBEDDED_POSTGRES_EXIT_EVENTS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(eventName) ?? [])];
      for (const listener of target.rawListeners(eventName)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        target.removeListener(eventName, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}
