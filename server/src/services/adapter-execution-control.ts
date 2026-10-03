import { AdapterStopTimeoutError, type AdapterStopContext } from "./adapter-stop-timeout.js";
import { createAdapterExecutionPhaseTracker } from "./adapter-execution-phase.js";

/** Live adapter ownership shared by routes and scheduler service instances. */
export function createAdapterExecutionControl() {
  const controller = new AbortController();
  const phases = createAdapterExecutionPhaseTracker();
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller, settled, phases, finish: () => { phases.finish(); finish(); } };
}

export const adapterExecutionControls = new Map<
  string,
  ReturnType<typeof createAdapterExecutionControl>
>();

// A Stop with no opted-in adapter may still be awaiting its terminal write.
// Readiness must not pass that write using an earlier "running" snapshot.
// These are in-process ordering barriers, never cancellation acknowledgments.
const pendingUnregisteredAdapterStops = new Map<string, Set<Promise<void>>>();

export function captureAdapterStopOwnership(runId: string) {
  const control = adapterExecutionControls.get(runId);
  if (control) return { control, release: () => {} };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let owners = pendingUnregisteredAdapterStops.get(runId);
  if (!owners) {
    owners = new Set();
    pendingUnregisteredAdapterStops.set(runId, owners);
  }
  owners.add(settled);
  let released = false;
  return {
    control,
    release: () => {
      if (released) return;
      released = true;
      owners.delete(settled);
      if (
        owners.size === 0 &&
        pendingUnregisteredAdapterStops.get(runId) === owners
      ) {
        pendingUnregisteredAdapterStops.delete(runId);
      }
      settle();
    },
  };
}

export async function registerAdapterExecutionControl(
  runId: string,
  control: ReturnType<typeof createAdapterExecutionControl>,
) {
  // Do not expose a joinable owner while waiting: a duplicate Stop must not
  // join an adapter whose readiness is waiting for that same Stop to settle.
  for (;;) {
    const pending = pendingUnregisteredAdapterStops.get(runId);
    if (!pending?.size) break;
    await Promise.all([...pending]);
  }
  // No await between observing no earlier Stop owners and publishing readiness.
  adapterExecutionControls.set(runId, control);
}

export async function waitForAdapterStop(
  settled: Promise<void>,
  timeoutMs = 60_000,
  diagnostics?: AdapterStopContext,
  owner?: ReturnType<typeof createAdapterExecutionControl>,
) {
  const currentPhase = () => {
    try {
      return owner && owner.settled === settled && diagnostics?.runId
        && adapterExecutionControls.get(diagnostics.runId) === owner
        ? owner.phases.snapshot() : null;
    } catch {
      return null;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AdapterStopTimeoutError(timeoutMs, {
                ...diagnostics,
                phase: undefined,
                phaseElapsedMs: undefined,
                ...currentPhase(),
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
