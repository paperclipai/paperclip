import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function PendingActions() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Pending actions" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.pending, queryFn: () => opsApi.pending() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <h1 className="text-lg font-semibold">Pending actions</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ListChecks} message="Nothing pending." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((p) => (
            <div key={p.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge variant="outline">{p.action_type}</Badge><span>{p.payload?.lead_name ?? p.payload?.lead_email ?? ""}</span></div>
                {p.payload?.reason && <p className="mt-0.5 text-xs text-muted-foreground">{p.payload.reason}</p>}
                <div className="mt-0.5 text-[11px] text-muted-foreground">{p.proposed_by} · {relativeTime(p.proposed_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
