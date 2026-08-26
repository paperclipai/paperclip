// A single-flight gate for periodic work scheduled on a fixed interval.
//
// An interval timer fires whether or not the previous invocation finished.
// When one invocation slows past the interval (a congested control plane is
// exactly when maintenance chains get slow), each new tick stacks another
// full copy of the work on top of the running one, which amplifies the
// congestion that made the first copy slow. The gate keeps at most one
// invocation in flight and reports a skipped tick to the caller instead,
// so periodic work degrades to "runs less often" rather than "piles up".
export interface SingleFlightSkip {
  started: false;
  // How long the in-flight invocation has been running, so the caller can
  // log a skip with enough context to spot a wedged chain.
  inFlightForMs: number;
}

export interface SingleFlightStart {
  started: true;
  // Settles when the invocation settles. Never rejects: the gate exists for
  // fire-and-forget interval work, so the caller's own error handling stays
  // the only consumer of the failure.
  settled: Promise<void>;
}

export type SingleFlightResult = SingleFlightSkip | SingleFlightStart;

export function createSingleFlight(now: () => number = Date.now) {
  let inFlight: Promise<void> | null = null;
  let startedAtMs = 0;

  return {
    // True while an invocation is running.
    get busy(): boolean {
      return inFlight !== null;
    },
    run(work: () => Promise<unknown>): SingleFlightResult {
      if (inFlight) {
        return { started: false, inFlightForMs: now() - startedAtMs };
      }
      startedAtMs = now();
      // Invoke synchronously so the work starts on this tick, not a microtask
      // later. A synchronous throw means nothing was admitted: the gate stays
      // free and the exception propagates to the caller's tick-level error
      // handling instead of settling silently.
      const settled = Promise.resolve(work())
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          inFlight = null;
        });
      inFlight = settled;
      return { started: true, settled };
    },
  };
}
