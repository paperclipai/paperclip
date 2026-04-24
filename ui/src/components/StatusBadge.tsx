import { cn } from "../lib/utils";
import { useI18n } from "../context/LocaleContext";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const labelMap: Record<string, string> = {
    active: t("status.active"),
    paused: t("status.paused"),
    idle: t("status.idle"),
    archived: t("status.archived"),
    pending_approval: t("status.pendingApproval"),
    running: t("status.running"),
    queued: t("status.queued"),
    scheduled_retry: t("status.scheduledRetry"),
    succeeded: t("status.succeeded"),
    failed: t("status.failed"),
    timed_out: t("status.timedOut"),
    cancelled: t("status.cancelled"),
    terminated: t("status.terminated"),
    todo: t("status.todo"),
    in_progress: t("status.inProgress"),
    in_review: t("status.inReview"),
    done: t("status.done"),
    blocked: t("status.blocked"),
    backlog: t("status.backlog"),
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {labelMap[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}
