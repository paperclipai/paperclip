import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

/** Used when a native run reaches `failed` and no writer recorded a more specific cause. */
export const NATIVE_RUN_FAILED_UNEXPLAINED = {
  errorCode: "native_run_failed",
  error: "The native run ended in a failed state without a classified provider error. Inspect the run events for the last recorded step.",
} as const;

export type NativeRunFailureExplanation = { errorCode: string; error: string };

/**
 * A failed run must always say why. These SET expressions keep an explanation
 * already on the row, and otherwise record `fallback`. A run that is already
 * cancelled keeps its own fields, because the status writers preserve a
 * concurrent cancellation. In an UPDATE, column references read the row before
 * the update, which matches the status `case` expressions of the callers.
 *
 * `current` overrides the expression used for the existing value, for writers
 * that already compute a projected value for that field. A writer that sets
 * `failed` unconditionally passes `preserveCancelled: false`.
 */
export function explainFailedRun(
  fallback: NativeRunFailureExplanation,
  current: { errorCode?: SQL; error?: SQL; preserveCancelled?: boolean } = {},
) {
  const errorCode = current.errorCode ?? sql`${heartbeatRuns.errorCode}`;
  const error = current.error ?? sql`${heartbeatRuns.error}`;
  const explainedCode = sql`coalesce(nullif(btrim(${errorCode}), ''), ${fallback.errorCode})`;
  const explainedError = sql`coalesce(nullif(btrim(${error}), ''), ${fallback.error})`;
  if (current.preserveCancelled === false) return { errorCode: explainedCode, error: explainedError };
  return {
    errorCode: sql`case when ${heartbeatRuns.status} = 'cancelled' then ${heartbeatRuns.errorCode} else ${explainedCode} end`,
    error: sql`case when ${heartbeatRuns.status} = 'cancelled' then ${heartbeatRuns.error} else ${explainedError} end`,
  };
}
