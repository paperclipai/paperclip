import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatTokens, cn } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, AlertTriangle, ShieldAlert } from "lucide-react";

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

  const { data: agentsList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentBudgetMap = useMemo(() => {
    const map = new Map<string, { budgetMonthlyCents: number; spentMonthlyCents: number; status: string }>();
    for (const a of agentsList ?? []) {
      map.set(a.id, {
        budgetMonthlyCents: a.budgetMonthlyCents,
        spentMonthlyCents: a.spentMonthlyCents,
        status: a.status,
      });
    }
    return map;
  }, [agentsList]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  return (
    <div className="space-y-6">
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

          {/* By Agent / By Project */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                {data.byAgent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No cost events yet.</p>
                ) : (
                  <div className="space-y-3">
                    {data.byAgent.map((row) => {
                      const budget = agentBudgetMap.get(row.agentId);
                      const hasBudget = budget && budget.budgetMonthlyCents > 0;
                      const utilPercent = hasBudget
                        ? Math.round((budget.spentMonthlyCents / budget.budgetMonthlyCents) * 100)
                        : 0;
                      const isExceeded = hasBudget && utilPercent >= 100;
                      const isWarning = hasBudget && utilPercent >= 80 && !isExceeded;
                      const isPaused = budget?.status === "paused";

                      return (
                        <div key={row.agentId} className="space-y-1.5">
                          <div className="flex items-start justify-between text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <Identity
                                name={row.agentName ?? row.agentId}
                                size="sm"
                              />
                              {row.agentStatus === "terminated" && (
                                <StatusBadge status="terminated" />
                              )}
                              {isExceeded && (
                                <ShieldAlert className="h-3.5 w-3.5 text-red-500 shrink-0" />
                              )}
                              {isWarning && (
                                <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
                              )}
                              {isPaused && !row.agentStatus?.includes("terminated") && (
                                <StatusBadge status="paused" />
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
                          {hasBudget && (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    isExceeded
                                      ? "bg-red-500"
                                      : isWarning
                                        ? "bg-yellow-500"
                                        : "bg-green-500",
                                  )}
                                  style={{ width: `${Math.min(100, utilPercent)}%` }}
                                />
                              </div>
                              <span className={cn(
                                "text-[10px] tabular-nums shrink-0",
                                isExceeded
                                  ? "text-red-500"
                                  : isWarning
                                    ? "text-yellow-500"
                                    : "text-muted-foreground",
                              )}>
                                {formatCents(budget.spentMonthlyCents)} / {formatCents(budget.budgetMonthlyCents)}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
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
