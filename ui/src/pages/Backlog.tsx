import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbWorkCard } from "../components/AgnbWorkCard";
import { cn } from "../lib/utils";

export function Backlog() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }, { label: "Backlog" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [mine, setMine] = useState(false);
  const q = mine ? "?mine=1" : "";
  const key = mine ? "backlog-mine" : "backlog-unassigned";
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.work(key), queryFn: () => teamApi.work(q) });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.work(key) });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="team" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Backlog</h1>
        <div className="flex gap-1">
          <button onClick={() => setMine(false)} className={cn("rounded-md border px-2 py-0.5 text-xs", !mine ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>Unassigned</button>
          <button onClick={() => setMine(true)} className={cn("rounded-md border px-2 py-0.5 text-xs", mine ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>Assigned to me</button>
        </div>
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
