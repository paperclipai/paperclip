import { useQuery } from "@tanstack/react-query";
import { ccrotateApi, type CcrotateAccountRow, type CcrotateTarget } from "../api/ccrotate";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "../api/client";
import { cn } from "@/lib/utils";

interface CcrotatePoolSectionProps {
  companyId: string;
  target: CcrotateTarget;
}

/** Renders the multi-account ccrotate pool for a single target (claude or codex).
 * Designed to slot into ProviderQuotaCard alongside the single-account
 * ClaudeSubscriptionPanel / CodexSubscriptionPanel — those show the *active*
 * account; this shows every snapped account so an operator can see what the
 * pool will rotate to next. */
export function CcrotatePoolSection({ companyId, target }: CcrotatePoolSectionProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.ccrotate.snapshot(companyId),
    queryFn: () => ccrotateApi.snapshot(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
    retry: false,
  });

  // Plugin-not-installed (404) is expected for instances that haven't installed
  // kkroo.ccrotate — render nothing rather than an error.
  if (error instanceof ApiError && error.status === 404) return null;

  const slot = data?.targets?.[target];

  // Nothing useful to show: no plugin response yet, or the plugin returned an
  // empty pool for this target. Stay silent rather than render an empty card.
  if (!data && !isLoading) return null;
  if (data && !slot?.error && (!slot?.accounts || slot.accounts.length === 0)) return null;

  const accounts = slot?.accounts ?? [];

  return (
    <>
      <div className="border-t border-border" />
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            ccrotate pool
          </p>
          <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"}
            {data?.cacheAge ? ` · ${data.cacheAge}` : ""}
          </span>
        </div>
        {error instanceof Error && !(error instanceof ApiError && error.status === 404) ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : null}
        {slot?.error ? <p className="text-xs text-destructive">{slot.error}</p> : null}
        <div className="space-y-1.5">
          {accounts.map((row) => (
            <PoolRow key={row.email} row={row} />
          ))}
        </div>
      </div>
    </>
  );
}

function PoolRow({ row }: { row: CcrotateAccountRow }) {
  const tierColor = tierColorClass(row.tier);
  const u5Color = utilColorClass(row.utilization5h);
  const u7Color = utilColorClass(row.utilization7d);
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums",
        !row.isHealthy && "opacity-55",
      )}
    >
      <span
        className={cn(
          "shrink-0 w-3 text-center font-bold",
          row.isActive ? "text-yellow-400" : row.isHealthy ? "text-green-400" : "text-red-400",
        )}
      >
        {row.isActive ? "★" : row.isHealthy ? "✓" : "✗"}
      </span>
      <span className="font-mono truncate flex-1 min-w-0">{row.email}</span>
      <span className={cn("shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold lowercase", tierColor)}>
        {row.tier}
      </span>
      <span className={cn("font-mono shrink-0 w-12 text-right", u5Color)}>
        {row.utilization5h === null ? "—" : `${row.utilization5h}%`}
      </span>
      <span className={cn("font-mono shrink-0 w-12 text-right", u7Color)}>
        {row.utilization7d === null ? "—" : `${row.utilization7d}%`}
      </span>
      <span className="text-muted-foreground shrink-0 w-24 text-right truncate">
        {row.availability}
      </span>
    </div>
  );
}

function tierColorClass(tier: string): string {
  const t = tier.toLowerCase();
  if (t === "base" || t === "available") return "bg-green-500/15 text-green-400";
  if (t === "extra" || t === "near_limit") return "bg-yellow-500/15 text-yellow-400";
  if (t === "exhausted" || t === "stale") return "bg-red-500/15 text-red-400";
  return "bg-muted text-muted-foreground";
}

function utilColorClass(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 95) return "text-red-400";
  if (pct >= 70) return "text-yellow-400";
  return "text-foreground";
}
