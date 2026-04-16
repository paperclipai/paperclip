import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  infrastructureHealthApi,
  type InfraHealthResponse,
  type InfraServiceStatus,
} from "../api/infrastructure-health";
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  HeartPulse,
} from "lucide-react";

const statusConfig = {
  ok: {
    icon: CheckCircle2,
    color: "text-green-600 dark:text-green-400",
    bg: "bg-green-100 dark:bg-green-900/50",
    label: "Healthy",
  },
  degraded: {
    icon: AlertTriangle,
    color: "text-yellow-600 dark:text-yellow-400",
    bg: "bg-yellow-100 dark:bg-yellow-900/50",
    label: "Degraded",
  },
  error: {
    icon: XCircle,
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-100 dark:bg-red-900/50",
    label: "Error",
  },
};

const statusOrder: Record<string, number> = { error: 0, degraded: 1, ok: 2 };

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function ServiceCard({ service }: { service: InfraServiceStatus }) {
  const cfg = statusConfig[service.status] ?? statusConfig.error;
  const StatusIcon = cfg.icon;

  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {service.label ?? service.service}
          </CardTitle>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              cfg.bg,
              cfg.color,
            )}
          >
            <StatusIcon className="h-3 w-3" />
            {cfg.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-muted-foreground">
        {service.version && (
          <div className="flex items-center justify-between">
            <span>Version</span>
            <span className="font-mono text-foreground">{service.version}</span>
          </div>
        )}
        {service.uptime_seconds != null && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Uptime
            </span>
            <span className="font-mono text-foreground">
              {formatUptime(service.uptime_seconds)}
            </span>
          </div>
        )}
        {Object.keys(service.checks).length > 0 && (
          <div className="space-y-1 border-t border-border pt-2">
            {Object.entries(service.checks).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between">
                <span>{key}</span>
                <span className="font-mono text-foreground">
                  {typeof value === "object" && value !== null
                    ? JSON.stringify(value)
                    : String(value)}
                </span>
              </div>
            ))}
          </div>
        )}
        {service.error && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
            {service.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

function OverallBanner({ data }: { data: InfraHealthResponse }) {
  const cfg = statusConfig[data.status] ?? statusConfig.error;
  const StatusIcon = cfg.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-4 py-3",
        cfg.bg,
      )}
    >
      <StatusIcon className={cn("h-5 w-5", cfg.color)} />
      <div className="flex-1">
        <span className={cn("text-sm font-semibold", cfg.color)}>
          {cfg.label}
        </span>
        <span className="ml-3 text-xs text-muted-foreground">
          {data.summary.ok} ok
          {data.summary.degraded > 0 && ` · ${data.summary.degraded} degraded`}
          {data.summary.error > 0 && ` · ${data.summary.error} error`}
          {` · ${data.summary.total} total`}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {new Date(data.timestamp).toLocaleTimeString()}
      </span>
    </div>
  );
}

export function InfrastructureHealth() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Infrastructure" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["infrastructure-health"],
    queryFn: () => infrastructureHealthApi.getAll(),
    refetchInterval: 30_000,
  });

  const sortedServices: InfraServiceStatus[] = data
    ? Object.values(data.services).sort(
        (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9),
      )
    : [];

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Infrastructure Health</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={cn("mr-1.5 h-3.5 w-3.5", isFetching && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
          {error instanceof Error
            ? error.message
            : "Failed to load infrastructure health"}
        </div>
      )}

      {data && <OverallBanner data={data} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : sortedServices.map((svc) => (
              <ServiceCard key={svc.service} service={svc} />
            ))}
      </div>
    </div>
  );
}
