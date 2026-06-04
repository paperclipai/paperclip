import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox as InboxIcon } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbWorkCard } from "../components/AgnbWorkCard";
import { cn } from "../lib/utils";

const STATUSES = ["queued", "in_progress", "done", "blocked", "all"];

export function MyQueue() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }, { label: "My queue" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [status, setStatus] = useState("queued");
  const q = status !== "all" ? `?status=${status}` : "";
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.work(`mine-${status}`), queryFn: () => teamApi.work(q) });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.work(`mine-${status}`) });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="team" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">My queue</h1>
        <div className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={cn("rounded-md border px-2 py-0.5 text-xs", status === s ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>{s}</button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={InboxIcon} message="Queue empty." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">{data.map((w) => <AgnbWorkCard key={w.id} item={w} onChange={refresh} />)}</div>
      )}
    </div>
  );
}
