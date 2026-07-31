type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownLifecycleContext = {
  controlEvent: ShutdownSignal;
  parentPid: number;
  launcherIdentity: string;
  uptimeMs: number;
  shutdownInitiator: "hot_restart_intent" | "process_signal";
  preserveEmbeddedPostgres: boolean;
};

export function createShutdownLifecycleContext(input: {
  signal: ShutdownSignal;
  hotRestart: HotRestartShutdownPreparation | null;
  parentPid?: number;
  launcherIdentity?: string;
  uptimeMs?: number;
}): ShutdownLifecycleContext {
  const preserveEmbeddedPostgres = input.hotRestart?.skipDrain === true;
  return {
    controlEvent: input.signal,
    parentPid: input.parentPid ?? process.ppid,
    launcherIdentity: input.launcherIdentity ?? "unknown",
    uptimeMs: input.uptimeMs ?? Math.round(process.uptime() * 1_000),
    shutdownInitiator: preserveEmbeddedPostgres ? "hot_restart_intent" : "process_signal",
    preserveEmbeddedPostgres,
  };
}

export function adoptEmbeddedPostgres(input: {
  adopt: () => void;
  stop: () => Promise<void>;
}): () => Promise<void> {
  input.adopt();
  return () => input.stop();
}

export async function coordinateEmbeddedPostgresShutdown(input: {
  ownedByThisProcess: boolean;
  stop: (() => Promise<void>) | null;
  lifecycle: ShutdownLifecycleContext;
}): Promise<"not_owned" | "preserved_for_hot_restart" | "stopped"> {
  if (!input.ownedByThisProcess || !input.stop) return "not_owned";
  if (input.lifecycle.preserveEmbeddedPostgres) return "preserved_for_hot_restart";
  await input.stop();
  return "stopped";
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: ShutdownSignal;
  prepareHotRestartShutdown: ((signal: ShutdownSignal) => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  if (hotRestart?.skipDrain) {
    return {
      hotRestart,
      preparationError,
      waitedForSchedulerIdle: false,
    };
  }

  await input.waitForHeartbeatSchedulerIdle();
  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
