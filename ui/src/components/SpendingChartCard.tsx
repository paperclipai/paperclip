import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";
import { getLast14Days } from "./ActivityCharts";
import type { FinanceEvent } from "@paperclipai/shared";

interface SpendingChartCardProps {
  companyId: string;
  monthSpendCents: number;
  monthEffectiveSpendCents: number;
  monthBudgetCents: number;
  monthUtilizationPercent: number;
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function aggregateByDay(events: FinanceEvent[], days: string[]): number[] {
  const dayTotals = new Map<string, number>();
  for (const day of days) dayTotals.set(day, 0);
  for (const event of events) {
    if (event.direction !== "debit") continue;
    const day = new Date(event.occurredAt).toISOString().slice(0, 10);
    const current = dayTotals.get(day);
    if (current !== undefined) {
      dayTotals.set(day, current + event.amountCents);
    }
  }
  return days.map((d) => dayTotals.get(d) ?? 0);
}

function buildPath(values: number[], width: number, height: number, padding: number): { linePath: string; areaPath: string } {
  if (values.length === 0) return { linePath: "", areaPath: "" };

  const maxVal = Math.max(...values, 1);
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;
  const step = usableW / Math.max(values.length - 1, 1);

  const points = values.map((v, i) => ({
    x: padding + i * step,
    y: padding + usableH - (v / maxVal) * usableH,
  }));

  const lineSegments = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${lineSegments} L ${points[points.length - 1].x.toFixed(1)} ${(padding + usableH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padding + usableH).toFixed(1)} Z`;

  return { linePath: lineSegments, areaPath };
}

export function SpendingChartCard({
  companyId,
  monthSpendCents,
  monthEffectiveSpendCents,
  monthBudgetCents,
  monthUtilizationPercent,
}: SpendingChartCardProps) {
  const days = useMemo(() => getLast14Days(), []);
  const fromDate = days[0];
  const toDate = days[days.length - 1];

  const { data: events } = useQuery({
    queryKey: queryKeys.financeEvents(companyId, fromDate, toDate, 500),
    queryFn: () => costsApi.financeEvents(companyId, fromDate, toDate, 500),
    enabled: !!companyId,
  });

  const dailySpend = useMemo(() => aggregateByDay(events ?? [], days), [events, days]);
  const hasChartData = dailySpend.some((v) => v > 0);
  const peakDay = Math.max(...dailySpend);

  const chartW = 260;
  const chartH = 70;
  const pad = 2;
  const { linePath, areaPath } = useMemo(() => buildPath(dailySpend, chartW, chartH, pad), [dailySpend]);

  const hasSubscriptions = monthEffectiveSpendCents > monthSpendCents;
  const displaySpend = monthEffectiveSpendCents > 0 ? monthEffectiveSpendCents : monthSpendCents;

  return (
    <Link to="/costs" className="no-underline text-inherit h-full">
      <div className="h-full rounded-xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5 shadow-sm transition-colors hover:bg-accent/50 cursor-pointer flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums font-mono">
              {formatCents(displaySpend)}
            </p>
            <p className="text-[11px] sm:text-xs font-medium text-muted-foreground mt-1 uppercase tracking-wider">Month Spend</p>
          </div>
          {monthBudgetCents > 0 && (
            <div className="text-right mt-1">
              <span className={cn(
                "text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full",
                monthUtilizationPercent >= 90
                  ? "bg-red-500/15 text-red-600 dark:text-red-400"
                  : monthUtilizationPercent >= 70
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
              )}>
                {monthUtilizationPercent}%
              </span>
              <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                of {formatCents(monthBudgetCents)}
              </p>
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col justify-end mt-3">
          {hasChartData ? (
            <div className="relative">
              <svg
                viewBox={`0 0 ${chartW} ${chartH}`}
                className="w-full"
                preserveAspectRatio="none"
                style={{ height: 70 }}
              >
                <defs>
                  <linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-brand-accent)" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="var(--color-brand-accent)" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path d={areaPath} fill="url(#spend-fill)" />
                <path d={linePath} fill="none" stroke="var(--color-brand-accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-muted-foreground/50 tabular-nums">{formatDayLabel(days[0])}</span>
                <span className="text-[9px] text-muted-foreground/50 tabular-nums">{formatDayLabel(days[days.length - 1])}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[70px]">
              <span className="text-[10px] text-muted-foreground/40">No spending data</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/60 tabular-nums">
          {hasSubscriptions && (
            <>
              <span>{formatCents(monthSpendCents)} metered</span>
              <span className="h-2.5 w-px bg-border" />
              <span>{formatCents(monthEffectiveSpendCents - monthSpendCents)} subs</span>
            </>
          )}
          {!hasSubscriptions && monthBudgetCents > 0 && (
            <span>{formatCents(monthBudgetCents - displaySpend)} remaining</span>
          )}
          {peakDay > 0 && (
            <>
              {(hasSubscriptions || monthBudgetCents > 0) && <span className="h-2.5 w-px bg-border" />}
              <span>peak {formatCents(peakDay)}/day</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
