import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`;

export function Forecast() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Forecast" }]), [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.forecast,
    queryFn: () => agnbPagesApi.forecast(),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Forecast</h1>
      <AgnbSubnav group="pipeline" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={TrendingUp} message="No forecast data." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Weighted forecast" value={usd(data.totals.weighted)} />
            <Stat label="Total pipeline" value={usd(data.totals.total)} />
            <Stat label="Closed-won" value={usd(data.totals.won)} />
            <Stat label="Open deals" value={String(data.totals.deals)} />
          </div>
          {data.global_ci && (
            <p className="text-xs text-muted-foreground">
              Median {usd(data.global_ci.p50)} · range {usd(data.global_ci.p5)}–{usd(data.global_ci.p95)}
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Bucket</th>
                  <th className="p-2 text-right">Weighted</th>
                  <th className="p-2 text-right">Pipeline</th>
                  <th className="p-2 text-right">Deals</th>
                  <th className="p-2 text-right">Won</th>
                </tr>
              </thead>
              <tbody>
                {data.forecast.map((r) => (
                  <tr key={r.bucket_id ?? "none"} className="border-b border-border/60">
                    <td className="p-2">{r.bucket_name ?? "Unattributed"}</td>
                    <td className="p-2 text-right font-mono">{usd(r.weighted_forecast_usd)}</td>
                    <td className="p-2 text-right font-mono">{usd(r.total_pipeline_usd)}</td>
                    <td className="p-2 text-right">{r.deals_in_pipeline}</td>
                    <td className="p-2 text-right font-mono">{usd(r.won_revenue_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
