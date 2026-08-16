import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { Gauge, RefreshCw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatCents,
  formatTokens,
  providerDisplayName,
  quotaSourceDisplayName,
} from "@/lib/utils";
import { LedProgress } from "./NothingAesthetic";

interface DashboardQuotaCardProps {
  results: ProviderQuotaResult[];
  isLoading: boolean;
  isFetching: boolean;
  error?: Error | string | null;
  monthTokens: number;
  monthSpendCents: number;
  onRefresh: () => void;
}

function detailText(window: QuotaWindow): string | null {
  if (window.detail?.trim()) return window.detail.trim();
  if (!window.resetsAt) return null;
  const date = new Date(window.resetsAt);
  if (!Number.isFinite(date.getTime())) return null;
  return `Resets ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
}

function normalizedPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function progressTone(percent: number): "success" | "warning" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "success";
}

export function DashboardQuotaCard({
  results,
  isLoading,
  isFetching,
  error = null,
  monthTokens,
  monthSpendCents,
  onRefresh,
}: DashboardQuotaCardProps) {
  const errorMessage = typeof error === "string" ? error : error?.message ?? null;

  return (
    <Card data-testid="dashboard-provider-quota">
      <CardHeader className="px-4 pt-4 pb-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Gauge className="h-4 w-4 text-primary" />
              Usage quota
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              Live quota windows from the installed provider adapters.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={onRefresh}
              disabled={isLoading || isFetching}
            >
              <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              Refresh
            </Button>
            <Link to="/costs" className="text-xs text-muted-foreground hover:text-foreground">
              Details
            </Link>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Month tokens</p>
            <p className="mt-1 font-display text-lg tabular-nums text-foreground">
              {formatTokens(monthTokens)}
            </p>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Month spend</p>
            <p className="mt-1 font-display text-lg tabular-nums text-foreground">
              {formatCents(monthSpendCents)}
            </p>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading live provider quota…</p>
        ) : errorMessage ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Unable to load live provider quota: {errorMessage}
          </div>
        ) : results.length === 0 ? (
          <p className="rounded-md border border-border/60 bg-muted/10 px-3 py-3 text-sm text-muted-foreground">
            No live provider quota was reported by the installed adapters. Open Costs for recorded spend details.
          </p>
        ) : (
          <div className="space-y-3">
            {results.map((result) => {
              const windows = result.windows.slice(0, 6);
              const providerStatus = !result.ok ? "unavailable" : windows.length > 0 ? "live" : "no windows";
              const statusClass = !result.ok
                ? "bg-destructive/10 text-destructive"
                : windows.length > 0
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground";

              return (
                <div key={result.provider} className="rounded-md border border-border/60 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{providerDisplayName(result.provider)}</p>
                      {result.source ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {quotaSourceDisplayName(result.source)}
                        </p>
                      ) : null}
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${statusClass}`}>
                      {providerStatus}
                    </span>
                  </div>

                  {!result.ok ? (
                    <p className="mt-3 text-xs text-destructive">
                      {result.error ?? "The provider quota adapter could not report a result."}
                    </p>
                  ) : windows.length === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">The provider reported no quota windows.</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {windows.map((window) => {
                        const usedPercent = normalizedPercent(window.usedPercent);
                        const detail = detailText(window);
                        const rightLabel = usedPercent == null
                          ? window.valueLabel ?? "reported"
                          : `${Math.max(0, Math.round(100 - usedPercent))}% left`;

                        return (
                          <div key={window.label} className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate text-muted-foreground">{window.label}</span>
                              <span className="shrink-0 tabular-nums">{rightLabel}</span>
                            </div>
                            {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
                            {usedPercent != null ? (
                              <div
                                role="progressbar"
                                aria-label={`${window.label}: ${Math.round(usedPercent)}% used, ${Math.max(0, Math.round(100 - usedPercent))}% available`}
                              >
                                <LedProgress
                                  percent={usedPercent}
                                  tone={progressTone(usedPercent)}
                                  showDeficitNotch={usedPercent >= 90}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
