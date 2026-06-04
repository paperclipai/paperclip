import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import { agnbPagesApi } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

function money(n: number): string {
  if (!n) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

export function Pipeline() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.pipeline,
    queryFn: () => agnbPagesApi.pipelineBoard(),
    refetchInterval: 60_000,
  });

  const columns = data ?? [];
  const dealCount = columns.reduce((n, c) => n + c.cards.length, 0);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Pipeline</h1>
            <span className="rounded bg-[#FF7A59]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#FF7A59]">HS</span>
          </div>
          <p className="text-sm text-muted-foreground">Deals by stage from the HubSpot mirror, kept current by the Sales-Ops Analyst.</p>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : dealCount === 0 ? (
        <EmptyState icon={LayoutGrid} message="No deals in the mirror yet." />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((col) => (
            <div key={col.id} className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/20">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-medium capitalize">{col.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{col.cards.length} · {money(col.total)}</span>
              </div>
              <div className="flex flex-col gap-1.5 p-2">
                {col.cards.map((card) => (
                  <div key={card.id} className="rounded-md border border-border bg-background p-2 text-sm">
                    <div className="font-medium">{card.name}</div>
                    <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{money(card.amount)}</span>
                      {card.closeDate && <span>{new Date(card.closeDate).toLocaleDateString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
