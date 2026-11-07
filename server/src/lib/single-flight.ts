export interface SingleFlightSkip {
  started: false;
  inFlightForMs: number;
}

export interface SingleFlightStart {
  started: true;
  settled: Promise<void>;
}

export type SingleFlightResult = SingleFlightSkip | SingleFlightStart;

export function createSingleFlight(now: () => number = Date.now) {
  let inFlight: Promise<void> | null = null;
  let startedAtMs = 0;

  return {
    get busy(): boolean {
      return inFlight !== null;
    },
    run(work: () => Promise<unknown>): SingleFlightResult {
      if (inFlight) {
        return { started: false, inFlightForMs: now() - startedAtMs };
      }
      startedAtMs = now();
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

export function createTrackedSingleFlight(options: {
  trackWork: (work: Promise<void>) => void;
  onSkipped: (inFlightForMs: number) => void;
  now?: () => number;
}) {
  const gate = createSingleFlight(options.now);
  return (work: () => Promise<unknown>) => {
    const tick = gate.run(work);
    if (tick.started) options.trackWork(tick.settled);
    else options.onSkipped(tick.inFlightForMs);
  };
}
