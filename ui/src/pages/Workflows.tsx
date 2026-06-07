import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow as WorkflowIcon, Trash2 } from "lucide-react";
import { miscApi } from "../api/agnbMisc";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function Workflows() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Workflows" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.workflows, queryFn: () => miscApi.workflows() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.workflows });
  const toggle = async (id: string, active: boolean) => { await miscApi.toggleWorkflow(id, active).catch(() => {}); refresh(); };
  const del = async (id: string) => { if (confirm("Delete recipe?")) { await miscApi.deleteWorkflow(id).catch(() => {}); refresh(); } };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Workflow recipes</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={WorkflowIcon} message="No recipes." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="font-medium">{r.name}</span><Badge variant={r.active ? "default" : "secondary"}>{r.active ? "active" : "paused"}</Badge></div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">on {r.trigger_event} · fired {r.fire_count}{r.last_fired_at ? ` · ${relativeTime(r.last_fired_at)}` : ""}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="outline" onClick={() => toggle(r.id, !r.active)}>{r.active ? "Pause" : "Resume"}</Button>
                <button onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
