import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function Sov() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Share of voice" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.sov, queryFn: () => mentionsApi.sov() });

  const stats = useMemo(() => {
    const res = data?.results ?? [];
    const total = res.length;
    const mentioned = res.filter((r) => r.brand_mentioned).length;
    return { total, rate: total ? Math.round((mentioned / total) * 100) : 0 };
  }, [data]);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <h1 className="text-lg font-semibold">Share of voice</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Radar} message="No SoV data." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Prompts</div><div className="text-xl font-semibold">{data.prompts.length}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Runs</div><div className="text-xl font-semibold">{stats.total}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Brand mention rate</div><div className="text-xl font-semibold">{stats.rate}%</div></CardContent></Card>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Recent runs</h2>
          <div className="flex flex-col gap-1">
            {data.results.slice(0, 60).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <div className="flex items-center gap-2"><Badge variant="outline">{r.engine}</Badge>{r.brand_mentioned ? <span className="text-emerald-600">mentioned{r.position ? ` #${r.position}` : ""}</span> : <span className="text-muted-foreground">no mention</span>}</div>
                <span className="text-[11px] text-muted-foreground">{relativeTime(r.ran_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
