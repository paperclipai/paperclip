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

function adapterStopTimeoutError(
  settled: Promise<void>,
  timeoutMs: number,
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
  return new AdapterStopTimeoutError(timeoutMs, {
    ...diagnostics,
    phase: undefined,
    phaseElapsedMs: undefined,
    ...currentPhase(),
  });
}

export async function waitForAdapterStop(
  settled: Promise<void>,
  timeoutMs = 60_000,
  diagnostics?: AdapterStopContext,
  owner?: ReturnType<typeof createAdapterExecutionControl>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(adapterStopTimeoutError(settled, timeoutMs, diagnostics, owner)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A Stop request's wait is a response budget, not the adapter's settlement
// bound: workspace sync-back and cooperative provider cancellation routinely
// settle a few minutes after it. Only a Stop still unsettled this long after
// it was requested is an operational failure worth reporting.
export const UNSETTLED_ADAPTER_STOP_REPORT_MS = 10 * 60_000;
const watchedAdapterStops = new WeakSet<Promise<void>>();

/** Reports at most once per execution, and only if it never settles in time. */
export function reportAdapterStopIfUnsettled(
  settled: Promise<void>,
  report: (error: AdapterStopTimeoutError) => void,
  diagnostics?: AdapterStopContext,
  owner?: ReturnType<typeof createAdapterExecutionControl>,
  {
    stopRequestedAt = Date.now(),
    reportAfterMs = UNSETTLED_ADAPTER_STOP_REPORT_MS,
  }: { stopRequestedAt?: number; reportAfterMs?: number } = {},
) {
  if (watchedAdapterStops.has(settled)) return;
  watchedAdapterStops.add(settled);
  let done = false;
  // The bound runs from the Stop request, which already spent its response wait.
  const remainingMs = Math.max(0, stopRequestedAt + reportAfterMs - Date.now());
  const timer = setTimeout(() => {
    if (done) return;
    try {
      report(adapterStopTimeoutError(settled, reportAfterMs, diagnostics, owner));
    } catch {
      // Reporting is diagnostic only.
    }
  }, remainingMs);
  // Never hold process shutdown open for a diagnostic.
  timer.unref?.();
  void settled.then(() => {
    done = true;
    clearTimeout(timer);
  });
}
