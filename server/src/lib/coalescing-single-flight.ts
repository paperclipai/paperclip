export function createCoalescingSingleFlight(run: () => Promise<void>) {
  let inFlight: Promise<void> | null = null;
  let rerunRequested = false;

  const drain = async () => {
    let firstError: unknown = null;
    do {
      rerunRequested = false;
      try {
        await run();
      } catch (error) {
        firstError ??= error;
      }
    } while (rerunRequested);
    if (firstError) throw firstError;
  };

  return {
    trigger() {
      if (inFlight) {
        rerunRequested = true;
        return inFlight;
      }

      let active!: Promise<void>;
      active = drain().finally(() => {
        if (inFlight === active) inFlight = null;
      });
      inFlight = active;
      return active;
    },
    isRunning() {
      return inFlight !== null;
    },
  };
}

export type StartupThenPeriodicPhase = "startup" | "periodic";

export function createStartupThenPeriodicSingleFlight(
  run: (phase: StartupThenPeriodicPhase) => Promise<void>,
  onError: (error: unknown, phase: StartupThenPeriodicPhase) => void,
) {
  let startupPending = true;
  return createCoalescingSingleFlight(async () => {
    const phase = startupPending ? "startup" : "periodic";
    try {
      await run(phase);
      if (phase === "startup") startupPending = false;
    } catch (error) {
      // A failed startup pass remains startup-pending. The next trigger must run
      // the full startup semantics again rather than silently downgrading to the
      // periodic stale threshold after partial recovery.
      onError(error, phase);
    }
  });
}
