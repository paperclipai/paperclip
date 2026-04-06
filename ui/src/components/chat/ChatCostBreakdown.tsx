interface CostSummaryData {
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

interface AgentCost {
  agentId: string;
  agentName: string | null;
  costCents: number;
}

interface ChatCostBreakdownProps {
  summary: CostSummaryData;
  agentCosts?: AgentCost[];
  onNavigate: (path: string) => void;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function budgetColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-yellow-500";
  return "bg-emerald-500";
}

export function ChatCostBreakdown({ summary, agentCosts, onNavigate }: ChatCostBreakdownProps) {
  const utilPct = Math.min(summary.utilizationPercent, 100);
  const topAgents = (agentCosts ?? [])
    .filter((a) => a.costCents > 0)
    .sort((a, b) => b.costCents - a.costCents)
    .slice(0, 3);
  const maxAgentCost = topAgents[0]?.costCents ?? 1;

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-3">
      <p className="text-xs font-semibold">Cost Summary (MTD)</p>

      <div className="text-center">
        <p className="text-lg font-semibold tabular-nums">{formatCents(summary.spendCents)}</p>
        <p className="text-xs text-muted-foreground">/ {formatCents(summary.budgetCents)}</p>
      </div>

      <div className="space-y-1">
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full ${budgetColor(summary.utilizationPercent)}`}
            style={{ width: `${utilPct}%` }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground text-right">{Math.round(summary.utilizationPercent)}%</p>
      </div>

      {topAgents.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-muted-foreground">Top agents:</p>
          {topAgents.map((agent) => (
            <div key={agent.agentId} className="flex items-center gap-2">
              <span className="text-xs w-16 truncate">{agent.agentName ?? "Unknown"}</span>
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/60"
                  style={{ width: `${(agent.costCents / maxAgentCost) * 100}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                {formatCents(agent.costCents)}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("costs")}
      >
        View costs &rarr;
      </button>
    </div>
  );
}
