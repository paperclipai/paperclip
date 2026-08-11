type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  await input.waitForHeartbeatSchedulerIdle();

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
