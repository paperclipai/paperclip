import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { toolsApi, type ToolAuditOutcome, type ToolGatewayActivityEvent } from "@/api/tools";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, RelativeTime } from "@/pages/tools/shared";
import { cn } from "@/lib/utils";

const OUTCOME_LABEL: Record<ToolAuditOutcome, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  asked_first: "Ask first",
  waiting: "Waiting",
  failed: "Failed",
  unknown: "—",
};

const OUTCOME_CLASS: Record<ToolAuditOutcome, string> = {
  allowed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  blocked: "border-foreground bg-foreground text-background",
  asked_first: "border-foreground bg-foreground text-background",
  waiting: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  unknown: "border-border bg-muted text-muted-foreground",
};

function belongsToGateway(event: ToolGatewayActivityEvent, gateway: ToolMcpGatewayWithTokens): boolean {
  const details = event.details ?? {};
  return (
    details.gatewayId === gateway.id ||
    details.gatewayPublicId === gateway.gatewayPublicId ||
    details.gatewaySlug === gateway.displaySlug
  );
}

export function GatewayActivityPanel({
  companyId,
  gateway,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
}) {
  const activityQuery = useQuery({
    queryKey: ["tools", "gateway-activity", companyId, gateway.id],
    queryFn: () => toolsApi.listActivity(companyId, { window: "7d", limit: 100 }),
  });

  const events = useMemo(
    () => (activityQuery.data?.events ?? []).filter((event) => belongsToGateway(event, gateway)),
    [activityQuery.data, gateway],
  );

  if (activityQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (activityQuery.isError) {
    return <ErrorState error={activityQuery.error} onRetry={() => activityQuery.refetch()} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every call through this gateway in the last 7 days, with why it was allowed, blocked, or paused.
      </p>
      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No calls have gone through this gateway yet.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => {
            const outcome = event.normalizedOutcome;
            const tool = event.toolDisplayName ?? "tool";
            const app = event.appDisplayName ?? event.applicationDisplayName ?? "app";
            const actor = event.agentDisplayName ?? "Client";
            return (
              <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{actor}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {app} · {tool} · <RelativeTime value={event.createdAt} />
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                    OUTCOME_CLASS[outcome],
                  )}
                >
                  {OUTCOME_LABEL[outcome]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
