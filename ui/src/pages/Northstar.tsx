import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * North-star exec view — the KPIs the company steers by, in one screen. The
 * scoreboard for the CEO daily-review loop.
 */
export function Northstar() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "North star" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agnb", "north-star"],
    queryFn: () => opsApi.northStar(),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">North star</h1>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Target} message="No data." />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <Kpi label="Open pipeline" value={money(data.pipeline.open_value_usd)} sub={`${data.pipeline.open_deals} deals`} />
          <Kpi label="Share of voice" value={data.sov.mention_rate != null ? `${data.sov.mention_rate}%` : "—"} sub={`${data.sov.runs} runs / 30d`} />
          <Kpi label="Avg review rating" value={data.reviews.avg_rating != null ? `${data.reviews.avg_rating.toFixed(2)}★` : "—"} sub={`${data.reviews.total_reviews} reviews · ${data.reviews.platforms} platforms`} />
          <Kpi label="Mentions (30d)" value={String(data.mentions.total_30d)} sub={`${data.mentions.positive} pos · ${data.mentions.negative} neg`} />
          <Kpi label="Backlinks earned" value={String(data.backlinks.earned)} sub={`${data.backlinks.prospects} prospects`} />
          <Kpi label="Content gaps" value={String(data.content.open_gaps)} sub={`${data.content.idea_inbox} ideas queued`} />
        </div>
      )}
    </div>
  );
}
