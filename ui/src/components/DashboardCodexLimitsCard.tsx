import type { QuotaWindow } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, quotaSourceDisplayName } from "@/lib/utils";
import {
  findCodexCreditsQuotaWindow,
  formatCodexQuotaDetail,
  getCodexRemainingPercent,
  normalizeCodexQuotaLabel,
  splitCodexQuotaWindows,
} from "@/lib/codexQuota";

interface DashboardCodexLimitsCardProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
  loading?: boolean;
}

function compactWindowLabel(label: string): string {
  const normalized = normalizeCodexQuotaLabel(label);
  if (normalized.includes("5hlimit")) return "5h";
  if (normalized.includes("weeklylimit")) return "Weekly";
  if (normalized === "credits") return "Credits";
  return label;
}

function fillClass(remainingPercent: number | null): string {
  if (remainingPercent == null) return "bg-zinc-700";
  if (remainingPercent <= 10) return "bg-red-400";
  if (remainingPercent <= 30) return "bg-amber-400";
  return "bg-emerald-400";
}

export function DashboardCodexLimitsCard({
  windows,
  source = null,
  error = null,
  loading = false,
}: DashboardCodexLimitsCardProps) {
  const { accountWindows } = splitCodexQuotaWindows(windows);
  const usageWindows = accountWindows.filter((window) => {
    const normalized = normalizeCodexQuotaLabel(window.label);
    return typeof window.usedPercent === "number" &&
      (normalized.includes("5hlimit") || normalized.includes("weeklylimit"));
  });
  const creditsWindow = findCodexCreditsQuotaWindow(accountWindows);
  const hasVisibleWindows = usageWindows.length > 0 || creditsWindow != null;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">Rate limits remaining</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {hasVisibleWindows
                ? "Live Codex account windows."
                : loading
                  ? "Checking live Codex rate limits."
                  : "Codex usage is tracked, but live rate limits are unavailable right now."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {source ? (
              <span className="shrink-0 border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {quotaSourceDisplayName(source)}
              </span>
            ) : null}
            <Link to="/costs" className="text-xs font-medium text-muted-foreground no-underline hover:text-foreground">
              Open costs
            </Link>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-5 pb-5 pt-4">
        {hasVisibleWindows ? (
          <div className="border border-border divide-y divide-border">
            {usageWindows.map((window) => {
              const remainingPercent = getCodexRemainingPercent(window);
              const detail = formatCodexQuotaDetail(window);
              return (
                <div key={window.label} className="px-4 py-3">
                  <div className="grid grid-cols-[minmax(4rem,1fr)_auto_auto] items-center gap-3">
                    <div className="text-sm font-semibold text-foreground">
                      {compactWindowLabel(window.label)}
                    </div>
                    <div className="text-sm font-semibold tabular-nums text-foreground">
                      {remainingPercent != null ? `${remainingPercent}%` : "—"}
                    </div>
                    <div className="min-w-12 text-right text-xs tabular-nums text-muted-foreground">
                      {detail ?? ""}
                    </div>
                  </div>

                  <div className="mt-2 h-1.5 overflow-hidden bg-muted">
                    <div
                      className={cn("h-full transition-[width] duration-200", fillClass(remainingPercent))}
                      style={{ width: `${Math.max(0, Math.min(100, remainingPercent ?? 0))}%` }}
                    />
                  </div>
                </div>
              );
            })}

            {creditsWindow ? (
              <div className="grid grid-cols-[minmax(4rem,1fr)_auto] items-center gap-3 px-4 py-3">
                <div className="text-sm font-semibold text-foreground">Credits</div>
                <div className="text-right text-sm font-semibold tabular-nums text-foreground">
                  {creditsWindow.valueLabel}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            {loading
              ? "Checking live Codex rate limits."
              : error ?? "Paperclip could not load live Codex rate limits right now."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
