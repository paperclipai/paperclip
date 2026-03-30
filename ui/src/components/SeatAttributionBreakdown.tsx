import { formatCents } from "@/lib/utils";

interface SeatAttributionBreakdownProps {
  issueOwnerSeatCostCents: number;
  agentSeatCostCents: number;
  unattributedCostCents: number;
  compact?: boolean;
}

function pct(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function SeatAttributionBreakdown({
  issueOwnerSeatCostCents,
  agentSeatCostCents,
  unattributedCostCents,
  compact = false,
}: SeatAttributionBreakdownProps) {
  const total = issueOwnerSeatCostCents + agentSeatCostCents + unattributedCostCents;
  if (total <= 0) return null;

  const segments = [
    {
      key: "issue-owner-seat",
      label: "Issue owner seat",
      value: issueOwnerSeatCostCents,
      className: "bg-emerald-400/80",
    },
    {
      key: "agent-seat",
      label: "Agent seat fallback",
      value: agentSeatCostCents,
      className: "bg-sky-400/80",
    },
    {
      key: "unattributed",
      label: "Unattributed",
      value: unattributedCostCents,
      className: "bg-zinc-500/80",
    },
  ].filter((segment) => segment.value > 0);

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Seat attribution
      </p>
      <div className="flex h-2 w-full overflow-hidden border border-border">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${formatCents(segment.value)}`}
          />
        ))}
      </div>
      <div className={compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs"}>
        {segments.map((segment) => (
          <div key={segment.key} className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              {segment.label} ({pct(segment.value, total)}%)
            </span>
            <span className="font-medium tabular-nums">{formatCents(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
