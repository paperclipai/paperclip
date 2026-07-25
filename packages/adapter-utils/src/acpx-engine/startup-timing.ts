import type { AdapterExecutionContext, AdapterRuntimeEvent } from "../types.js";

/**
 * Structured event emitted once per named sandbox run-startup boundary so the
 * duration of each bring-up step lands in the `heartbeat_run_events` stream
 * (jsonb `payload`) beside the existing "run started" / "adapter invocation"
 * anchors. Observability-only — it rides the existing
 * `ctx.onEvent → onAdapterEvent → appendRunEvent` bridge with no schema change.
 */
export const RUN_STARTUP_STEP_EVENT_TYPE = "run.startup.step";

function buildStepEvent(step: string, durationMs: number): AdapterRuntimeEvent {
  return {
    eventType: RUN_STARTUP_STEP_EVENT_TYPE,
    stream: "system",
    level: "info",
    message: `startup step: ${step} (${durationMs}ms)`,
    payload: { step, durationMs },
  };
}

/**
 * Time `fn` with the injected `now` clock and emit exactly one
 * `run.startup.step` event carrying `{ step, durationMs }`. The event fires in a
 * `finally`, so a throwing step still reports its duration before the error is
 * re-thrown. `now` is injected (never `Date.now()` here) so callers/tests stay
 * deterministic, and `ctx.onEvent` is optional — a missing sink is a no-op that
 * neither throws nor swallows `fn`'s return value or error.
 */
export async function measureStartupStep<T>(
  ctx: Pick<AdapterExecutionContext, "onEvent">,
  now: () => number,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    const durationMs = now() - start;
    try {
      await ctx.onEvent?.(buildStepEvent(step, durationMs));
    } catch {
      // Observability must not change startup control flow.
    }
  }
}
