import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { systemStatusApi } from "../api/systemStatus";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function SystemStatus() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "System Status" }]);
  }, [setBreadcrumbs]);

  // Re-render every 10 seconds to keep "last checked" timestamp fresh
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.systemStatus(),
    queryFn: () => systemStatusApi.getAll(),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (data) {
      setLastChecked(new Date());
    }
  }, [data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Select a company to view system status." />;
  }

  if (isLoading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {lastChecked && (
            <p className="text-sm text-muted-foreground">
              Last checked {timeAgo(lastChecked)}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}

      {data && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((service) => (
            <Card key={service.name}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium truncate">{service.name}</span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        service.status === "healthy" ? "bg-green-500" : "bg-red-500"
                      )}
                    />
                    <span
                      className={cn(
                        "text-xs",
                        service.status === "healthy"
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      )}
                    >
                      {service.status}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Response time: {service.responseTimeMs}ms
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground">No services found.</p>
      )}
    </div>
  );
}
