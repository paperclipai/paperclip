import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CostByAgent, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { cn, formatCents, formatTokens } from "../lib/utils";
import { ArrowUpDown, ArrowUp, ArrowDown, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type SortField = "cost" | "done" | "active" | "runs" | "costPerDone";
type SortDir = "asc" | "desc";

interface AgentRoiRow {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  doneCount: number;
  activeCount: number;
  blockedCount: number;
  costPerDone: number | null;
}

function computeRoiRating(
  costPerDone: number | null,
  allRates: number[],
): "excellent" | "good" | "poor" | "none" {
  if (costPerDone === null || allRates.length === 0) return "none";
  if (allRates.length < 2) return "good";
  const sorted = [...allRates].sort((a, b) => a - b);
  const p33 = sorted[Math.floor(sorted.length * 0.33)] ?? sorted[0]!;
  const p66 = sorted[Math.floor(sorted.length * 0.66)] ?? sorted[sorted.length - 1]!;
  if (costPerDone <= p33) return "excellent";
  if (costPerDone <= p66) return "good";
  return "poor";
}

const ratingConfig = {
  excellent: { label: "Excellent", className: "text-emerald-600 dark:text-emerald-400", icon: TrendingUp },
  good: { label: "Good", className: "text-blue-500 dark:text-blue-400", icon: TrendingUp },
  poor: { label: "Poor", className: "text-red-500 dark:text-red-400", icon: TrendingDown },
  none: { label: "—", className: "text-muted-foreground", icon: Minus },
};

function SortIcon({
  field,
  sortField,
  sortDir,
}: {
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
}) {
  if (sortField !== field)
    return <ArrowUpDown className="ml-1 inline-block h-3 w-3 text-muted-foreground/50" />;
  return sortDir === "asc" ? (
    <ArrowUp className="ml-1 inline-block h-3 w-3" />
  ) : (
    <ArrowDown className="ml-1 inline-block h-3 w-3" />
  );
}

interface AgentRoiPanelProps {
  companyId: string;
  byAgent: CostByAgent[];
  periodLabel: string;
}

export function AgentRoiPanel({ companyId, byAgent, periodLabel }: AgentRoiPanelProps) {
  const [sortField, setSortField] = useState<SortField>("cost");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data: issues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    staleTime: 30_000,
  });

  const rows = useMemo<AgentRoiRow[]>(() => {
    if (byAgent.length === 0) return [];

    const doneMap = new Map<string, number>();
    const activeMap = new Map<string, number>();
    const blockedMap = new Map<string, number>();

    for (const issue of (issues ?? []) as Issue[]) {
      const agentId = issue.assigneeAgentId;
      if (!agentId) continue;
      if (issue.status === "done") {
        doneMap.set(agentId, (doneMap.get(agentId) ?? 0) + 1);
      } else if (issue.status === "in_progress" || issue.status === "in_review") {
        activeMap.set(agentId, (activeMap.get(agentId) ?? 0) + 1);
      } else if (issue.status === "blocked") {
        blockedMap.set(agentId, (blockedMap.get(agentId) ?? 0) + 1);
      }
    }

    return byAgent.map((a) => {
      const done = doneMap.get(a.agentId) ?? 0;
      return {
        agentId: a.agentId,
        agentName: a.agentName,
        agentStatus: a.agentStatus,
        costCents: a.costCents,
        inputTokens: a.inputTokens,
        cachedInputTokens: a.cachedInputTokens,
        outputTokens: a.outputTokens,
        apiRunCount: a.apiRunCount,
        subscriptionRunCount: a.subscriptionRunCount,
        doneCount: done,
        activeCount: activeMap.get(a.agentId) ?? 0,
        blockedCount: blockedMap.get(a.agentId) ?? 0,
        costPerDone: done > 0 ? a.costCents / done : null,
      };
    });
  }, [byAgent, issues]);

  const allRates = useMemo(
    () => rows.flatMap((r: AgentRoiRow) => (r.costPerDone !== null ? [r.costPerDone] : [])),
    [rows],
  );

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      let diff = 0;
      switch (sortField) {
        case "cost":
          diff = a.costCents - b.costCents;
          break;
        case "done":
          diff = a.doneCount - b.doneCount;
          break;
        case "active":
          diff = a.activeCount - b.activeCount;
          break;
        case "runs":
          diff =
            a.apiRunCount + a.subscriptionRunCount - (b.apiRunCount + b.subscriptionRunCount);
          break;
        case "costPerDone": {
          const av = a.costPerDone ?? Infinity;
          const bv = b.costPerDone ?? Infinity;
          diff = av - bv;
          break;
        }
      }
      return sortDir === "desc" ? -diff : diff;
    });
  }, [rows, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d: SortDir) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const thBase =
    "select-none cursor-pointer whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground transition-colors";

  if (byAgent.length === 0) {
    return (
      <Card>
        <CardContent className="px-5 py-8 text-sm text-muted-foreground">
          No agent cost data for the selected period. Run some tasks to see ROI metrics here.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <RoiSummaryCards rows={rows} />

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Per-agent breakdown</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground/70">Spend</span> covers the {periodLabel} period.{" "}
            <span className="font-medium text-foreground/70">Done</span> and{" "}
            <span className="font-medium text-foreground/70">Active</span> are all-time task counts.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(thBase, "cursor-default pl-5 hover:text-muted-foreground")}>
                    Agent
                  </th>
                  <th
                    className={cn(thBase, sortField === "cost" && "text-foreground")}
                    onClick={() => toggleSort("cost")}
                  >
                    Spend
                    <SortIcon field="cost" sortField={sortField} sortDir={sortDir} />
                  </th>
                  <th
                    className={cn(thBase, sortField === "done" && "text-foreground")}
                    onClick={() => toggleSort("done")}
                  >
                    Done
                    <SortIcon field="done" sortField={sortField} sortDir={sortDir} />
                  </th>
                  <th
                    className={cn(thBase, sortField === "active" && "text-foreground")}
                    onClick={() => toggleSort("active")}
                  >
                    Active
                    <SortIcon field="active" sortField={sortField} sortDir={sortDir} />
                  </th>
                  <th
                    className={cn(thBase, sortField === "runs" && "text-foreground")}
                    onClick={() => toggleSort("runs")}
                  >
                    Runs
                    <SortIcon field="runs" sortField={sortField} sortDir={sortDir} />
                  </th>
                  <th className={cn(thBase, "cursor-default hover:text-muted-foreground")}>
                    Tokens
                  </th>
                  <th
                    className={cn(thBase, "pr-5", sortField === "costPerDone" && "text-foreground")}
                    onClick={() => toggleSort("costPerDone")}
                  >
                    Cost / Done
                    <SortIcon field="costPerDone" sortField={sortField} sortDir={sortDir} />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((row: AgentRoiRow) => {
                  const rating = computeRoiRating(row.costPerDone, allRates);
                  const { label: ratingLabel, className: ratingClass, icon: RatingIcon } =
                    ratingConfig[rating];
                  const totalRuns = row.apiRunCount + row.subscriptionRunCount;
                  const totalTokens =
                    row.inputTokens + row.cachedInputTokens + row.outputTokens;
                  return (
                    <tr key={row.agentId} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <Identity
                            name={row.agentName ?? row.agentId.slice(0, 8)}
                            size="sm"
                          />
                          {row.agentStatus === "terminated" ? (
                            <StatusBadge status="terminated" />
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 tabular-nums font-medium">
                        {formatCents(row.costCents)}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {row.doneCount > 0 ? (
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                            {row.doneCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        <span className={row.activeCount > 0 ? "text-foreground" : "text-muted-foreground"}>
                          {row.activeCount}
                        </span>
                        {row.blockedCount > 0 ? (
                          <span className="ml-1.5 text-xs text-red-400">
                            +{row.blockedCount} blocked
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        <span className="text-foreground">{totalRuns}</span>
                        {row.subscriptionRunCount > 0 ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({row.subscriptionRunCount} sub)
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                        {formatTokens(totalTokens)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums font-medium">
                            {row.costPerDone !== null ? (
                              formatCents(row.costPerDone)
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-0.5 text-xs font-medium",
                              ratingClass,
                            )}
                          >
                            <RatingIcon className="h-3 w-3 shrink-0" />
                            {ratingLabel}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {issuesLoading ? (
            <p className="px-5 pb-4 pt-3 text-xs text-muted-foreground animate-pulse">
              Loading task counts…
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function RoiSummaryCards({ rows }: { rows: AgentRoiRow[] }) {
  const totalDone = rows.reduce((s, r) => s + r.doneCount, 0);
  const totalCost = rows.reduce((s, r) => s + r.costCents, 0);
  const totalRuns = rows.reduce(
    (s, r) => s + r.apiRunCount + r.subscriptionRunCount,
    0,
  );
  const overallCostPerDone = totalDone > 0 ? totalCost / totalDone : null;

  const withDone = rows.filter((r) => r.costPerDone !== null);
  const bestAgent = withDone.length > 0
    ? [...withDone].sort((a, b) => (a.costPerDone ?? Infinity) - (b.costPerDone ?? Infinity))[0]!
    : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="border border-border p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Done Tasks (all-time)
        </p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{totalDone}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          across {rows.length} agent{rows.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="border border-border p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Avg Cost / Done Task
        </p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">
          {overallCostPerDone !== null ? formatCents(overallCostPerDone) : "—"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatCents(totalCost)} total period spend
        </p>
      </div>
      <div className="border border-border p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Best ROI Agent
        </p>
        {bestAgent != null ? (
          <>
            <p className="mt-2 truncate text-base font-semibold">
              {bestAgent.agentName ?? bestAgent.agentId.slice(0, 8)}
            </p>
            <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
              {formatCents(bestAgent.costPerDone!)} / task · {bestAgent.doneCount} done
            </p>
          </>
        ) : (
          <p className="mt-2 text-base text-muted-foreground">—</p>
        )}
      </div>
      <div className="border border-border p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Total Runs
        </p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{totalRuns}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {totalDone > 0 && totalRuns > 0
            ? `${(totalRuns / totalDone).toFixed(1)} runs / done task`
            : "no done tasks yet"}
        </p>
      </div>
    </div>
  );
}
