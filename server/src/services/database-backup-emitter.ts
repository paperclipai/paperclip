export type DatabaseBackupEmitterLease = {
  readonly lost: Promise<void>;
  isHeld(): boolean;
  release(): Promise<void>;
};

type TimerApi = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref(handle: unknown): void;
};

export type DatabaseBackupEmitterOptions = {
  backupIntervalMs: number;
  leadershipPollIntervalMs?: number;
  /** Grace period for active work to finish before shutdown requests abort. */
  backupStopGraceMs?: number;
  /** Maximum join wait after abort before shutdown continues. */
  backupCancellationWaitMs?: number;
  /** Maximum shutdown wait for an in-progress leadership acquisition. */
  electionStopWaitMs?: number;
  /** Maximum shutdown wait for a leadership lease to release. */
  leaseReleaseWaitMs?: number;
  acquireLease(): Promise<DatabaseBackupEmitterLease | null>;
  getLastSuccessfulBackupAtMs(): Promise<number | null>;
  runBackup(signal: AbortSignal): Promise<void>;
  onLeadershipAcquired?(): void;
  onLeadershipUnavailable?(): void;
  onLeadershipLost?(): void;
  onLeadershipError?(error: unknown): void;
  onBackupError?(error: unknown): void;
  now?(): number;
  timers?: TimerApi;
};

export type DatabaseBackupEmitter = {
  start(): Promise<void>;
  stop(): Promise<void>;
  attemptLeadership(): Promise<void>;
  isLeader(): boolean;
};

const productionTimers: TimerApi = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  unref: (handle) => {
    (handle as ReturnType<typeof setInterval>).unref?.();
  },
};

/**
 * Coordinate a single automatic-backup emitter across multiple server
 * processes. Every process polls for leadership, but only the process holding
 * the database session lease owns a backup timer. Session loss clears emission
 * immediately; another process can then acquire leadership on its next poll.
 */
export function createDatabaseBackupEmitter(
  options: DatabaseBackupEmitterOptions,
): DatabaseBackupEmitter {
  const timers = options.timers ?? productionTimers;
  const now = options.now ?? Date.now;
  const backupIntervalMs = Math.max(1, Math.trunc(options.backupIntervalMs));
  const leadershipPollIntervalMs = Math.max(
    1,
    Math.trunc(
      options.leadershipPollIntervalMs ?? Math.min(60_000, backupIntervalMs),
    ),
  );
  const backupStopGraceMs = Math.max(
    0,
    Math.trunc(options.backupStopGraceMs ?? 30_000),
  );
  const backupCancellationWaitMs = Math.max(
    1,
    Math.trunc(options.backupCancellationWaitMs ?? 5_000),
  );
  const electionStopWaitMs = Math.max(
    1,
    Math.trunc(options.electionStopWaitMs ?? 5_000),
  );
  const leaseReleaseWaitMs = Math.max(
    1,
    Math.trunc(options.leaseReleaseWaitMs ?? 5_000),
  );

  let started = false;
  let stopped = false;
  let leadershipLease: DatabaseBackupEmitterLease | null = null;
  let leadershipPollTimer: unknown = null;
  let backupTimer: unknown = null;
  let electionPromise: Promise<void> | null = null;
  let backupWorkPromise: Promise<void> | null = null;
  let backupWorkController: AbortController | null = null;

  const clearBackupTimer = () => {
    if (backupTimer === null) return;
    timers.clearTimeout(backupTimer);
    backupTimer = null;
  };

  const stillLeads = (lease: DatabaseBackupEmitterLease) =>
    !stopped && leadershipLease === lease && lease.isHeld();

  const observeLeaseLoss = async (lease: DatabaseBackupEmitterLease) => {
    await lease.lost;
    if (stopped || leadershipLease !== lease) return;
    leadershipLease = null;
    clearBackupTimer();
    backupWorkController?.abort(
      new Error("Automatic database-backup emitter lease was lost"),
    );
    options.onLeadershipLost?.();
  };

  const waitForSettlement = async (
    promise: Promise<unknown>,
    timeoutMs: number,
  ): Promise<boolean> => new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      resolve(value);
    };
    const timeout = timers.setTimeout(() => finish(false), timeoutMs);
    timers.unref(timeout);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });

  const releaseLeaseWithinDeadline = async (
    lease: DatabaseBackupEmitterLease,
  ): Promise<void> => {
    let releaseError: unknown = null;
    const release = Promise.resolve()
      .then(() => lease.release())
      .catch((error) => {
        releaseError = error;
      });
    const released = await waitForSettlement(release, leaseReleaseWaitMs);
    if (!released) {
      options.onLeadershipError?.(
        new Error("Timed out releasing automatic database-backup emitter lease"),
      );
      return;
    }
    if (releaseError) options.onLeadershipError?.(releaseError);
  };

  const scheduleBackupCheck = (
    lease: DatabaseBackupEmitterLease,
    delayMs: number,
  ) => {
    if (!stillLeads(lease)) return;
    clearBackupTimer();
    backupTimer = timers.setTimeout(() => {
      backupTimer = null;
      if (backupWorkPromise || !stillLeads(lease)) return;
      const work = evaluateBackupSchedule(lease);
      backupWorkPromise = work;
      void work.finally(() => {
        if (backupWorkPromise === work) backupWorkPromise = null;
      });
    }, Math.max(0, Math.trunc(delayMs)));
    timers.unref(backupTimer);
  };

  const evaluateBackupSchedule = async (
    lease: DatabaseBackupEmitterLease,
    runIfDue = true,
  ) => {
    if (!stillLeads(lease)) return;

    let lastSuccessfulBackupAtMs: number | null;
    try {
      lastSuccessfulBackupAtMs = await options.getLastSuccessfulBackupAtMs();
    } catch (error) {
      options.onBackupError?.(error);
      scheduleBackupCheck(lease, leadershipPollIntervalMs);
      return;
    }

    if (!stillLeads(lease)) return;
    const elapsedMs = lastSuccessfulBackupAtMs === null
      ? backupIntervalMs
      : Math.max(0, now() - lastSuccessfulBackupAtMs);
    const remainingMs = Math.max(0, backupIntervalMs - elapsedMs);
    if (remainingMs > 0) {
      scheduleBackupCheck(lease, remainingMs);
      return;
    }
    if (!runIfDue) {
      scheduleBackupCheck(lease, 0);
      return;
    }

    const controller = new AbortController();
    backupWorkController = controller;
    try {
      await options.runBackup(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        options.onBackupError?.(error);
      }
      if (stillLeads(lease)) {
        scheduleBackupCheck(lease, leadershipPollIntervalMs);
      }
      return;
    } finally {
      if (backupWorkController === controller) {
        backupWorkController = null;
      }
    }

    if (stillLeads(lease)) {
      scheduleBackupCheck(lease, backupIntervalMs);
    }
  };

  const attemptLeadership = async () => {
    if (stopped || leadershipLease || electionPromise) return;

    electionPromise = (async () => {
      let lease: DatabaseBackupEmitterLease | null;
      try {
        lease = await options.acquireLease();
      } catch (error) {
        options.onLeadershipError?.(error);
        return;
      }

      if (!lease) {
        options.onLeadershipUnavailable?.();
        return;
      }

      if (stopped) {
        await releaseLeaseWithinDeadline(lease);
        return;
      }

      leadershipLease = lease;
      // Attach the loss observer before any awaited cadence lookup. A lease
      // that disappears during that lookup must never be reported acquired.
      void observeLeaseLoss(lease);
      // Do not make HTTP startup wait for pg_dump. An overdue or missing
      // recovery point is queued for the next event-loop turn instead.
      await evaluateBackupSchedule(lease, false);
      if (!stillLeads(lease)) return;
      options.onLeadershipAcquired?.();
    })();

    try {
      await electionPromise;
    } finally {
      electionPromise = null;
    }
  };

  const start = async () => {
    if (started) return;
    started = true;
    stopped = false;
    leadershipPollTimer = timers.setInterval(() => {
      void attemptLeadership();
    }, leadershipPollIntervalMs);
    timers.unref(leadershipPollTimer);
    await attemptLeadership();
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (leadershipPollTimer !== null) {
      timers.clearInterval(leadershipPollTimer);
      leadershipPollTimer = null;
    }
    clearBackupTimer();

    const pendingElection = electionPromise;
    if (pendingElection) {
      await waitForSettlement(pendingElection, electionStopWaitMs);
    }
    const pendingBackupWork = backupWorkPromise;
    if (pendingBackupWork) {
      const completedDuringGrace = await waitForSettlement(
        pendingBackupWork,
        backupStopGraceMs,
      );
      if (!completedDuringGrace) {
        backupWorkController?.abort(
          new Error("Automatic database backup cancelled during shutdown"),
        );
        await waitForSettlement(pendingBackupWork, backupCancellationWaitMs);
      }
    }

    const lease = leadershipLease;
    leadershipLease = null;
    if (lease) await releaseLeaseWithinDeadline(lease);
  };

  return {
    start,
    stop,
    attemptLeadership,
    isLeader: () => leadershipLease?.isHeld() === true,
  };
}
