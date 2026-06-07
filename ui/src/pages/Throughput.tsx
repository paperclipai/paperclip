import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { teamApi } from "../api/agnbTeam";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function Throughput() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Team" }, { label: "Throughput" }]), [setBreadcrumbs]);
  const members = useQuery({ queryKey: queryKeys.agnb.team, queryFn: () => teamApi.members() });
  const done = useQuery({ queryKey: queryKeys.agnb.work("done"), queryFn: () => teamApi.work("?status=done") });

  const rows = useMemo(() => {
    const byMember = new Map<string, number>();
    for (const w of done.data ?? []) if (w.assigned_to) byMember.set(w.assigned_to, (byMember.get(w.assigned_to) ?? 0) + 1);
    const total = [...byMember.values()].reduce((a, b) => a + b, 0) || 1;
    return (members.data ?? []).map((m) => ({ name: m.name, is_ai: m.is_ai, done: byMember.get(m.id) ?? 0, pct: Math.round(((byMember.get(m.id) ?? 0) / total) * 100) }))
      .sort((a, b) => b.done - a.done);
  }, [members.data, done.data]);

  const loading = members.isLoading || done.isLoading;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Throughput (7d)</h1>
      <AgnbSubnav group="team" />
      {loading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={BarChart3} message="No throughput data." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Teammate</th><th className="p-2">Type</th><th className="p-2 text-right">Done</th><th className="p-2 text-right">% of total</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-b border-border/60">
                  <td className="p-2">{r.name}</td>
                  <td className="p-2 text-xs text-muted-foreground">{r.is_ai ? "AI" : "Human"}</td>
                  <td className="p-2 text-right">{r.done}</td>
                  <td className="p-2 text-right">{r.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
