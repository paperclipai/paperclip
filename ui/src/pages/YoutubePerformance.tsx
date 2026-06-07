import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ExternalLink } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "../lib/utils";

export function YoutubePerformance() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Performance" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Performance (30d)</h1>
      <AgnbSubnav group="youtube" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.performance.length === 0 ? (
        <EmptyState icon={BarChart3} message="No performance data." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Platform</th><th className="p-2">URL</th><th className="p-2 text-right">Views</th><th className="p-2 text-right">Watch %</th><th className="p-2 text-right">CTR %</th></tr>
            </thead>
            <tbody>
              {data.performance.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="p-2"><Badge variant="outline">{p.platform}</Badge></td>
                  <td className="p-2">{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><span className="max-w-[200px] truncate">{p.url}</span><ExternalLink className="h-3 w-3" /></a> : "—"}</td>
                  <td className="p-2 text-right">{formatNumber(p.views)}</td>
                  <td className="p-2 text-right">{p.watch_time_sec != null ? `${Math.round(p.watch_time_sec)}s` : "—"}</td>
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
