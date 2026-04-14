import { Coins, DollarSign, Flame, TrendingUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "../EmptyState";
import { MetricTile } from "./MetricTile";
import { cn, formatCents } from "../../lib/utils";

interface BudgetForecastData {
  currentMonthSpend: number;
  projectedMonthEnd: number;
  monthlyBudget: number | null;
  daysUntilBudgetExhausted: number | null;
  trend: "under" | "on_track" | "over";
  recommendation: string;
}

interface CostAllocationRow {
  projectId: string;
  projectName: string;
  costCents: number;
  issueCount: number;
  costPerIssue: number;
}

interface DeptBudgetVsActualRow {
  department: string;
  actual: number;
  budget: number | null;
  variance: number;
}

interface AgentEfficiencyRow {
  agentId: string;
  agentName: string;
  issuesCompleted: number;
  costPerIssue: number;
  performanceScore: number;
}

export function AnalysisTabContent({
  budgetForecastData,
  costAllocation,
  deptBudgetVsActual,
  agentEfficiency,
}: {
  budgetForecastData?: BudgetForecastData | null;
  costAllocation?: CostAllocationRow[] | null;
  deptBudgetVsActual?: DeptBudgetVsActualRow[] | null;
  agentEfficiency?: AgentEfficiencyRow[] | null;
}) {
  if (!budgetForecastData && !costAllocation && !deptBudgetVsActual && !agentEfficiency) {
    return <EmptyState icon={DollarSign} message="No analysis data available yet." />;
  }

  return (
    <>
      {budgetForecastData && (
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Budget Forecast</CardTitle>
            <CardDescription>
              Projected month-end spend based on current daily run rate.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricTile
                label="Month-to-Date"
                value={formatCents(budgetForecastData.currentMonthSpend)}
                subtitle="Spend so far this month"
                icon={DollarSign}
              />
              <MetricTile
                label="Projected Month-End"
                value={formatCents(budgetForecastData.projectedMonthEnd)}
                subtitle="At current daily rate"
                icon={TrendingUp}
              />
              <MetricTile
                label="Monthly Budget"
                value={budgetForecastData.monthlyBudget ? formatCents(budgetForecastData.monthlyBudget) : "None set"}
                subtitle="Company budget limit"
                icon={Coins}
              />
              <MetricTile
                label="Days Until Exhausted"
                value={budgetForecastData.daysUntilBudgetExhausted !== null ? `${budgetForecastData.daysUntilBudgetExhausted}d` : "N/A"}
                subtitle={budgetForecastData.monthlyBudget ? "At current rate" : "No budget set"}
                icon={Flame}
              />
            </div>
            <div className={cn(
              "rounded-lg border px-4 py-3 text-sm",
              budgetForecastData.trend === "under" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400" :
              budgetForecastData.trend === "on_track" ? "border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400" :
              "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400",
            )}>
              <span className="font-semibold">
                {budgetForecastData.trend === "under" ? "Under Budget" :
                 budgetForecastData.trend === "on_track" ? "On Track" :
                 "Over Budget"}
                {" - "}
              </span>
              {budgetForecastData.recommendation}
            </div>
          </CardContent>
        </Card>
      )}

      {costAllocation && costAllocation.length > 0 && (
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Top Cost Drivers by Project</CardTitle>
            <CardDescription>
              Projects with the highest agent cost this month.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2 space-y-3">
            {(() => {
              const maxCost = Math.max(...costAllocation.map((r) => r.costCents), 1);
              return costAllocation.slice(0, 10).map((row) => (
                <div key={row.projectId} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium truncate max-w-[60%]">{row.projectName}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatCents(row.costCents)} - {row.issueCount} issue{row.issueCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/60 rounded-full transition-[width] duration-500"
                      style={{ width: `${(row.costCents / maxCost) * 100}%` }}
                    />
                  </div>
                </div>
              ));
            })()}
          </CardContent>
        </Card>
      )}

      {deptBudgetVsActual && deptBudgetVsActual.length > 0 && (
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Budget vs Actual by Department</CardTitle>
            <CardDescription>
              Month-to-date actual spend compared to monthly budget allocation per department.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2 space-y-2">
            {deptBudgetVsActual.map((row) => {
              const hasBudget = row.budget !== null && row.budget > 0;
              const overBudget = hasBudget && row.variance > 0;
              const utilizationPct = hasBudget ? Math.min(100, Math.round((row.actual / row.budget!) * 100)) : null;
              return (
                <div key={row.department} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{row.department}</span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {formatCents(row.actual)}
                        {hasBudget && ` / ${formatCents(row.budget!)}`}
                      </span>
                      {hasBudget && (
                        <span className={cn(
                          "font-semibold",
                          overBudget ? "text-red-400" : "text-emerald-400",
                        )}>
                          {overBudget ? "+" : ""}{formatCents(row.variance)}
                        </span>
                      )}
                    </span>
                  </div>
                  {hasBudget && utilizationPct !== null && (
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-500",
                          utilizationPct >= 100 ? "bg-red-500" :
                          utilizationPct >= 80 ? "bg-amber-500" : "bg-emerald-500",
                        )}
                        style={{ width: `${utilizationPct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {agentEfficiency && agentEfficiency.length > 0 && (
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">Agent Cost Efficiency Rankings</CardTitle>
            <CardDescription>
              Agents ranked by cost-per-completed-issue this month. Lower cost = higher ranking.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground">#</th>
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground">Agent</th>
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground text-right">Missions Done</th>
                  <th className="pb-2 pr-4 font-semibold text-muted-foreground text-right">Cost / Mission</th>
                  <th className="pb-2 font-semibold text-muted-foreground text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {agentEfficiency.slice(0, 15).map((row, idx) => (
                  <tr key={row.agentId}>
                    <td className="py-1.5 pr-4 text-muted-foreground tabular-nums">{idx + 1}</td>
                    <td className="py-1.5 pr-4 font-medium truncate max-w-[180px]">{row.agentName}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.issuesCompleted}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {formatCents(row.costPerIssue)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      <span className={cn(
                        "font-semibold",
                        row.performanceScore >= 80 ? "text-emerald-400" :
                        row.performanceScore >= 60 ? "text-blue-400" :
                        row.performanceScore >= 40 ? "text-amber-400" : "text-red-400",
                      )}>
                        {row.performanceScore}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
