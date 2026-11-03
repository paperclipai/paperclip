import { i18n, t, useTranslation } from "@/i18n";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { routineRunSourceLabel, routineRunStatusLabel } from "@/lib/routine-run-display";

export type RoutineActivityEvent = Pick<ActivityEvent, "id" | "action" | "details" | "createdAt">;

function formatTime(value: string | Date): string {
  try {
    return new Date(value).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

function summarizeEvent(event: RoutineActivityEvent): string {
  const details = event.details;
  if (event.action === "routine.webhook_test_received") return t("sep28Routines.activityTestWorking");
  if (event.action === "routine.webhook_test_rejected") return t("sep28Routines.activityUpdateKey");
  if (event.action === "routine.webhook_received") return t("sep28Routines.activityAuthPassed");
  if (event.action === "routine.webhook_rejected") return t("sep28Routines.activityCheckKey");
  if (!details) return "";
  if (typeof details.changeSummary === "string") return details.changeSummary;
  if (event.action === "routine.run_triggered") return `${details.source === "webhook" ? t("localizationRoutines.webhook") : details.source === "schedule" ? t("localizationRoutines.schedule") : t("sep28Routines.manual")} · ${details.status === "issue_created" ? t("sep28Routines.taskCreated") : routineRunStatusLabel(String(details.status ?? ""))}`;
  return Object.entries(details).filter(([key]) => !/id$/i.test(key)).slice(0, 3)
    .map(([key, value]) => `${detailLabel(key)}: ${detailDisplayValue(key, value)}`)
    .join(" · ");
}

function detailLabel(key: string): string {
  const keys: Record<string, string> = {
    kind: "localizationRoutines.kind", label: "localizationRoutines.label",
    title: "localizationRoutineHistory.title", source: "localizationRoutines.source",
    status: "localizationRoutines.status", timezone: "sep28Routines.timeZone",
    signingMode: "localizationRoutines.signingMode", replayWindowSec: "localizationRoutines.replayWindow",
    concurrencyPolicy: "localizationRoutines.concurrencyPolicy", catchUpPolicy: "localizationRoutines.catchUpPolicy",
    enabled: "sep28Routines.activityFields.enabled", setupPending: "sep28Routines.activityFields.setupPending",
    cronExpression: "sep28Routines.activityFields.cronExpression", revisionNumber: "sep28Routines.activityFields.revisionNumber",
  };
  return keys[key] ? t(keys[key]) : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}

function detailDisplayValue(key: string, value: unknown): string {
  if ((key === "kind" || key === "source") && typeof value === "string") return routineRunSourceLabel(value);
  if (key === "status" && typeof value === "string") return routineRunStatusLabel(value);
  if (typeof value === "boolean") return t(value ? "localizationRoutines.true" : "localizationRoutines.false");
  return formatDetailValue(value);
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(formatDetailValue).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

const actionLabels: Record<string, string> = {
  get "routine.webhook_test_received"() { return t("sep28Routines.testPassed"); },
  get "routine.webhook_test_rejected"() { return t("sep28Routines.testRejectedAction"); },
  get "routine.webhook_received"() { return t("sep28Routines.webhookReceived"); },
  get "routine.webhook_rejected"() { return t("sep28Routines.webhookAuthFailed"); },
  get "routine.created"() { return t("sep28Routines.routineCreated"); }, get "routine.updated"() { return t("sep28Routines.routineUpdated"); },
  get "routine.trigger_created"() { return t("sep28Routines.triggerAdded"); }, get "routine.trigger_updated"() { return t("sep28Routines.triggerUpdated"); },
  get "routine.trigger_deleted"() { return t("sep28Routines.triggerRemoved"); }, get "routine.trigger_removed"() { return t("sep28Routines.triggerRemoved"); }, get "routine.trigger_restored"() { return t("sep28Routines.triggerRestored"); }, get "routine.trigger_setup_finished"() { return t("sep28Routines.setupFinished"); }, get "routine.trigger_secret_rotated"() { return t("sep28Routines.keyReplaced"); },
  get "routine.run_triggered"() { return t("sep28Routines.routineStarted"); }, get "routine.run_created"() { return t("sep28Routines.runCreated"); },
};
function actionLabel(action: string) {
  return actionLabels[action] ?? action.replace(/^routine[._]/, "").replaceAll("_", " ").replaceAll(".", " ").replace(/^./, (char) => char.toUpperCase());
}

/** Activity log row with an expandable JSON payload (§3.7). */
export function RoutineActivityRow({ event }: { event: RoutineActivityEvent }) {
  useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.details != null && Object.keys(event.details).length > 0;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        disabled={!hasPayload}
        aria-expanded={hasPayload ? expanded : undefined}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex min-w-0 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs whitespace-nowrap",
          hasPayload ? "hover:bg-accent/30" : "cursor-default",
        )}
      >
        <span className="w-16 shrink-0 whitespace-nowrap font-mono tabular-nums text-muted-foreground">
          {formatTime(event.createdAt)}
        </span>
        <span title={event.action} className="min-w-0 max-w-1/2 shrink-0 truncate font-medium text-foreground">
          {actionLabel(event.action)}
        </span>
        <span title={summarizeEvent(event)} className="min-w-0 flex-1 truncate text-muted-foreground">
          {summarizeEvent(event)}
        </span>
        {hasPayload ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {expanded && hasPayload ? (
        <pre className="mx-2 mb-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
