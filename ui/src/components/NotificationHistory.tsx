import { useQuery } from "@tanstack/react-query";
import type { NotificationRecord, DeliveryStatus } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { notificationsApi } from "@/api/notifications";

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Pending",
  sent: "Delivered",
  failed: "Failed",
};

const STATUS_COLORS: Record<DeliveryStatus, string> = {
  pending: "text-yellow-500",
  sent: "text-green-500",
  failed: "text-red-500",
};

function statusBadgeClass(status: DeliveryStatus | null): string {
  if (!status) return "text-muted-foreground";
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  switch (status) {
    case "pending":
      return `${base} bg-yellow-500/10 text-yellow-600`;
    case "sent":
      return `${base} bg-green-500/10 text-green-600`;
    case "failed":
      return `${base} bg-red-500/10 text-red-600`;
  }
}

export function NotificationHistory() {
  const { selectedCompanyId } = useCompany();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.notifications.list(selectedCompanyId!),
    queryFn: () => notificationsApi.list(selectedCompanyId!, { limit: 20 }),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  if (!selectedCompanyId) return null;

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        Loading notification history...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-destructive py-4">
        {error instanceof Error
          ? error.message
          : "Failed to load notification history."}
      </div>
    );
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        No notifications yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-0 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <div>Notification</div>
        <div className="w-24 text-center">Email</div>
        <div className="w-24 text-center">Push</div>
        <div className="w-24 text-center">Status</div>
      </div>

      {/* Rows */}
      {items.map((n) => (
        <div
          key={n.id}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-0 border-b border-border/60 px-4 py-3 last:border-b-0"
        >
          <div className="self-center pr-4">
            <div className="text-sm font-medium truncate max-w-xs">
              {n.title}
            </div>
            <div className="text-xs text-muted-foreground truncate max-w-xs">
              {n.body}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {n.notificationType.replace(/_/g, " ")}
              {n.readAt ? " · Read" : " · Unread"}
            </div>
          </div>

          <div className="flex w-24 items-center justify-center">
            <span className={statusBadgeClass(n.emailDelivery.status)}>
              {STATUS_LABELS[n.emailDelivery.status ?? "pending"]}
            </span>
          </div>

          <div className="flex w-24 items-center justify-center">
            <span className={statusBadgeClass(n.pushDelivery.status)}>
              {STATUS_LABELS[n.pushDelivery.status ?? "pending"]}
            </span>
          </div>

          <div className="flex w-24 items-center justify-center">
            <span className={statusBadgeClass(n.deliveryStatus)}>
              {STATUS_LABELS[n.deliveryStatus ?? "pending"]}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
