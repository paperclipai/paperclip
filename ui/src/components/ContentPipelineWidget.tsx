import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { approvalLane, contentTier, type ContentTier } from "../lib/approvals";
import { Link } from "@/lib/router";
import type { Approval } from "@paperclipai/shared";

function classifyTier(approval: Approval): ContentTier | null {
  if (approvalLane(approval) !== "marketing") return null;
  return contentTier(approval);
}

const TIERS: { key: ContentTier; label: string; tier: string; channel: string }[] = [
  { key: "blog", label: "Blog", tier: "Tier 1", channel: "pelergy.com" },
  { key: "social", label: "Social", tier: "Tier 2", channel: "LinkedIn · X" },
  { key: "outreach", label: "Outreach", tier: "Tier 3", channel: "LinkedIn · Email" },
];

const TIER_COLORS: Record<ContentTier, { dot: string; badge: string; text: string }> = {
  blog: { dot: "bg-blue-500", badge: "bg-blue-500/15 text-blue-400", text: "text-blue-400" },
  social: { dot: "bg-purple-500", badge: "bg-purple-500/15 text-purple-400", text: "text-purple-400" },
  outreach: { dot: "bg-green-500", badge: "bg-green-500/15 text-green-400", text: "text-green-400" },
};

function countByStatus(items: Approval[], status: string) {
  return items.filter((a) => a.status === status).length;
}

function TierColumn({ tier, items }: { tier: (typeof TIERS)[number]; items: Approval[] }) {
  const colors = TIER_COLORS[tier.key];
  const pending = countByStatus(items, "pending") + countByStatus(items, "revision_requested");
  const approved = countByStatus(items, "approved");
  const total = items.length;

  return (
    <div className="flex-1 min-w-0 rounded-lg border border-border/50 p-3 space-y-3 bg-background/40">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${colors.dot}`} />
          <span className={`text-[11px] font-medium uppercase tracking-wide ${colors.text}`}>{tier.tier}</span>
        </div>
        <span className="text-[10px] text-muted-foreground">{tier.channel}</span>
      </div>

      <div>
        <p className="text-sm font-medium text-foreground">{tier.label}</p>
      </div>

      <div className="grid grid-cols-3 gap-1 pt-1 border-t border-border/40">
        <Stat label="queue" value={pending} warn={pending > 0} />
        <Stat label="approved" value={approved} />
        <Stat label="total" value={total} muted />
      </div>

      {pending > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/40">
          {items
            .filter((a) => a.status === "pending" || a.status === "revision_requested")
            .slice(0, 3)
            .map((a) => {
              const p = a.payload as Record<string, unknown> | null;
              const title = typeof p?.title === "string" ? p.title : a.id.slice(0, 12);
              return (
                <Link
                  key={a.id}
                  to={`/approvals/${a.id}`}
                  className="block text-[11px] text-muted-foreground hover:text-foreground truncate leading-relaxed no-underline transition-colors"
                >
                  <span className="text-yellow-500 mr-1">·</span>
                  {title}
                </Link>
              );
            })}
          {pending > 3 && (
            <Link to="/approvals/pending" className="block text-[11px] text-muted-foreground hover:text-foreground no-underline">
              + {pending - 3} more
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn = false, muted = false }: { label: string; value: number; warn?: boolean; muted?: boolean }) {
  return (
    <div className="text-center">
      <p className={`text-base font-medium tabular-nums ${warn ? "text-yellow-400" : muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center shrink-0 w-4">
      <svg width="16" height="12" viewBox="0 0 16 12" fill="none" className="text-border">
        <path d="M1 6h11M9 2l4 4-4 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function ContentPipelineWidget({ companyId }: { companyId: string }) {
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const { data: approvals, isLoading, refetch } = useQuery({
    queryKey: [...queryKeys.approvals.list(companyId), "pipeline"],
    queryFn: () => approvalsApi.list(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (approvals) setLastRefresh(new Date());
  }, [approvals]);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const tierBuckets = TIERS.reduce<Record<ContentTier, Approval[]>>(
    (acc, t) => {
      acc[t.key] = [];
      return acc;
    },
    { blog: [], social: [], outreach: [] },
  );

  for (const approval of approvals ?? []) {
    const tier = classifyTier(approval);
    if (tier) tierBuckets[tier].push(approval);
  }

  const totalPending = (approvals ?? []).filter((a) => a.status === "pending" || a.status === "revision_requested").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Content pipeline</h3>
          {totalPending > 0 && (
            <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">{totalPending} pending</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          title={`Last updated ${lastRefresh.toLocaleTimeString()}`}
        >
          {isLoading ? "refreshing…" : `↺ ${lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
        </button>
      </div>

      <div className="flex items-stretch gap-1">
        <div className="flex flex-col justify-center items-center rounded-lg border border-border/40 px-2 py-3 shrink-0 bg-background/40 min-w-[52px]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mb-1.5" />
          <span className="text-[10px] text-muted-foreground text-center leading-tight">Katya</span>
        </div>

        <FlowArrow />

        {TIERS.map((tier, i) => (
          <div key={tier.key} className="flex items-stretch gap-1 flex-1 min-w-0">
            <TierColumn tier={tier} items={tierBuckets[tier.key]} />
            {i < TIERS.length - 1 && <FlowArrow />}
          </div>
        ))}

        <FlowArrow />

        <div className="flex flex-col justify-center items-center rounded-lg border border-border/40 px-2 py-3 shrink-0 bg-background/40 min-w-[52px]">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 mb-1.5" />
          <span className="text-[10px] text-muted-foreground text-center leading-tight">Live</span>
        </div>
      </div>

      <div className="flex justify-end">
        <Link to="/approvals/pending" className="text-[11px] text-muted-foreground hover:text-foreground no-underline transition-colors">
          Review all →
        </Link>
      </div>
    </div>
  );
}
