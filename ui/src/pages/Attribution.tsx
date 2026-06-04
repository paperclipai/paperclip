import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function Attribution() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Attribution" }]), [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.attribution,
    queryFn: () => agnbPagesApi.attribution(),
  });

  const total = (data?.matched ?? 0) + (data?.unmatched ?? 0);
  const matchPct = total > 0 ? Math.round(((data?.matched ?? 0) / total) * 100) : 0;

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Attribution</h1>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Link2} message="No attribution data." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Match rate</div><div className="text-xl font-semibold">{matchPct}%</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Unmatched</div><div className={cnNum(data.unmatched)}>{data.unmatched}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Matched</div><div className="text-xl font-semibold">{data.matched}</div></CardContent></Card>
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Recent unmatched</h2>
          {data.recent_unmatched.length === 0 ? (
            <p className="text-xs text-muted-foreground">none — all attributed</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.recent_unmatched.map((e) => (
                <Card key={e.id}>
                  <CardContent className="flex items-center justify-between gap-3 p-2.5 text-sm">
                    <div className="min-w-0">
                      <Badge variant="outline">{e.event_type}</Badge>
                      <span className="ml-2">{e.contact_name ?? e.email ?? "unknown"}</span>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      {e.amount_usd ? <span className="text-emerald-600">${e.amount_usd}</span> : null}
                      <div>{e.source} · {relativeTime(e.occurred_at)}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function cnNum(unmatched: number) {
  return unmatched > 5 ? "text-xl font-semibold text-amber-600" : "text-xl font-semibold";
}
