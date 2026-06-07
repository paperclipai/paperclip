import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function EntityAudit() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Entity audit" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.entityAudit, queryFn: () => opsApi.entityAudit() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Entity audit</h1>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={History} message="No changes logged." />
      ) : (
        <div className="flex flex-col gap-1">
          {data.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="flex items-center gap-2"><Badge variant="outline">{a.action}</Badge>{a.entity_type} <span className="font-mono text-[11px] text-muted-foreground">{a.entity_id.slice(0, 8)}</span></span>
              <span className="text-[11px] text-muted-foreground">{a.actor_email ?? ""} · {relativeTime(a.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
