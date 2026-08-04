import type {
  EmbeddedPostgresHandoff,
  EmbeddedPostgresHandoffClaim,
} from "./services/hot-restart.js";

type HotRestartShutdownPreparation = {
  skipDrain: boolean;
  preserveEmbeddedPostgres?: boolean;
};

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGBREAK";

export type ShutdownLifecycleContext = {
  controlEvent: ShutdownSignal;
  parentPid: number;
  launcherIdentity: string;
  uptimeMs: number;
  shutdownInitiator: "hot_restart_intent" | "process_signal";
  preserveEmbeddedPostgres: boolean;
};

export function createEmbeddedPostgresHandoffLogContext(
  handoff: EmbeddedPostgresHandoff | EmbeddedPostgresHandoffClaim,
) {
  return {
    postgresPid: handoff.postgres.pid,
    port: handoff.postgres.port,
    predecessorServerPid: handoff.predecessorServerPid,
    ...("replacementServerPid" in handoff
      ? { replacementServerPid: handoff.replacementServerPid }
      : {}),
    expiresAt: handoff.expiresAt,
  };
}

export async function restoreAbortedHotRestartPredecessor(input: {
  signal: ShutdownSignal;
  restartHeartbeatScheduler: () => void;
  notifyServiceManager: (args: string[]) => Promise<boolean>;
}): Promise<boolean> {
  input.restartHeartbeatScheduler();
  return await input.notifyServiceManager([
    "--ready",
    `--status=Hot restart aborted after ${input.signal}; predecessor remains operational`,
  ]);
}

export function createShutdownLifecycleContext(input: {
  signal: ShutdownSignal;
  hotRestart: HotRestartShutdownPreparation | null;
  parentPid?: number;
  launcherIdentity?: string;
  uptimeMs?: number;
}): ShutdownLifecycleContext {
  const preserveEmbeddedPostgres = input.hotRestart?.preserveEmbeddedPostgres === true;
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
}, claim: EmbeddedPostgresHandoffClaim | null): (() => Promise<void>) | null {
  if (!claim) return null;
  input.adopt();
  return () => input.stop();
}

export async function coordinateEmbeddedPostgresShutdown(input: {
  ownedByThisProcess: boolean;
  stop: (() => Promise<void>) | null;
  lifecycle: ShutdownLifecycleContext;
  persistHotRestartHandoff?: () => Promise<void>;
  onHotRestartHandoffFailure?: (error: unknown) => void;
}): Promise<"not_owned" | "preserved_for_hot_restart" | "stopped"> {
  if (!input.ownedByThisProcess || !input.stop) return "not_owned";
  if (input.lifecycle.preserveEmbeddedPostgres && input.persistHotRestartHandoff) {
    try {
      await input.persistHotRestartHandoff();
      return "preserved_for_hot_restart";
    } catch (error) {
      try {
        input.onHotRestartHandoffFailure?.(error);
      } catch {
        // Diagnostic callbacks must never bypass the failure-closed stop below.
      }
    }
  }
  await input.stop();
  return "stopped";
}

export async function prepareEmbeddedPostgresForHotRestart(input: {
  ownedByThisProcess: boolean;
  stop: (() => Promise<void>) | null;
  lifecycle: ShutdownLifecycleContext;
  persistHotRestartHandoff?: () => Promise<void>;
  onHotRestartHandoffFailure?: (error: unknown) => void;
  restorePredecessor: () => void | Promise<void>;
  onPreTeardownFailure?: (error: unknown) => void;
}): Promise<"not_owned" | "preserved_for_hot_restart" | "stopped" | "aborted"> {
  try {
    return await coordinateEmbeddedPostgresShutdown({
      ownedByThisProcess: input.ownedByThisProcess,
      stop: input.stop,
      lifecycle: input.lifecycle,
      persistHotRestartHandoff: input.persistHotRestartHandoff,
      onHotRestartHandoffFailure: input.onHotRestartHandoffFailure,
    });
  } catch (error) {
    try {
      input.onPreTeardownFailure?.(error);
    } catch {
      // Diagnostic callbacks must not prevent predecessor recovery.
    }
    await input.restorePredecessor();
    return "aborted";
  }
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
