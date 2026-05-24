import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatDateTime } from "@/lib/utils";
import { useTranslation } from "@/i18n";

function resolveScheduledMonitor(issue: Issue) {
  const nextCheckAt =
    issue.monitorNextCheckAt ??
    issue.executionPolicy?.monitor?.nextCheckAt ??
    issue.executionState?.monitor?.nextCheckAt ??
    null;
  if (!nextCheckAt) return null;

  return {
    nextCheckAt,
    notes: issue.executionPolicy?.monitor?.notes ?? issue.monitorNotes ?? issue.executionState?.monitor?.notes ?? null,
    attemptCount: issue.monitorAttemptCount ?? issue.executionState?.monitor?.attemptCount ?? 0,
    serviceName: issue.executionPolicy?.monitor?.serviceName ?? issue.executionState?.monitor?.serviceName ?? null,
  };
}

interface IssueMonitorActivityCardProps {
  issue: Issue;
  onCheckNow?: (() => void) | null;
  checkingNow?: boolean;
}

export function IssueMonitorActivityCard({
  issue,
  onCheckNow = null,
  checkingNow = false,
}: IssueMonitorActivityCardProps) {
  const { t } = useTranslation();
  const monitor = resolveScheduledMonitor(issue);
  if (!monitor) return null;

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t("monitor.scheduled", { defaultValue: "Monitor scheduled" })}</div>
          <div className="text-xs text-muted-foreground">
            {t("monitor.nextCheck", { defaultValue: "Next check {{when}} ({{offset}})", when: formatDateTime(monitor.nextCheckAt), offset: formatMonitorOffset(monitor.nextCheckAt) })}
          </div>
          {monitor.notes ? (
            <div className="mt-1 text-xs text-muted-foreground">{monitor.notes}</div>
          ) : null}
          {monitor.serviceName ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {monitor.serviceName}
            </div>
          ) : null}
          {monitor.attemptCount > 0 ? (
            <div className="mt-1 text-xs text-muted-foreground">{t("monitor.attempt", { defaultValue: "Attempt {{count}}", count: monitor.attemptCount })}</div>
          ) : null}
        </div>
        {onCheckNow ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 shadow-none"
            onClick={onCheckNow}
            disabled={checkingNow}
          >
            {checkingNow ? t("monitor.checking", { defaultValue: "Checking..." }) : t("monitor.checkNow", { defaultValue: "Check now" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
