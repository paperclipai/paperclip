import type { CostByProviderModel, CostWindowSpendRow } from "@paperclipai/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { QuotaBar } from "./QuotaBar";
import { formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

interface ProviderQuotaCardProps {
  provider: string;
  rows: CostByProviderModel[];
  /** company monthly budget in cents (0 means unlimited) */
  budgetMonthlyCents: number;
  /** total company spend in this period in cents, all providers */
  totalCompanySpendCents: number;
  /** spend in the current calendar week in cents, this provider only */
  weekSpendCents: number;
  /** rolling window rows for this provider: 5h, 24h, 7d */
  windowRows: CostWindowSpendRow[];
  showDeficitNotch: boolean;
}

export function ProviderQuotaCard({
  provider,
  rows,
  budgetMonthlyCents,
  totalCompanySpendCents,
  weekSpendCents,
  windowRows,
  showDeficitNotch,
}: ProviderQuotaCardProps) {
  const totalInputTokens = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = rows.reduce((s, r) => s + r.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalCostCents = rows.reduce((s, r) => s + r.costCents, 0);
  const totalApiRuns = rows.reduce((s, r) => s + r.apiRunCount, 0);
  const totalSubRuns = rows.reduce((s, r) => s + r.subscriptionRunCount, 0);
  const totalSubInputTokens = rows.reduce((s, r) => s + r.subscriptionInputTokens, 0);
  const totalSubOutputTokens = rows.reduce((s, r) => s + r.subscriptionOutputTokens, 0);
  const totalSubTokens = totalSubInputTokens + totalSubOutputTokens;

  // sub share = sub tokens / (api tokens + sub tokens)
  const allTokens = totalTokens + totalSubTokens;
  const subSharePct = allTokens > 0 ? (totalSubTokens / allTokens) * 100 : 0;

  // budget bars: use this provider's own spend vs its pro-rata share of budget
  // pro-rata: if a provider is 40% of total spend, it gets 40% of the budget allocated.
  // falls back to raw provider spend vs total budget when totalCompanySpend is 0.
  const providerBudgetShare =
    budgetMonthlyCents > 0 && totalCompanySpendCents > 0
      ? (totalCostCents / totalCompanySpendCents) * budgetMonthlyCents
      : budgetMonthlyCents;

  const budgetPct =
    providerBudgetShare > 0
      ? Math.min(100, (totalCostCents / providerBudgetShare) * 100)
      : 0;

  const weeklyBudgetShare = providerBudgetShare > 0 ? providerBudgetShare / 4.33 : 0;
  const weekPct =
    weeklyBudgetShare > 0 ? Math.min(100, (weekSpendCents / weeklyBudgetShare) * 100) : 0;

  const hasBudget = budgetMonthlyCents > 0;

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              {providerDisplayName(provider)}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              <span className="font-mono">{formatTokens(totalInputTokens)}</span> in
              {" · "}
              <span className="font-mono">{formatTokens(totalOutputTokens)}</span> out
              {(totalApiRuns > 0 || totalSubRuns > 0) && (
                <span className="ml-1.5">
                  ·{" "}
                  {totalApiRuns > 0 && `~${totalApiRuns} api`}
                  {totalApiRuns > 0 && totalSubRuns > 0 && " / "}
                  {totalSubRuns > 0 && `~${totalSubRuns} sub`}
                  {" runs"}
                </span>
              )}
            </CardDescription>
          </div>
          <span className="text-xl font-bold tabular-nums shrink-0">
            {formatCents(totalCostCents)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-3 space-y-4">
        {hasBudget && (
          <div className="space-y-3">
            <QuotaBar
              label="Period spend"
              percentUsed={budgetPct}
              leftLabel={formatCents(totalCostCents)}
              rightLabel={`${Math.round(budgetPct)}% of allocation`}
              showDeficitNotch={showDeficitNotch}
            />
            <QuotaBar
              label="This week"
              percentUsed={weekPct}
              leftLabel={formatCents(weekSpendCents)}
              rightLabel={`~${formatCents(Math.round(weeklyBudgetShare))} / wk`}
              showDeficitNotch={weekPct >= 100}
            />
          </div>
        )}

        {/* rolling window consumption — always shown when data is available */}
        {windowRows.length > 0 && (() => {
          const WINDOWS = ["5h", "24h", "7d"] as const;
          const windowMap = new Map(windowRows.map((r) => [r.window, r]));
          const maxCents = Math.max(...windowRows.map((r) => r.costCents), 1);
          return (
            <>
              <div className="border-t border-border" />
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Rolling windows
                </p>
                <div className="space-y-2.5">
                  {WINDOWS.map((w) => {
                    const row = windowMap.get(w);
                    const cents = row?.costCents ?? 0;
                    const tokens = (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0);
                    const barPct = maxCents > 0 ? (cents / maxCents) * 100 : 0;
                    return (
                      <div key={w} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono text-muted-foreground w-6 shrink-0">{w}</span>
                          <span className="text-muted-foreground font-mono flex-1">
                            {formatTokens(tokens)} tok
                          </span>
                          <span className="font-medium tabular-nums">{formatCents(cents)}</span>
                        </div>
                        <div className="h-1.5 w-full border border-border overflow-hidden">
                          <div
                            className="h-full bg-primary/60 transition-[width] duration-150"
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          );
        })()}

        {/* subscription usage — shown when any subscription-billed runs exist */}
        {totalSubRuns > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Subscription
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{totalSubRuns}</span> runs
                {" · "}
                <span className="font-mono text-foreground">{formatTokens(totalSubInputTokens)}</span> in
                {" · "}
                <span className="font-mono text-foreground">{formatTokens(totalSubOutputTokens)}</span> out
              </p>
              <div className="h-1.5 w-full border border-border overflow-hidden">
                <div
                  className="h-full bg-primary/60 transition-[width] duration-150"
                  style={{ width: `${subSharePct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {Math.round(subSharePct)}% of token usage via subscription
              </p>
            </div>
          </>
        )}

        {/* model breakdown — always shown, with token-share bars */}
        {rows.length > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-3">
              {rows.map((row) => {
                const rowTokens = row.inputTokens + row.outputTokens;
                const tokenPct = totalTokens > 0 ? (rowTokens / totalTokens) * 100 : 0;
                const costPct = totalCostCents > 0 ? (row.costCents / totalCostCents) * 100 : 0;
                return (
                  <div key={`${row.provider}:${row.model}`} className="space-y-1.5">
                    {/* model name and cost */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate font-mono">
                        {row.model}
                      </span>
                      <div className="flex items-center gap-3 shrink-0 tabular-nums text-xs">
                        <span className="text-muted-foreground">
                          {formatTokens(rowTokens)} tok
                        </span>
                        <span className="font-medium">{formatCents(row.costCents)}</span>
                      </div>
                    </div>
                    {/* token share bar */}
                    <div className="relative h-1.5 w-full border border-border overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/60 transition-[width] duration-150"
                        style={{ width: `${tokenPct}%` }}
                        title={`${Math.round(tokenPct)}% of provider tokens`}
                      />
                      {/* cost share overlay — narrower, opaque, shows relative cost weight */}
                      <div
                        className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-150"
                        style={{ width: `${costPct}%`, opacity: 0.85 }}
                        title={`${Math.round(costPct)}% of provider cost`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
