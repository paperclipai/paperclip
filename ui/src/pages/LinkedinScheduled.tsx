import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "../lib/utils";

export function LinkedinScheduled() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Scheduled" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liQueue, queryFn: () => linkedinQueueApi.queue() });

  const scheduled = (data ?? [])
    .filter((r) => r.scheduled_at && r.status !== "posted" && r.status !== "published")
    .sort((a, b) => new Date(a.scheduled_at!).getTime() - new Date(b.scheduled_at!).getTime());

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <h1 className="text-lg font-semibold">Scheduled</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : scheduled.length === 0 ? (
        <EmptyState icon={CalendarClock} message="Nothing scheduled." />
      ) : (
        <div className="flex flex-col gap-2">
          {scheduled.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <span className="font-mono text-xs text-muted-foreground">{formatDateTime(r.scheduled_at!)}</span>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap">{r.content}</p>
              </div>
              <Badge variant="secondary" className="shrink-0">{r.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
