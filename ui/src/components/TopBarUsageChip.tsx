import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { QuotaWindow } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link } from "@/lib/router";

/**
 * Pick the most relevant quota window to display in the top bar.
 * Priority: shortest active window (session → week) that has usage data.
 */
const WINDOW_PRIORITY = [
  "currentsession",
  "5hlimit",
  "currentweekallmodels",
  "currentweeksonnetonly",
  "currentweeksonnet",
  "currentweekopusonly",
  "currentweekopus",
  "weeklylimit",
  "credits",
  "extrausage",
] as const;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pickPrimaryWindow(windows: QuotaWindow[]): QuotaWindow | null {
  if (windows.length === 0) return null;
  const sorted = [...windows].sort((a, b) => {
    const aIdx = WINDOW_PRIORITY.indexOf(normalizeLabel(a.label) as (typeof WINDOW_PRIORITY)[number]);
    const bIdx = WINDOW_PRIORITY.indexOf(normalizeLabel(b.label) as (typeof WINDOW_PRIORITY)[number]);
    return (aIdx === -1 ? WINDOW_PRIORITY.length : aIdx) - (bIdx === -1 ? WINDOW_PRIORITY.length : bIdx);
  });
  return sorted[0];
}

function fillColor(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-muted-foreground/40";
  if (usedPercent >= 90) return "bg-red-400";
  if (usedPercent >= 70) return "bg-amber-400";
  return "bg-primary/70";
}

function chipBorder(usedPercent: number | null): string {
  if (usedPercent != null && usedPercent >= 90)
    return "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20";
  if (usedPercent != null && usedPercent >= 70)
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20";
  return "border-border bg-muted/50 text-muted-foreground hover:bg-muted";
}

export function TopBarUsageChip() {
  const { selectedCompanyId, selectedCompany } = useCompany();

  const { data: quotaData } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(selectedCompanyId!),
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const primaryWindow = useMemo(() => {
    if (!quotaData) return null;
    const allWindows: QuotaWindow[] = [];
    for (const result of quotaData) {
      if (result.ok) allWindows.push(...result.windows);
    }
    return pickPrimaryWindow(allWindows);
  }, [quotaData]);

  if (!selectedCompanyId || !primaryWindow) return null;

  const pct = primaryWindow.usedPercent;
  const companyPrefix = selectedCompany?.issuePrefix?.toLowerCase() ?? selectedCompanyId;

  return (
    <Link
      to={`/${companyPrefix}/costs`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors shrink-0",
        chipBorder(pct),
      )}
    >
      <Gauge className="h-3 w-3" />
      {primaryWindow.valueLabel ? (
        <span>{primaryWindow.valueLabel}</span>
      ) : pct != null ? (
        <>
          <div className="relative h-1.5 w-10 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full transition-all", fillColor(pct))}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <span>{Math.round(pct)}%</span>
        </>
      ) : (
        <span>{primaryWindow.label}</span>
      )}
    </Link>
  );
}
