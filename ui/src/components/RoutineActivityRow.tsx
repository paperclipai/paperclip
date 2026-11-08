import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

export type RoutineActivityEvent = Pick<ActivityEvent, "id" | "action" | "details" | "createdAt">;

function formatTime(value: string | Date): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

function summarizeEvent(event: RoutineActivityEvent): string {
  const details = event.details;
  if (event.action === "routine.webhook_test_received") return t("final-components-a:connectionWorkingNoRunOr_eb762a3d");
  if (event.action === "routine.webhook_test_rejected") return t("final-components-a:updateTheKeyInYour_a3b5a0e7");
  if (event.action === "routine.webhook_received") return t("final-components-a:authenticationPassed_0e41aef6");
  if (event.action === "routine.webhook_rejected") return t("final-components-a:checkTheKeyInYour_27adf524");
  if (!details) return "";
  if (typeof details.changeSummary === "string") return details.changeSummary;
  if (event.action === "routine.run_triggered") return `${details.source === "webhook" ? t("final-components-a:webhook_4814f62c") : details.source === "schedule" ? t("final-components-a:schedule_f4830a1d") : t("final-components-a:manual_b0b9fe24")} · ${details.status === "issue_created" ? t("final-components-a:taskCreated_a3e3e968") : String(details.status ?? "").replaceAll("_", " ")}`;
  return Object.entries(details).filter(([key]) => !/id$/i.test(key)).slice(0, 3)
    .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()}: ${formatDetailValue(value)}`)
    .join(" · ");
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
  get "routine.webhook_test_received"() { return t("final-components-a:connectionTestPassed_97f70ab0"); },
  get "routine.webhook_test_rejected"() { return t("final-components-a:connectionTestRejected_e726428f"); },
  get "routine.webhook_received"() { return t("final-components-a:webhookEventReceived_acc54100"); },
  get "routine.webhook_rejected"() { return t("final-components-a:webhookAuthenticationFailed_912bfefc"); },
  get "routine.created"() { return t("final-components-a:routineCreated_73aa7818"); }, get "routine.updated"() { return t("final-components-a:routineUpdated_72f4c9a3"); },
  get "routine.trigger_created"() { return t("final-components-a:triggerAdded_bdfe6f71"); }, get "routine.trigger_updated"() { return t("final-components-a:triggerUpdated_73c266d5"); },
  get "routine.trigger_deleted"() { return t("final-components-a:triggerRemoved_7d0dec12"); }, get "routine.trigger_removed"() { return t("final-components-a:triggerRemoved_7d0dec12"); }, get "routine.trigger_restored"() { return t("final-components-a:triggerRestored_ebac38f2"); }, get "routine.trigger_setup_finished"() { return t("final-components-a:webhookSetupFinished_64a3b5cd"); }, get "routine.trigger_secret_rotated"() { return t("final-components-a:webhookKeyReplaced_404458cb"); },
  get "routine.run_triggered"() { return t("final-components-a:routineStarted_768fcb18"); }, get "routine.run_created"() { return t("final-components-a:runCreated_4c211da8"); },
};
function actionLabel(action: string) {
  return actionLabels[action] ?? action.replace(/^routine[._]/, "").replaceAll("_", " ").replaceAll(".", " ").replace(/^./, (char) => char.toUpperCase());
}

/** Activity log row with an expandable JSON payload (§3.7). */
export function RoutineActivityRow({ event }: { event: RoutineActivityEvent }) {
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
