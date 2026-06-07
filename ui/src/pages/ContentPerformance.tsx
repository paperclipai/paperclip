import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ExternalLink } from "lucide-react";
import { miscApi } from "../api/agnbMisc";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { cn, formatNumber } from "../lib/utils";

const DAYS = [7, 30, 90];

export function ContentPerformance() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Content perf" }]), [setBreadcrumbs]);
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.contentPerf(days), queryFn: () => miscApi.contentPerformance(days) });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Content performance</h1>
        <div className="flex gap-1">{DAYS.map((d) => <button key={d} onClick={() => setDays(d)} className={cn("rounded-md border px-2 py-0.5 text-xs", days === d ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>{d}d</button>)}</div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={BarChart3} message="No performance data." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Platform</th><th className="p-2">URL</th><th className="p-2 text-right">Views</th><th className="p-2 text-right">Impr</th><th className="p-2 text-right">Reactions</th><th className="p-2 text-right">CTR</th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="p-2"><Badge variant="outline">{p.platform}</Badge></td>
                  <td className="p-2">{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><span className="max-w-[180px] truncate">{p.url}</span><ExternalLink className="h-3 w-3" /></a> : "—"}</td>
                  <td className="p-2 text-right">{formatNumber(p.views)}</td>
                  <td className="p-2 text-right">{formatNumber(p.impressions)}</td>
                  <td className="p-2 text-right">{formatNumber(p.reactions)}</td>
                  <td className="p-2 text-right">{p.ctr_pct != null ? `${p.ctr_pct}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
