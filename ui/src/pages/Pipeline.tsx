import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, ExternalLink, MessageSquare } from "lucide-react";
import { pipelineApi, type PipelineCard } from "../api/pipeline";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

const AGNB_BASE =
  (import.meta.env.VITE_AGNB_BASE_URL as string | undefined) ??
  "https://www.allgasnobrakes.online";

function money(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

export function Pipeline() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipeline" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.pipeline,
    queryFn: () => pipelineApi.board(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <PageSkeleton variant="list" />;

  const columns = data?.columns ?? [];
  const allCards = columns.flatMap((c) => c.cards);
  const syncMin = data?.lastSync
    ? Math.round((Date.now() - new Date(data.lastSync).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Pipeline</h1>
            <span className="rounded bg-[#FF7A59]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#FF7A59]">
              HS
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            HubSpot deals by stage (read-only mirror). Open a card in HubSpot to act.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {syncMin != null ? `synced ${syncMin}m ago` : "no sync"}
        </span>
      </div>

      {error && (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      )}

      {(data?.errors?.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="mb-1 font-semibold">HubSpot scope issues — partial data:</p>
          {data!.errors.map((e, i) => (
            <p key={i} className="break-all font-mono opacity-90">{e}</p>
          ))}
        </div>
      )}

      {/* Funnel strip */}
      {(data?.funnel?.length ?? 0) > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {data!.funnel.map((s) => (
            <div
              key={s.stageId}
              className="min-w-[120px] shrink-0 rounded-md border border-border p-2"
            >
              <div className="truncate text-xs font-medium">{s.label}</div>
              <div className="text-sm font-semibold">{Math.round(s.reachedPct)}%</div>
              <div className="text-[11px] text-muted-foreground">
                {s.count} · {money(s.amount) || "$0"}
              </div>
            </div>
          ))}
        </div>
      )}

      {allCards.length === 0 ? (
        <EmptyState icon={LayoutGrid} message="No deals yet." />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((col) => {
            const total = col.cards.reduce((s, c) => s + (c.amount || 0), 0);
            return (
              <div
                key={col.id}
                className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">{col.label}</span>
                    <span className="text-xs text-muted-foreground">{col.cards.length}</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {money(total)}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {col.cards.map((c) => (
                    <DealCard key={c.id} card={c} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DealCard({ card }: { card: PipelineCard }) {
  return (
    <a
      href={card.hubspotUrl}
      target="_blank"
      rel="noreferrer"
      className="block rounded-md border border-border bg-background p-2.5 transition-colors hover:bg-accent/40"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium">{card.name}</span>
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      </div>
      {card.company?.name && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          🏢 {card.company.name}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{card.ownerName}</span>
        {card.amount > 0 && (
          <span className="font-mono text-xs font-medium">{money(card.amount)}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {card.priority && <Badge variant="outline">{card.priority}</Badge>}
        {(card.commentCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="h-3 w-3" />
            {card.commentCount}
          </span>
        )}
        {(card.probability ?? 0) > 0 && <span>{card.probability}%</span>}
        {card.closeAt && <span className="ml-auto">{relativeTime(card.closeAt)}</span>}
      </div>
    </a>
  );
}
