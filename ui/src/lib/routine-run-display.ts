import type { RoutineRunSummary, RoutineVariable } from "@paperclipai/shared";
import { t } from "@/i18n";
import { ROUTINE_RUN_SOURCES, ROUTINE_RUN_STATUSES } from "@paperclipai/shared";

/** Translate known display values without changing the stored status/source. */
export function routineRunStatusLabel(status: string): string {
  return (ROUTINE_RUN_STATUSES as readonly string[]).includes(status)
    ? t(`localizationRoutines.runStatus_${status}`)
    : status.replaceAll("_", " ");
}

export function routineRunSourceLabel(source: string): string {
  return (ROUTINE_RUN_SOURCES as readonly string[]).includes(source)
    ? t(`localizationRoutines.runSource_${source}`)
    : source;
}

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

/**
 * Human-readable labels for the reasons a scheduled run was skipped rather than
 * dispatched. `failureReason` on a skipped run carries the machine reason; these
 * turn it into a one-line "why" for the runs list.
 */
const SKIP_REASON_LABELS: Record<string, string> = {
  get no_external_activity() { return t("localizationRoutines.skipNoActivity"); },
  get paused() { return t("localizationRoutines.skipPaused"); },
  get worktree_execution_cutoff() { return t("localizationRoutines.skipWorktreeCutoff"); },
};

/**
 * Subtitle line for a run row (§3.6):
 * - failed runs show the failure reason ("why" without clicking through);
 * - skipped runs show why the scheduled tick didn't dispatch (e.g. the activity
 *   gate found the system settled);
 * - other runs show the inline resolved variable values (e.g. `customer="Acme"`).
 * Returns an empty string when there is nothing meaningful to show.
 */
export function runRowSubtitle(
  run: Pick<RoutineRunSummary, "status" | "failureReason" | "triggerPayload">,
  variables: readonly RoutineVariable[] | null | undefined,
): string {
  if (run.status === "failed") {
    return run.failureReason?.trim() || t("localizationRoutines.runFailed");
  }
  if (run.status === "skipped") {
    const reason = run.failureReason?.trim();
    if (reason && SKIP_REASON_LABELS[reason]) return SKIP_REASON_LABELS[reason];
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
