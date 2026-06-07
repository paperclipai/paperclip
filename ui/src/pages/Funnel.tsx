import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "../lib/utils";

export function Funnel() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Site funnel" }]), [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.funnel,
    queryFn: () => agnbPagesApi.funnel(),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Site funnel</h1>
      <AgnbSubnav group="pipeline" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.steps.length === 0 ? (
        <EmptyState icon={Filter} message="No funnel snapshot yet." />
      ) : (
        <>
          {data.snapshot_date && (
            <p className="text-xs text-muted-foreground">snapshot {data.snapshot_date}</p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {data.steps.map((s) => (
              <Card key={s.step}>
                <CardContent className="p-3">
                  <div className="font-mono text-xs uppercase text-muted-foreground">{s.step}</div>
                  <div className="text-xl font-semibold">{formatNumber(s.count)}</div>
                  <div className="text-[11px] text-muted-foreground">{s.conversion_pct.toFixed(1)}% of top</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {(data.sources?.length ?? 0) > 0 && (
              <div>
                <h2 className="mb-1 text-sm font-medium text-muted-foreground">Traffic sources (30d)</h2>
                <div className="flex flex-col gap-1">
                  {data.sources!.map((s) => (
                    <div key={s.source} className="flex justify-between text-sm">
                      <span>{s.source}</span>
                      <span className="font-mono text-xs text-muted-foreground">{formatNumber(s.views)} views · {formatNumber(s.unique_visitors)} visitors</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(data.pages?.length ?? 0) > 0 && (
              <div>
                <h2 className="mb-1 text-sm font-medium text-muted-foreground">Top pages (30d)</h2>
                <div className="flex flex-col gap-1">
                  {data.pages!.map((p) => (
                    <div key={p.url} className="flex justify-between gap-2 text-sm">
                      <span className="truncate font-mono text-xs">{p.url}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatNumber(p.views)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
