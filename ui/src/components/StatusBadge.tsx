import { cn } from "../lib/utils";
import { useLocale } from "../context/LocaleContext";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLocale();
  const label = statusLabel(status, t);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {label}
    </span>
  );
}

function statusLabel(status: string, t: ReturnType<typeof useLocale>["t"]) {
  switch (status) {
    case "active":
      return t("status.active");
    case "paused":
      return t("status.paused");
    case "running":
      return t("status.running");
    case "idle":
      return t("status.idle");
    case "error":
      return t("status.error");
    case "terminated":
      return t("status.terminated");
    case "queued":
      return t("status.queued");
    case "done":
      return t("status.done");
    case "cancelled":
      return t("status.cancelled");
    case "pending_approval":
      return t("status.pendingApproval");
    default:
      return status.replaceAll("_", " ");
  }
}
