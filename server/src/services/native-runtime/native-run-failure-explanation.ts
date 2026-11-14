import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { NativeTurnFailureDiagnostic } from "./native-provider-failure.js";

/** Used when a native run reaches `failed` and no writer recorded a more specific cause. */
export const NATIVE_RUN_FAILED_UNEXPLAINED = {
  errorCode: "native_run_failed",
  error: "The native run ended in a failed state without a classified provider error. Inspect the run events for the last recorded step.",
} as const;

export type NativeRunFailureExplanation = { errorCode: string; error: string };

const TURN_FAILURE_PROVIDER_LABELS = { codex: "Codex", opencode: "OpenCode" } as const;

/**
 * Name the cause of a failed turn that no provider classifier claimed, using
 * only the diagnostic's closed vocabulary: a runner-issued failure code, else a
 * specific Codex error kind. Returns null when the diagnostic has no such cause.
 */
export function explainNativeTurnFailure(diagnostic: NativeTurnFailureDiagnostic | null | undefined): NativeRunFailureExplanation | null {
  if (!diagnostic) return null;
  const runnerCode = diagnostic.runnerFailureCode;
  const codexKind = diagnostic.provider === "codex" ? diagnostic.codexErrorInfo : undefined;
  const cause = runnerCode && runnerCode !== "unrecognized" ? runnerCode
    : codexKind && !["absent", "unrecognized", "other"].includes(codexKind) ? codexKind : null;
  if (!cause) return null;
  return {
    errorCode: NATIVE_RUN_FAILED_UNEXPLAINED.errorCode,
    error: `The ${TURN_FAILURE_PROVIDER_LABELS[diagnostic.provider]} turn failed (${cause}). Inspect the run events for the last recorded step.`,
  };
}

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
