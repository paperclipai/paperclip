import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Grid3x3 } from "lucide-react";
import { experimentsApi } from "../api/agnbExperiments";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

function weekKey(d: string) {
  const dt = new Date(d);
  const day = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() - day);
  return dt.toISOString().slice(5, 10); // MM-DD of week start
}
function rateColor(r: number) {
  if (r >= 0.04) return "#16a34a";
  if (r >= 0.02) return "#65a30d";
  if (r >= 0.01) return "#d97706";
  if (r > 0) return "#dc2626";
  return "transparent";
}

export function Cohorts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Experiments" }, { label: "Cohorts" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.cohorts, queryFn: () => experimentsApi.cohorts() });

  const { weeks, rows } = useMemo(() => {
    if (!data) return { weeks: [] as string[], rows: [] as Array<{ icp: string; cells: Record<string, { sent: number; positive: number }> }> };
    const bucketIcp = new Map(data.buckets.map((b) => [b.id, b.icp_id]));
    const icpName = new Map(data.icps.map((i) => [i.id, i.name]));
    const weekSet = new Set<string>();
    const byIcp = new Map<string, Record<string, { sent: number; positive: number }>>();
    for (const s of data.snapshots) {
      const icpId = bucketIcp.get(s.bucket_id) ?? null;
      const name = icpId ? (icpName.get(icpId) ?? "Unknown") : "Unattributed";
      const wk = weekKey(s.snapshot_date);
      weekSet.add(wk);
      const cells = byIcp.get(name) ?? {};
      const cell = cells[wk] ?? { sent: 0, positive: 0 };
      cell.sent += s.total_sent; cell.positive += s.total_positive;
      cells[wk] = cell; byIcp.set(name, cells);
    }
    return { weeks: [...weekSet].sort(), rows: [...byIcp.entries()].map(([icp, cells]) => ({ icp, cells })) };
  }, [data]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Cohort heatmap</h1>
      <AgnbSubnav group="experiments" />
      <p className="text-xs text-muted-foreground">Positive-reply rate · ICP × week (12w)</p>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Grid3x3} message="No snapshot data." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr><th className="p-2 text-left">ICP</th>{weeks.map((w) => <th key={w} className="p-1 font-mono">{w}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.icp} className="border-t border-border/60">
                  <td className="p-2 font-medium">{r.icp}</td>
                  {weeks.map((w) => {
                    const c = r.cells[w];
                    const rate = c && c.sent > 0 ? c.positive / c.sent : 0;
                    return <td key={w} className="p-1 text-center" style={{ background: c ? rateColor(rate) + "33" : "transparent" }} title={c ? `${c.positive}/${c.sent}` : "no data"}>{c && c.sent > 0 ? `${(rate * 100).toFixed(1)}` : ""}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
