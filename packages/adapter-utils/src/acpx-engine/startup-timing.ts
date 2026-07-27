import type { AdapterExecutionContext, AdapterRuntimeEvent } from "../types.js";

/**
 * Structured event emitted once per named sandbox run-startup boundary so the
 * duration of each bring-up step lands in the `heartbeat_run_events` stream
 * (jsonb `payload`) beside the existing "run started" / "adapter invocation"
 * anchors. Observability-only — it rides the existing
 * `ctx.onEvent → onAdapterEvent → appendRunEvent` bridge with no schema change.
 */
export const RUN_STARTUP_STEP_EVENT_TYPE = "run.startup.step";

/**
 * Optional per-step attribution attached to a `run.startup.step` event, all
 * additive to the free-form jsonb payload (no schema change). Each reader is a
 * plain `() => number` closure so the timing helper stays decoupled from the
 * runner/provider it reads (Risk R1): `measureStartupStep` snapshots the reader
 * before `fn` and again in `finally`, emitting the delta.
 *
 * - `roundTrips` — cumulative host→sandbox `runner.execute` count; the delta is
 *   how many round-trips the step performed (Open Q1, host boundary).
 * - `providerExecMs` / `providerGetMs` — cumulative provider-reported wall-time
 *   (ms) for the `executeCommand` REST call vs the `client.get` sandbox
 *   re-fetch; the delta attributes the step's round-trip time to its parts
 *   (Open Q1, finer provider attribution).
 * - `extra` — a reader (called once in `finally`, after `fn` settles) returning
 *   any additional numeric fields to merge into the payload; used by
 *   `acp.handshake` to carry its `createRuntimeMs` / `ensureSessionMs` sub-split
 *   (Open Q2), which are measured by the caller rather than read from a counter.
 */
export interface StartupStepMeasureOptions {
  roundTrips?: () => number;
  providerExecMs?: () => number;
  providerGetMs?: () => number;
  extra?: () => Record<string, number>;
}

function buildStepEvent(payload: Record<string, unknown>): AdapterRuntimeEvent {
  const step = String(payload.step);
  const durationMs = payload.durationMs as number;
  return {
    eventType: RUN_STARTUP_STEP_EVENT_TYPE,
    stream: "system",
    level: "info",
    message: `startup step: ${step} (${durationMs}ms)`,
    payload,
  };
}

/**
 * Time `fn` with the injected `now` clock and emit exactly one
 * `run.startup.step` event carrying `{ step, durationMs }` plus any counters
 * supplied via `options`. The event fires in a `finally`, so a throwing step
 * still reports its duration before the error is re-thrown. `now` is injected
 * (never `Date.now()` here) so callers/tests stay deterministic, and
 * `ctx.onEvent` is optional — a missing sink is a no-op that neither throws nor
 * swallows `fn`'s return value or error. A step skipped by a warm cache never
 * calls this helper, so it emits no event (never a zero).
 */
export async function measureStartupStep<T>(
  ctx: Pick<AdapterExecutionContext, "onEvent">,
  now: () => number,
  step: string,
  fn: () => Promise<T>,
  options: StartupStepMeasureOptions = {},
): Promise<T> {
  const start = now();
  const roundTripsStart = options.roundTrips?.();
  const providerExecStart = options.providerExecMs?.();
  const providerGetStart = options.providerGetMs?.();
  try {
    return await fn();
  } finally {
    const durationMs = now() - start;
    const payload: Record<string, unknown> = { step, durationMs };
    if (options.roundTrips) {
      payload.roundTrips = options.roundTrips() - (roundTripsStart ?? 0);
    }
    if (options.providerExecMs) {
      payload.providerExecMs = options.providerExecMs() - (providerExecStart ?? 0);
    }
    if (options.providerGetMs) {
      payload.providerGetMs = options.providerGetMs() - (providerGetStart ?? 0);
    }
    if (options.extra) {
      Object.assign(payload, options.extra());
    }
    try {
      await ctx.onEvent?.(buildStepEvent(payload));
    } catch {
      // Observability must not change startup control flow.
    }
  }
}
