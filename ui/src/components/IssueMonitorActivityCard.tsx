import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { issueDetailMonitorCard } from "@/lib/i18n";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatDateTime } from "@/lib/utils";

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
  const monitor = resolveScheduledMonitor(issue);
  if (!monitor) return null;

  const relative = formatMonitorOffset(monitor.nextCheckAt);
  const absolute = formatDateTime(monitor.nextCheckAt);

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{issueDetailMonitorCard.title}</div>
          <div className="text-xs text-muted-foreground">
            {issueDetailMonitorCard.nextCheck(absolute, relative)}
          </div>
          {monitor.notes ? (
            <div className="mt-1 text-xs text-muted-foreground">{monitor.notes}</div>
          ) : null}
          {monitor.serviceName ? (
            <div className="mt-1 text-xs text-muted-foreground">{monitor.serviceName}</div>
          ) : null}
          {monitor.attemptCount > 0 ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {issueDetailMonitorCard.attempt(monitor.attemptCount)}
            </div>
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
            {checkingNow ? issueDetailMonitorCard.checking : issueDetailMonitorCard.checkNow}
          </Button>
        ) : null}
      </div>
    </div>
  );
}