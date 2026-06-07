import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Trash2 } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";

const STRATEGIES = ["skill", "round_robin", "owner_match", "timezone", "weighted"];

export function RoutingRules() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }, { label: "Routing rules" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.rules, queryFn: () => teamApi.rules() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.rules });
  const setStrategy = async (id: string, strategy: string) => { await teamApi.patchRule(id, { strategy }).catch(() => {}); refresh(); };
  const toggle = async (id: string, active: boolean) => { await teamApi.patchRule(id, { active }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await teamApi.deleteRule(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Routing rules</h1>
      <AgnbSubnav group="team" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={GitBranch} message="No routing rules." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Kind</th><th className="p-2">Strategy</th><th className="p-2">Prefer skills</th><th className="p-2">Active</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="p-2"><Badge variant="outline">{r.kind}</Badge></td>
                  <td className="p-2">
                    <select value={r.strategy} onChange={(e) => setStrategy(r.id, e.target.value)} className="rounded border border-border bg-background px-1 py-0.5 text-xs">
                      {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{(r.prefer_skills ?? []).join(", ") || "—"}</td>
                  <td className="p-2"><input type="checkbox" checked={r.active} onChange={(e) => toggle(r.id, e.target.checked)} /></td>
                  <td className="p-2"><button onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
