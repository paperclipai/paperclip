import { parseExternalRoutineOriginKind, type RoutineExternalSource } from "@paperclipai/shared";

// Single-pane view of all schedulers: Paperclip routines plus external
// (observed) schedulers mirrored from the Greybeard OS manifest (systemd
// timers, Hermes cron, k8s CronJobs, Camel routes, Grok Bot routines).

export type RoutineSource = RoutineExternalSource | "paperclip";

export const ROUTINE_SOURCE_LABELS: Record<RoutineSource, string> = {
  paperclip: "Paperclip",
  hermes: "Hermes",
  systemd: "systemd",
  k8s: "k8s",
  camel: "Camel",
  grokbot: "Grok Bot",
};

export const ROUTINE_SOURCE_FILTERS: RoutineSource[] = [
  "paperclip",
  "systemd",
  "hermes",
  "k8s",
  "camel",
  "grokbot",
];

export function routineSourceOf(routine: { originKind?: string | null }): RoutineSource {
  return parseExternalRoutineOriginKind(routine.originKind) ?? "paperclip";
}

export function routineSourceLabel(routine: { originKind?: string | null }): string {
  return ROUTINE_SOURCE_LABELS[routineSourceOf(routine)];
}

export function isExternalRoutineItem(routine: { originKind?: string | null }): boolean {
  return routineSourceOf(routine) !== "paperclip";
}

export type RoutineHealth = "healthy" | "failing" | "stale" | "unknown";

export function routineHealthLabel(health: RoutineHealth): string {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "failing":
      return "Failing";
    case "stale":
      return "Stale";
    default:
      return "No runs yet";
  }
}

/** Tailwind text color per health state (keep to existing tokens). */
export function routineHealthClasses(health: RoutineHealth): string {
  switch (health) {
    case "healthy":
      return "text-emerald-600 dark:text-emerald-400";
    case "failing":
      return "text-red-600 dark:text-red-400";
    case "stale":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Derive a coarse health signal from the latest observed run. "Stale" means
 * the last run is older than twice the reported cadence.
 */
export function routineHealth(
  routine: {
    lastRun?: {
      triggeredAt?: Date | string | null;
      status?: string | null;
      triggerPayload?: Record<string, unknown> | null;
    } | null;
  },
  now: number = Date.now(),
): RoutineHealth {
  const lastRun = routine.lastRun ?? null;
  if (!lastRun) return "unknown";
  if (lastRun.status === "failed") return "failing";
  const triggeredAt = lastRun.triggeredAt ? new Date(lastRun.triggeredAt).getTime() : Number.NaN;
  const cadenceSec = typeof lastRun.triggerPayload?.cadenceSec === "number"
    ? lastRun.triggerPayload.cadenceSec
    : null;
  if (cadenceSec != null && cadenceSec > 0 && Number.isFinite(triggeredAt)) {
    if (now - triggeredAt > cadenceSec * 1000 * 2) return "stale";
  }
  return "healthy";
}
