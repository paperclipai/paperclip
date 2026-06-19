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

/**
 * Subtitle line for a run row (§3.6):
 * - failed runs show the failure reason ("why" without clicking through);
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
  const payload = run.triggerPayload;
  if (!payload || typeof payload !== "object") return "";
  const parts: string[] = [];
  for (const variable of variables ?? []) {
    if (!(variable.name in payload)) continue;
    parts.push(`${variable.name}=${formatVariableValue((payload as Record<string, unknown>)[variable.name])}`);
  }
  return parts.join(", ");
}
