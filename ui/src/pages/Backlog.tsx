import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbWorkCard } from "../components/AgnbWorkCard";

export function Backlog() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }, { label: "Backlog" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const key = "backlog-unassigned";
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.work(key), queryFn: () => teamApi.work("?assignee=unassigned") });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.work(key) });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="team" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Backlog</h1>
        <span className="text-xs text-muted-foreground">Unassigned</span>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Layers} message="Backlog empty." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">{data.map((w) => <AgnbWorkCard key={w.id} item={w} showAssignee onChange={refresh} />)}</div>
      )}
    </div>
  );
}
