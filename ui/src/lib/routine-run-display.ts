import type { RoutineRunSummary, RoutineVariable } from "@paperclipai/shared";

/**
 * Format a single resolved variable value for the runs-row subtitle (§3.6).
 * Strings are quoted (`customer="Acme"`); numbers/booleans rendered bare.
 */
function formatVariableValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The de-duped trigger label for a run. The kind chip already states the kind,
 * so when a trigger has no custom label (`label` falls back to `kind`) we drop
 * the redundant text rather than re-stating it.
 */
export function dedupedTriggerLabel(
  trigger: Pick<RoutineRunSummary["trigger"] & object, "kind" | "label"> | null | undefined,
): string | null {
  if (!trigger) return null;
  const label = trigger.label?.trim();
  if (!label) return null;
  if (label === trigger.kind) return null;
  return label;
}

/** Suppression markers the scheduler stores in failureReason for skipped runs. */
const SKIP_REASON_TEXT: Record<string, string> = {
  paused: "Skipped: project was paused at the scheduled time",
  no_external_activity: "Skipped: no external activity since the last run",
  worktree_execution_cutoff: "Skipped: worktree execution cutoff was active",
};

function transientFailureReason(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload !== "object") return null;
  const transient = (payload as { transientFailure?: unknown }).transientFailure;
  if (!transient || typeof transient !== "object") return null;
  const reason = (transient as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Subtitle line for a run row (§3.6):
 * - failed runs show the failure reason ("why" without clicking through);
 * - skipped runs say whether the skip was intentional (live issue, paused project,
 *   activity gate, worktree cutoff) so operators can tell it apart from a failure;
 * - completed runs that were temporarily blocked mid-flight note the recovery;
 * - other runs show the inline resolved variable values (e.g. `customer="Acme"`).
 * Returns an empty string when there is nothing meaningful to show.
 */
export function runRowSubtitle(
  run: Pick<RoutineRunSummary, "status" | "failureReason" | "triggerPayload">,
  variables: readonly RoutineVariable[] | null | undefined,
): string {
  if (run.status === "failed") {
    return run.failureReason?.trim() || "Run failed";
  }
  if (run.status === "skipped") {
    const reason = run.failureReason?.trim();
    return (reason && SKIP_REASON_TEXT[reason])
      || "Skipped: a live execution issue already existed";
  }
  if (run.status === "coalesced") {
    return "Coalesced into the existing live execution issue";
  }
  if (run.status === "completed") {
    // Legacy rows kept the transient block in failureReason; new rows move it to
    // triggerPayload.transientFailure when the run recovers to completed.
    const recovered = transientFailureReason(run.triggerPayload) ?? run.failureReason?.trim();
    if (recovered) return `Recovered after transient failure: ${recovered}`;
  }
  const payload = run.triggerPayload;
  if (!payload || typeof payload !== "object") return "";
  const parts: string[] = [];
  for (const variable of variables ?? []) {
    if (!(variable.name in payload)) continue;
    parts.push(`${variable.name}=${formatVariableValue((payload as Record<string, unknown>)[variable.name])}`);
  }
  return parts.join(", ");
}
