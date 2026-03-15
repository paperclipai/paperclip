import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PricingState } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatTokens } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function formatCostValue(costCents: number, pricingState: PricingState) {
  if (pricingState === "unpriced") return "Unpriced usage";
  if (pricingState === "estimated") return `${formatCents(costCents)} est.`;
  return formatCents(costCents);
}

function pricingStateCopy(pricingState: PricingState) {
  if (pricingState === "unpriced") return "Token usage exists but no priceable cost data was recorded.";
  if (pricingState === "estimated") return "Spend is partial because some runs were not fully priceable.";
  return "All visible spend data is priceable.";
}

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

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  return (
    <div className="space-y-6">
      <section className="paperclip-monitor-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5">
          <div className="space-y-3">
            <p className="paperclip-kicker">Spend Ledger</p>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">Cost visibility</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                Review budget utilization, agent usage, and project-attributed spend without leaving operations mode.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {presetKeys.map((p) => (
              <Button
                key={p}
                variant={preset === p ? "secondary" : "ghost"}
                size="sm"
                className={preset === p ? "border-primary/30 bg-primary/12 text-foreground" : undefined}
                onClick={() => setPreset(p)}
              >
                {PRESET_LABELS[p]}
              </Button>
            ))}
            {preset === "custom" && (
              <div className="ml-2 flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="paperclip-panel h-9 rounded-full border-primary/20 bg-background/20 px-3 text-sm text-foreground"
                />
                <span className="paperclip-nav-meta text-[0.62rem] text-muted-foreground">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="paperclip-panel h-9 rounded-full border-primary/20 bg-background/20 px-3 text-sm text-foreground"
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && (
        <>
          <section className="paperclip-monitor-card-strong p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="paperclip-chip flex h-10 w-10 items-center justify-center rounded-full">
                    <DollarSign className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="paperclip-monitor-title">{PRESET_LABELS[preset]}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{pricingStateCopy(data.summary.pricingState)}</p>
                  </div>
                </div>
                <p className="text-3xl font-semibold text-foreground sm:text-4xl">
                  {formatCostValue(data.summary.spendCents, data.summary.pricingState)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {data.summary.budgetCents > 0
                    ? `${formatCents(data.summary.budgetCents)} monthly budget`
                    : "Unlimited budget"}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="paperclip-chip min-w-[11rem] rounded-2xl px-4 py-3">
                  <p className="paperclip-monitor-title">Utilization</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">
                    {data.summary.budgetCents > 0 && data.summary.pricingState === "exact"
                      ? `${data.summary.utilizationPercent}%`
                      : "n/a"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">budget usage for the selected window</p>
                </div>
                <div className="paperclip-chip min-w-[11rem] rounded-2xl px-4 py-3">
                  <p className="paperclip-monitor-title">Pricing Quality</p>
                  <p className="mt-2 text-2xl font-semibold capitalize text-foreground">{data.summary.pricingState}</p>
                  <p className="mt-1 text-xs text-muted-foreground">exact, estimated, or unpriced spend</p>
                </div>
              </div>
            </div>

            {/* Keep the utilization bar only when the budget math is trustworthy. */}
            {data.summary.budgetCents > 0 && data.summary.pricingState === "exact" && (
              <div className="mt-5">
                <div className="h-3 w-full overflow-hidden rounded-full bg-background/45">
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
              </div>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="paperclip-monitor-card p-4">
              <div className="mb-4">
                <p className="paperclip-monitor-title">By Agent</p>
                <p className="mt-1 text-sm text-muted-foreground">Which operators are consuming the current budget window.</p>
              </div>
              {data.byAgent.length === 0 ? (
                <p className="text-sm text-muted-foreground">No cost events yet.</p>
              ) : (
                <div className="space-y-2">
                  {data.byAgent.map((row) => (
                    <div
                      key={row.agentId}
                      className="paperclip-monitor-row rounded-2xl border border-border/60 bg-background/25 px-3 py-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <Identity
                            name={row.agentName ?? row.agentId}
                            size="sm"
                          />
                          {row.agentStatus === "terminated" && (
                            <StatusBadge status="terminated" />
                          )}
                        </div>
                        <div className="text-right">
                          <span className="block font-medium">{formatCostValue(row.costCents, row.pricingState)}</span>
                          <span className="text-xs text-muted-foreground">
                            in {formatTokens(row.inputTokens)} / out {formatTokens(row.outputTokens)} tok
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <p>{pricingStateCopy(row.pricingState)}</p>
                        {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                          <p>
                            {row.apiRunCount > 0 ? `api runs: ${row.apiRunCount}` : null}
                            {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                            {row.subscriptionRunCount > 0
                              ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                              : null}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="paperclip-monitor-card p-4">
              <div className="mb-4">
                <p className="paperclip-monitor-title">By Project</p>
                <p className="mt-1 text-sm text-muted-foreground">Project-level attribution for the same spend window.</p>
              </div>
              {data.byProject.length === 0 ? (
                <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
              ) : (
                <div className="space-y-2">
                  {data.byProject.map((row) => (
                    <div
                      key={row.projectId ?? "na"}
                      className="paperclip-monitor-row flex items-center justify-between rounded-2xl border border-border/60 bg-background/25 px-3 py-3 text-sm"
                    >
                      <span className="truncate pr-3">
                        {row.projectName ?? row.projectId ?? "Unattributed"}
                      </span>
                      <div className="text-right">
                        <span className="block font-medium">{formatCostValue(row.costCents, row.pricingState)}</span>
                        <span className="text-xs text-muted-foreground">{pricingStateCopy(row.pricingState)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
