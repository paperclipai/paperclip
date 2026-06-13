import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi, type AgentScorecard } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Info } from "lucide-react";

const WINDOW_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%`;
}

interface MetricCellProps {
  /** Formatted value, or "—" when N/A. */
  display: string;
  /** Sample size backing this metric. */
  n: number;
  /** False → render muted + show the n so the reader discounts it. */
  sufficient: boolean;
  /** Optional emphasis (e.g. high failure rate) — applied only when sufficient. */
  tone?: "neutral" | "good" | "warn" | "bad";
}

function MetricCell({ display, n, sufficient, tone = "neutral" }: MetricCellProps) {
  const toneClass = sufficient
    ? {
        neutral: "text-foreground",
        good: "text-foreground",
        warn: "text-foreground",
        bad: "text-destructive",
      }[tone]
    : "text-muted-foreground";
  return (
    <div className="flex flex-col items-end tabular-nums">
      <span className={cn("font-medium", toneClass)}>{display}</span>
      <span className="text-[10px] text-muted-foreground">n={n}</span>
    </div>
  );
}

function HeaderCell({ label, hint, align = "right" }: { label: string; hint: string; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 text-xs font-medium text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
            {label}
            <Info className="h-3 w-3 opacity-60" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-xs">{hint}</TooltipContent>
      </Tooltip>
    </th>
  );
}

function ScorecardRow({ card, ranked }: { card: AgentScorecard; ranked: boolean }) {
  const costDisplay = card.costPerDoneIssue === null ? "—" : formatUsd(card.costPerDoneIssue);
  const failureTone = card.failureRate !== null && card.failureRate >= 0.3 ? "bad" : "neutral";
  return (
    <tr className={cn("border-t border-border", !ranked && "opacity-70")}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{card.agentName}</span>
          {card.status !== "active" && card.status !== "idle" && (
            <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
              {card.status}
            </Badge>
          )}
          {!ranked && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              insufficient sample
            </Badge>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <MetricCell display={costDisplay} n={card.doneIssues} sufficient={card.perMetricSufficient.costPerDoneIssue} />
      </td>
      <td className="px-3 py-2 text-right">
        <MetricCell
          display={formatPercent(card.failureRate)}
          n={card.completedRuns}
          sufficient={card.perMetricSufficient.failureRate}
          tone={failureTone}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <MetricCell
          display={formatPercent(card.reviewPassRate)}
          n={card.reviewedIssues}
          sufficient={card.perMetricSufficient.reviewPassRate}
        />
      </td>
    </tr>
  );
}

interface AgentScorecardsPanelProps {
  companyId: string;
  className?: string;
}

export const AgentScorecardsPanel = memo(function AgentScorecardsPanel({
  companyId,
  className,
}: AgentScorecardsPanelProps) {
  const [windowDays, setWindowDays] = useState(30);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.dashboard(companyId), "agent-scorecards", windowDays],
    queryFn: () => dashboardApi.agentScorecards(companyId, windowDays),
    enabled: !!companyId,
  });

  const { ranked, lowSample } = useMemo(() => {
    const agents = data?.agents ?? [];
    return {
      ranked: agents.filter((a) => !a.lowSample),
      // Sort low-sample by name so the group reads as a roster, not a ranking.
      lowSample: agents
        .filter((a) => a.lowSample)
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
    };
  }, [data]);

  return (
    <section
      id="agent-scorecards"
      className={cn("scroll-mt-20 rounded-xl border border-border bg-card p-4 shadow-sm", className)}
      aria-label="Agent scorecards"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Agent scorecards</h2>
          <p className="text-xs text-muted-foreground">
            Cost, reliability, and review quality per agent — input for the monthly staffing routine.
          </p>
        </div>
        <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Time window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      {error && (
        <p className="py-6 text-center text-sm text-destructive">Could not load agent scorecards.</p>
      )}

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && !error && data && (
        <TooltipProvider delayDuration={150}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <HeaderCell label="Agent" hint="Active agents in the window. Terminated and pending agents are excluded." align="left" />
                  <HeaderCell
                    label="Cost / done issue"
                    hint="Total model spend attributed to the agent ÷ issues it marked done in the window. n = done issues."
                  />
                  <HeaderCell
                    label="Failure rate"
                    hint="Failed + timed-out runs ÷ terminal runs (cancelled excluded). n = terminal runs."
                  />
                  <HeaderCell
                    label="Review pass"
                    hint="Issues whose latest evidence verdict was pass ÷ all reviewed issues (warn/block count as not-pass). n = reviewed issues."
                  />
                </tr>
              </thead>
              <tbody>
                {ranked.length === 0 && lowSample.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No agent activity in this window.
                    </td>
                  </tr>
                )}
                {ranked.map((card) => (
                  <ScorecardRow key={card.agentId} card={card} ranked />
                ))}
                {lowSample.length > 0 && (
                  <>
                    <tr>
                      <td colSpan={4} className="px-3 pb-1 pt-4">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Insufficient sample — not ranked
                        </span>
                      </td>
                    </tr>
                    {lowSample.map((card) => (
                      <ScorecardRow key={card.agentId} card={card} ranked={false} />
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Ranked agents need ≥{data.minSampleDone} done issues or ≥{data.minSampleRuns} terminal runs. Below
            that, metrics are shown with their sample size <code>n</code> but not ranked — a 1/1 record is not a
            track record.
          </p>
        </TooltipProvider>
      )}
    </section>
  );
});
