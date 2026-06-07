import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function AgnbEvents() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Events" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.events, queryFn: () => opsApi.events() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Events</h1>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Activity} message="No events." />
      ) : (
        <div className="flex flex-col gap-1">
          {data.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="flex items-center gap-2"><Badge variant="outline">{e.event_type}</Badge>{e.processor_error && <span className="text-xs text-destructive">{e.processor_error}</span>}</span>
              <span className="text-[11px] text-muted-foreground">{e.source ?? ""} {e.processed_at ? "" : "· unprocessed"} · {relativeTime(e.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
