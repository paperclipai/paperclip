import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatTokens } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Clock,
  Activity,
  Zap,
} from "lucide-react";
import type { CostForecast, CostEfficiencyAgent } from "@paperclipai/shared";

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d": {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "30d": {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to };
    }
    case "all":
      return { from: "", to: "" };
    case "custom":
      return { from: "", to: "" };
  }
}

const PACING_CONFIG = {
  on_track: { label: "On Track", color: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/20", icon: TrendingUp },
  over_pacing: { label: "Over-pacing", color: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/20", icon: TrendingUp },
  critical: { label: "Critical", color: "text-red-400", bg: "bg-red-400/10", border: "border-red-400/20", icon: TrendingDown },
} as const;

function ForecastCard({ forecast }: { forecast: CostForecast }) {
  const pacing = PACING_CONFIG[forecast.pacingStatus as keyof typeof PACING_CONFIG];
  const PacingIcon = pacing.icon;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium text-muted-foreground">Forecast</p>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border ${pacing.bg} ${pacing.color} ${pacing.border}`}
          >
            <PacingIcon className="h-3 w-3" />
            {pacing.label}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Projected EOM</p>
            <p className="text-lg font-bold tabular-nums">
              {formatCents(forecast.projectedMonthEndCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Daily Avg</p>
            <p className="text-lg font-bold tabular-nums">
              {formatCents(forecast.dailyAvgCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Days Left</p>
            <p className="text-lg font-bold tabular-nums flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              {forecast.daysUntilExhaustion !== null
                ? forecast.daysUntilExhaustion
                : "\u221E"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EfficiencyTable({ agents }: { agents: CostEfficiencyAgent[] }) {
  if (agents.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Efficiency Metrics</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50">
                <th className="text-left font-medium text-muted-foreground pb-2 pr-4">Agent</th>
                <th className="text-right font-medium text-muted-foreground pb-2 px-2">Total Spend</th>
                <th className="text-right font-medium text-muted-foreground pb-2 px-2">$/Completed</th>
                <th className="text-right font-medium text-muted-foreground pb-2 px-2">$/Attempted</th>
                <th className="text-right font-medium text-muted-foreground pb-2 px-2">$/Run</th>
                <th className="text-right font-medium text-muted-foreground pb-2 pl-2">Tasks</th>
                <th className="text-right font-medium text-muted-foreground pb-2 pl-2">Runs</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((row) => (
                <tr key={row.agentId} className="border-b border-border/20 last:border-0">
                  <td className="py-2 pr-4">
                    <Identity name={row.agentName ?? row.agentId} size="sm" />
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums font-medium">
                    {formatCents(row.totalCostCents)}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">
                    {row.costPerTaskCompleted !== null
                      ? formatCents(row.costPerTaskCompleted)
                      : "\u2014"}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">
                    {row.costPerTaskAttempted !== null
                      ? formatCents(row.costPerTaskAttempted)
                      : "\u2014"}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">
                    {row.avgCostPerRun !== null
                      ? formatCents(row.avgCostPerRun)
                      : "\u2014"}
                  </td>
                  <td className="text-right py-2 pl-2 tabular-nums text-muted-foreground">
                    {row.tasksCompleted}/{row.tasksAttempted}
                  </td>
                  <td className="text-right py-2 pl-2 tabular-nums text-muted-foreground">
                    {row.totalRuns}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function formatShortDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TrendChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number; dataKey: string }> }) {
  if (!active || !payload?.length) return null;
  const daily = payload.find((p) => p.dataKey === "spendCents");
  const cumulative = payload.find((p) => p.dataKey === "cumulativeCents");
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-sm shadow-md">
      {daily && (
        <p className="tabular-nums">
          <span className="text-muted-foreground">Daily: </span>
          <span className="font-medium">{formatCents(daily.value)}</span>
        </p>
      )}
      {cumulative && (
        <p className="tabular-nums">
          <span className="text-muted-foreground">Cumulative: </span>
          <span className="font-medium">{formatCents(cumulative.value)}</span>
        </p>
      )}
    </div>
  );
}

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(customTo + "T23:59:59.999Z").toISOString() : "",
      };
    }
    return computeRange(preset);
  }, [preset, customFrom, customTo]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject] = await Promise.all([
        costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byAgent(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byProject(selectedCompanyId!, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject };
    },
    enabled: !!selectedCompanyId,
  });

  const { data: trendData } = useQuery({
    queryKey: queryKeys.costsTrend(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: () =>
      costsApi.trend(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const { data: forecastData } = useQuery({
    queryKey: queryKeys.costsForecast(selectedCompanyId!),
    queryFn: () => costsApi.forecast(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: efficiencyData } = useQuery({
    queryKey: queryKeys.costsEfficiency(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: () =>
      costsApi.efficiency(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  return (
    <div className="space-y-6 animate-page-enter">
      {/* Date range selector */}
      <div className="flex flex-wrap items-center gap-2">
        {presetKeys.map((p) => (
          <Button
            key={p}
            variant={preset === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(p)}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && (
        <>
          {/* Spend Trend Chart */}
          {trendData && trendData.points.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Spend Trend</h3>
                  <div className="flex items-center gap-3 ml-auto text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-blue-500/70" />
                      Daily
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-0.5 bg-emerald-400" />
                      Cumulative
                    </span>
                    {trendData.budgetCents > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-3 h-0.5 border-t border-dashed border-red-400" />
                        Budget
                      </span>
                    )}
                  </div>
                </div>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={trendData.points}
                      margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                    >
                      <XAxis
                        dataKey="date"
                        tickFormatter={formatShortDate}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        width={48}
                      />
                      <Tooltip content={<TrendChartTooltip />} />
                      <Bar
                        dataKey="spendCents"
                        fill="hsl(217 91% 60% / 0.55)"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={32}
                      />
                      <Line
                        dataKey="cumulativeCents"
                        type="monotone"
                        stroke="hsl(160 60% 55%)"
                        strokeWidth={2}
                        dot={false}
                      />
                      {trendData.budgetCents > 0 && (
                        <ReferenceLine
                          y={trendData.budgetCents}
                          stroke="hsl(0 72% 60%)"
                          strokeDasharray="6 4"
                          strokeWidth={1.5}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary + Forecast row */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* Summary card */}
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">{PRESET_LABELS[preset]}</p>
                  {data.summary.budgetCents > 0 && (
                    <p className="text-sm text-muted-foreground">
                      {data.summary.utilizationPercent}% utilized
                    </p>
                  )}
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  {formatCents(data.summary.spendCents)}{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    {data.summary.budgetCents > 0
                      ? `/ ${formatCents(data.summary.budgetCents)}`
                      : "Unlimited budget"}
                  </span>
                </p>
                {data.summary.budgetCents > 0 && (
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-[width,background-color] duration-150 ${
                        data.summary.utilizationPercent > 90
                          ? "bg-red-400"
                          : data.summary.utilizationPercent > 70
                            ? "bg-yellow-400"
                            : "bg-green-400"
                      }`}
                      style={{ width: `${Math.min(100, data.summary.utilizationPercent)}%` }}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Forecast card */}
            {forecastData && <ForecastCard forecast={forecastData} />}
          </div>

          {/* Efficiency Metrics */}
          {efficiencyData && efficiencyData.length > 0 && (
            <EfficiencyTable agents={efficiencyData} />
          )}

          {/* By Agent / By Project */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                {data.byAgent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No cost events yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byAgent.map((row) => (
                      <div
                        key={row.agentId}
                        className="flex items-start justify-between text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Identity
                            name={row.agentName ?? row.agentId}
                            size="sm"
                          />
                          {row.agentStatus === "terminated" && (
                            <StatusBadge status="terminated" />
                          )}
                        </div>
                        <div className="text-right shrink-0 ml-2 tabular-nums">
                          <span className="font-medium block">{formatCents(row.costCents)}</span>
                          <span className="text-xs text-muted-foreground block">
                            in {formatTokens(row.inputTokens)} / out {formatTokens(row.outputTokens)} tok
                          </span>
                          {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                            <span className="text-xs text-muted-foreground block">
                              {row.apiRunCount > 0 ? `api runs: ${row.apiRunCount}` : null}
                              {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                              {row.subscriptionRunCount > 0
                                ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                                : null}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Project</h3>
                {data.byProject.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byProject.map((row) => (
                      <div
                        key={row.projectId ?? "na"}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="truncate">
                          {row.projectName ?? row.projectId ?? "Unattributed"}
                        </span>
                        <span className="font-medium tabular-nums">{formatCents(row.costCents)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
