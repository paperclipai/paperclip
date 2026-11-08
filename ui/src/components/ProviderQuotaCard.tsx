import { t, i18n, useTranslation, Trans } from "@/i18n";
import { AccountQuotaPanels } from "./AccountQuotaPanels";
import { quotaUnavailableMessage } from "@/lib/quota-refresh";
import { useMemo } from "react";
import type { CostByProviderModel, CostWindowSpendRow, QuotaWindow, ProviderQuotaResult } from "@paperclipai/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QuotaBar } from "./QuotaBar";
import { CostAmount } from "./CostAmount";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "./CodexSubscriptionPanel";
import {
  billingTypeDisplayName,
  formatCents,
  formatTokens,
  providerDisplayName,
  quotaSourceDisplayName,
} from "@/lib/utils";

// ordered display labels for rolling-window rows
const ROLLING_WINDOWS = ["5h", "24h", "7d"] as const;

interface ProviderQuotaCardProps {
  provider: string;
  rows: CostByProviderModel[];
  /** company monthly budget in cents (0 means unlimited) */
  budgetMonthlyCents: number;
  /** Only compare a current-month report with the monthly budget. */
  showBudgetUtilization?: boolean;
  /** total company spend in this period in cents, all providers */
  totalCompanySpendCents: number;
  /** spend in the current calendar week in cents, this provider only */
  weekSpendCents: number;
  /** rolling window rows for this provider: 5h, 24h, 7d */
  windowRows: CostWindowSpendRow[];
  showDeficitNotch: boolean;
  /** live subscription quota windows from the provider's own api */
  quotaWindows?: QuotaWindow[];
  quotaAccounts?: ProviderQuotaResult[];
  quotaRequestFailed?: boolean;
  quotaError?: string | null;
  quotaSource?: string | null;
  quotaLoading?: boolean;
}

export function ProviderQuotaCard({
  provider,
  rows,
  budgetMonthlyCents,
  showBudgetUtilization = true,
  totalCompanySpendCents,
  weekSpendCents,
  windowRows,
  showDeficitNotch,
  quotaAccounts,
  quotaRequestFailed,
  quotaWindows = [],
  quotaError = null,
  quotaSource = null,
  quotaLoading = false,
}: ProviderQuotaCardProps) {
  useTranslation("task-components");
  // single-pass aggregation over rows — memoized so the 8 derived values are not
  // recomputed on every parent render tick (providers tab polls every 30s, and each
  // card is mounted twice: once in the "all" tab grid and once in its per-provider tab).
  const totals = useMemo(() => {
    let inputTokens = 0, outputTokens = 0, costCents = 0;
    let apiRunCount = 0, subRunCount = 0, subInputTokens = 0, subOutputTokens = 0;
    let eventCount = 0, estimatedEventCount = 0, unpricedEventCount = 0;
    for (const r of rows) {
      inputTokens += r.inputTokens + r.cachedInputTokens;
      outputTokens += r.outputTokens;
      costCents += r.costCents;
      eventCount += r.eventCount ?? 0;
      estimatedEventCount += r.estimatedEventCount ?? 0;
      unpricedEventCount += r.unpricedEventCount ?? 0;
      apiRunCount += r.apiRunCount;
      subRunCount += r.subscriptionRunCount;
      subInputTokens += r.subscriptionInputTokens + r.subscriptionCachedInputTokens;
      subOutputTokens += r.subscriptionOutputTokens;
    }
    const totalTokens = inputTokens + outputTokens;
    const subTokens = subInputTokens + subOutputTokens;
    // Subscription tokens are already included in the ledger totals.
    const allTokens = totalTokens;
    return {
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalTokens,
      totalCostCents: costCents,
      eventCount, estimatedEventCount, unpricedEventCount,
      totalApiRuns: apiRunCount,
      totalSubRuns: subRunCount,
      totalSubInputTokens: subInputTokens,
      totalSubOutputTokens: subOutputTokens,
      totalSubTokens: subTokens,
      subSharePct: allTokens > 0 ? (subTokens / allTokens) * 100 : 0,
    };
  }, [rows]);

  const {
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCostCents,
    totalApiRuns,
    totalSubRuns,
    totalSubInputTokens,
    totalSubOutputTokens,
    totalSubTokens,
    subSharePct,
  } = totals;

  // Each biller contributes to the company budget; there is no per-biller allocation.
  const providerBudgetShare = budgetMonthlyCents;

  const budgetPct =
    providerBudgetShare > 0
      ? Math.min(100, (totalCostCents / providerBudgetShare) * 100)
      : 0;

  // 4.33 = average weeks per calendar month (52 / 12)
  const weeklyBudgetShare = providerBudgetShare > 0 ? providerBudgetShare / 4.33 : 0;
  const weekPct =
    weeklyBudgetShare > 0 ? Math.min(100, (weekSpendCents / weeklyBudgetShare) * 100) : 0;

  const hasBudget = showBudgetUtilization && budgetMonthlyCents > 0;

  // memoized so the Map and max are not reconstructed on every parent render tick
  const windowMap = useMemo(
    () => new Map(windowRows.map((r) => [r.window, r])),
    [windowRows],
  );
  const maxWindowCents = useMemo(
    () => Math.max(...windowRows.map((r) => r.costCents), 0),
    [windowRows],
  );
  const isClaudeQuotaPanel = provider === "anthropic";
  const isCodexQuotaPanel = provider === "openai" && quotaSource?.startsWith("codex-");
  const supportsSubscriptionQuota = provider === "anthropic" || provider === "openai";
  const showSubscriptionQuotaSection =
    supportsSubscriptionQuota && (quotaLoading || Boolean(quotaAccounts?.length) || quotaWindows.length > 0 || quotaError != null);

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              {providerDisplayName(provider)}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              <Trans ns="deep-ui" i18nKey="provider_io" components={{ input: <span className="font-mono">{formatTokens(totalInputTokens)}</span>, output: <span className="font-mono">{formatTokens(totalOutputTokens)}</span> }} />
              {(totalApiRuns > 0 || totalSubRuns > 0) && (
                <span className="ml-1.5">
                  ·{" "}
                  {totalApiRuns > 0 && t("deep-ui:provider_api_runs", { count: totalApiRuns })}
                  {totalApiRuns > 0 && totalSubRuns > 0 && " / "}
                  {totalSubRuns > 0 && t("task-components:sub_a3762950", { value1: totalSubRuns })}
                  {" "}{(" " + t("task-components:runs_1f64fff0"))}
                </span>
              )}
            </CardDescription>
          </div>
          <div className="text-xl shrink-0">
            <CostAmount costCents={totalCostCents} eventCount={totals.eventCount}
              estimatedEventCount={totals.estimatedEventCount} unpricedEventCount={totals.unpricedEventCount} showUnavailableCount />
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-3 space-y-4">
        {hasBudget && (
          <div className="space-y-3">
            <QuotaBar
              label={t("task-components:periodSpend_9c4819e6")}
              percentUsed={budgetPct}
              leftLabel={formatCents(totalCostCents)}
              rightLabel={t("deep-ui:provider_budget_percent", { percent: Math.round(budgetPct) })}
              showDeficitNotch={showDeficitNotch}
            />
            <QuotaBar
              label={t("task-components:thisWeek_8c4eef5a")}
              percentUsed={weekPct}
              leftLabel={formatCents(weekSpendCents)}
              rightLabel={t("deep-ui:provider_week_budget", { amount: formatCents(Math.round(weeklyBudgetShare)) })}
              showDeficitNotch={weekPct >= 100}
            />
          </div>
        )}

        {/* rolling window consumption — always shown when data is available */}
        {windowRows.length > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("task-components:rollingWindows_72abfe17")}</p>
              <div className="space-y-2.5">
                {ROLLING_WINDOWS.map((w) => {
                  const row = windowMap.get(w);
                  // omit windows with no data rather than showing false $0.00 zeros
                  if (!row) return null;
                  const cents = row.costCents;
                  const tokens = row.inputTokens + row.cachedInputTokens + row.outputTokens;
                  const barPct = maxWindowCents > 0 ? (cents / maxWindowCents) * 100 : 0;
                  return (
                    <div key={w} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono text-muted-foreground w-6 shrink-0">{w}</span>
                        <span className="text-muted-foreground font-mono flex-1">
                          {t("deep-ui:provider_tokens", { tokens: formatTokens(tokens) })}
                        </span>
                        <span className="font-medium tabular-nums">{formatCents(cents)}</span>
                      </div>
                      <div className="h-2 w-full border border-border overflow-hidden">
                        <div
                          className="h-full bg-primary/60 transition-(--tp-width) duration-150"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* subscription usage — shown when any subscription-billed runs exist */}
        {totalSubRuns > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("task-components:subscription_4999c6c6")}</p>
              <p className="text-xs text-muted-foreground">
                <Trans ns="deep-ui" i18nKey="provider_run_count" count={totalSubRuns} components={{ count: <span className="font-mono text-foreground">{totalSubRuns}</span> }} />
                {" · "}
                {totalSubTokens > 0 && (
                  <><Trans ns="task-components" i18nKey="sentence_86e2adb7296a" components={{ part1: <>{<span className="font-mono text-foreground">{formatTokens(totalSubTokens)}</span>}</> }} /></>
                )}
                <Trans ns="deep-ui" i18nKey="provider_io" components={{ input: <span className="font-mono text-foreground">{formatTokens(totalSubInputTokens)}</span>, output: <span className="font-mono text-foreground">{formatTokens(totalSubOutputTokens)}</span> }} />
              </p>
              {subSharePct > 0 && (
                <>
                  <div className="h-1.5 w-full border border-border overflow-hidden">
                    <div
                      className="h-full bg-primary/60 transition-(--tp-width) duration-150"
                      style={{ width: `${subSharePct}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("deep-ui:provider_subscription_share", { percent: Math.round(subSharePct) })}</p>
                </>
              )}
            </div>
          </>
        )}

        {/* model breakdown — always shown, with token-share bars */}
        {rows.length > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-3">
              {rows.map((row) => {
                const rowTokens = row.inputTokens + row.cachedInputTokens + row.outputTokens;
                const tokenPct = totalTokens > 0 ? (rowTokens / totalTokens) * 100 : 0;
                const costPct = totalCostCents > 0 ? (row.costCents / totalCostCents) * 100 : 0;
                return (
                  <div key={`${row.provider}:${row.model}`} className="space-y-1.5">
                    {/* model name and cost */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-xs text-muted-foreground truncate font-mono block">
                          {row.model}
                        </span>
                        <span className="text-(length:--text-micro) text-muted-foreground truncate block">
                          {providerDisplayName(row.biller)} · {billingTypeDisplayName(row.billingType)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 tabular-nums text-xs">
                        <span className="text-muted-foreground">
                          {t("deep-ui:provider_tokens", { tokens: formatTokens(rowTokens) })}
                        </span>
                        <span className="font-medium">{formatCents(row.costCents)}</span>
                      </div>
                    </div>
                    {/* token share bar */}
                    <div className="relative h-2 w-full border border-border overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/60 transition-(--tp-width) duration-150"
                        style={{ width: `${tokenPct}%` }}
                        title={t("task-components:ofProviderTokens_b229bf91", { value1: Math.round(tokenPct) })}
                      />
                      {/* cost share overlay — narrower, opaque, shows relative cost weight */}
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/85 transition-(--tp-width) duration-150"
                        style={{ width: `${costPct}%` }}
                        title={t("task-components:ofProviderCost_1a6626d8", { value1: Math.round(costPct) })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* subscription quota windows from provider api — shown when data is available */}
        {showSubscriptionQuotaSection && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("task-components:subscriptionQuota_45028acf")}</p>
                {quotaSource && !isClaudeQuotaPanel && !isCodexQuotaPanel ? (
                  <span className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {quotaSourceDisplayName(quotaSource)}
                  </span>
                ) : null}
              </div>
              {quotaLoading ? (
                <QuotaPanelSkeleton />
              ) : quotaAccounts?.length ? (
                <AccountQuotaPanels accounts={quotaAccounts} failed={quotaRequestFailed} />
              ) : isClaudeQuotaPanel ? (
                <ClaudeSubscriptionPanel windows={quotaWindows} source={quotaSource} error={quotaError} />
              ) : isCodexQuotaPanel ? (
                <CodexSubscriptionPanel windows={quotaWindows} source={quotaSource} error={quotaError} />
              ) : (
                <>
                  {quotaError ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {quotaUnavailableMessage(quotaWindows.length > 0)}
                    </p>
                  ) : null}
                  <div className="space-y-2.5">
                    {quotaWindows.map((qw) => {
                      const fillColor =
                        qw.usedPercent == null
                          ? null
                          : qw.usedPercent >= 90
                            ? "bg-(--status-task-blocked)"
                            : qw.usedPercent >= 70
                              ? "bg-(--status-task-todo)"
                              : "bg-(--status-task-done)";
                      return (
                        <div key={qw.label} className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-mono text-muted-foreground shrink-0">{qw.label}</span>
                            <span className="flex-1" />
                            {qw.valueLabel != null ? (
                              <span className="font-medium tabular-nums">{qw.valueLabel}</span>
                            ) : qw.usedPercent != null ? (
                              <span className="font-medium tabular-nums">{t("deep-ui:provider_used", { percent: qw.usedPercent })}</span>
                            ) : null}
                          </div>
                          {qw.usedPercent != null && fillColor != null && (
                            <div className="h-2 w-full border border-border overflow-hidden">
                              <div
                                className={`h-full transition-(--tp-width) duration-150 ${fillColor}`}
                                style={{ width: `${qw.usedPercent}%` }}
                              />
                            </div>
                          )}
                          {qw.detail ? (
                            <p className="text-xs text-muted-foreground">
                              {qw.detail}
                            </p>
                          ) : qw.resetsAt ? (
                            <p className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_c55d8b65c3f3" components={{ part1: <>{new Date(qw.resetsAt).toLocaleDateString(i18n.language, { month: "short", day: "numeric" })}</> }} /></p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuotaPanelSkeleton() {
  useTranslation("task-components");
  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-7 w-28" />
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="border border-border px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44 max-w-full" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="mt-3 h-2 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
