interface DashboardData {
  agents: { active: number; running: number; paused: number; error: number };
  tasks: { open: number; inProgress: number; blocked: number; done: number };
  costs: { monthSpendCents: number; monthBudgetCents: number; monthUtilizationPercent: number };
  pendingApprovals: number;
}

interface ChatDashboardCardProps {
  data: DashboardData;
  companyName?: string;
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

export function ChatDashboardCard({ data, companyName, onNavigate }: ChatDashboardCardProps) {
  const totalAgents = data.agents.active + data.agents.running + data.agents.paused + data.agents.error;
  const totalIssues = data.tasks.open + data.tasks.inProgress + data.tasks.blocked + data.tasks.done;
  const utilPct = Math.min(data.costs.monthUtilizationPercent, 100);

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-2">
      {companyName && (
        <p className="text-xs font-semibold truncate">{companyName} Dashboard</p>
      )}

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-semibold tabular-nums">{totalAgents}</p>
          <p className="text-[10px] text-muted-foreground">Agents</p>
          <p className="text-[10px] text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-0.5" />{data.agents.running} run
            {data.agents.error > 0 && (
              <> <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 mr-0.5" />{data.agents.error} err</>
            )}
          </p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">{totalIssues}</p>
          <p className="text-[10px] text-muted-foreground">Issues</p>
          <p className="text-[10px] text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 mr-0.5" />{data.tasks.open + data.tasks.inProgress} open
          </p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">{formatCents(data.costs.monthSpendCents)}</p>
          <p className="text-[10px] text-muted-foreground">Spent</p>
          <p className="text-[10px] text-muted-foreground">/ {formatCents(data.costs.monthBudgetCents)}</p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full ${budgetColor(data.costs.monthUtilizationPercent)}`}
            style={{ width: `${utilPct}%` }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground text-right">{Math.round(data.costs.monthUtilizationPercent)}% budget used</p>
      </div>

      {data.pendingApprovals > 0 && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">
          {data.pendingApprovals} pending approval{data.pendingApprovals !== 1 ? "s" : ""}
        </p>
      )}

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("dashboard")}
      >
        View Dashboard &rarr;
      </button>
    </div>
  );
}
