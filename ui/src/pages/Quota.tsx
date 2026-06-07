import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { miscApi } from "../api/agnbMisc";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";

function barColor(pct: number) { return pct >= 100 ? "#dc2626" : pct >= 70 ? "#d97706" : "#16a34a"; }

export function Quota() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Quota" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.quota, queryFn: () => miscApi.quota(), refetchInterval: 60_000 });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Rocket quota</h1>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Gauge} message="No quota data." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((q) => (
            <Card key={q.method}><CardContent className="p-3">
              <div className="flex items-center justify-between"><span className="font-mono text-xs">{q.method}</span><span className="text-[11px] text-muted-foreground">avg {q.avg7d}/d</span></div>
              <div className="mt-1 text-sm font-semibold">{q.used} / {q.cap}</div>
              <div className="mt-1 h-1.5 w-full rounded-full bg-muted"><div className="h-1.5 rounded-full" style={{ width: `${Math.min(q.pct, 100)}%`, background: barColor(q.pct) }} /></div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
