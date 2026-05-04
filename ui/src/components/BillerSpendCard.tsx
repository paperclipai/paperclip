import { useMemo } from "react";
import type { CostByBiller, CostByProviderModel } from "@paperclipai/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { QuotaBar } from "./QuotaBar";
import { billingTypeDisplayName, formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

interface BillerSpendCardProps {
  row: CostByBiller;
  weekSpendCents: number;
  budgetMonthlyCents: number;
  totalCompanySpendCents: number;
  providerRows: CostByProviderModel[];
}

export function BillerSpendCard({
  row,
  weekSpendCents,
  budgetMonthlyCents,
  totalCompanySpendCents,
  providerRows,
}: BillerSpendCardProps) {
  const providerBreakdown = useMemo(() => {
    const map = new Map<string, { provider: string; costCents: number; inputTokens: number; outputTokens: number; unpricedRunCount: number }>();
    for (const entry of providerRows) {
      const current = map.get(entry.provider) ?? {
        provider: entry.provider,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
        unpricedRunCount: 0,
      };
      current.costCents += entry.costCents;
      current.inputTokens += entry.inputTokens + entry.cachedInputTokens;
      current.outputTokens += entry.outputTokens;
      current.unpricedRunCount += entry.unpricedRunCount ?? 0;
      map.set(entry.provider, current);
    }
    return Array.from(map.values()).sort((a, b) => b.costCents - a.costCents);
  }, [providerRows]);

  const billingTypeBreakdown = useMemo(() => {
    const map = new Map<string, { costCents: number; unpricedRunCount: number }>();
    for (const entry of providerRows) {
      const current = map.get(entry.billingType) ?? { costCents: 0, unpricedRunCount: 0 };
      current.costCents += entry.costCents;
      current.unpricedRunCount += entry.unpricedRunCount ?? 0;
      map.set(entry.billingType, current);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].costCents - a[1].costCents);
  }, [providerRows]);

  const unpricedSuffix = (count: number) => {
    if (count <= 0) return null;
    const label = count === 1 ? "1 run unpriced" : `${count} runs unpriced`;
    return (
      <span
        className="ml-1 text-xs font-normal text-muted-foreground"
        aria-label="Cost data not available for these runs; total may be undercount."
      >
        ({label})
      </span>
    );
  };

  const providerBudgetShare =
    budgetMonthlyCents > 0 && totalCompanySpendCents > 0
      ? (row.costCents / totalCompanySpendCents) * budgetMonthlyCents
      : budgetMonthlyCents;
  const budgetPct =
    providerBudgetShare > 0
      ? Math.min(100, (row.costCents / providerBudgetShare) * 100)
      : 0;

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-0 gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">
              {providerDisplayName(row.biller)}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              <span className="font-mono">{formatTokens(row.inputTokens + row.cachedInputTokens)}</span> in
              {" · "}
              <span className="font-mono">{formatTokens(row.outputTokens)}</span> out
              {" · "}
              {row.providerCount} provider{row.providerCount === 1 ? "" : "s"}
              {" · "}
              {row.modelCount} model{row.modelCount === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <span className="text-xl font-bold tabular-nums shrink-0">
            {formatCents(row.costCents)}
            {unpricedSuffix(row.unpricedRunCount ?? 0)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-3 space-y-4">
        {budgetMonthlyCents > 0 && (
          <QuotaBar
            label="Period spend"
            percentUsed={budgetPct}
            leftLabel={formatCents(row.costCents)}
            rightLabel={`${Math.round(budgetPct)}% of allocation`}
          />
        )}

        <div className="text-xs text-muted-foreground">
          {row.apiRunCount > 0 ? `${row.apiRunCount} metered run${row.apiRunCount === 1 ? "" : "s"}` : "0 metered runs"}
          {" · "}
          {row.subscriptionRunCount > 0
            ? `${row.subscriptionRunCount} subscription run${row.subscriptionRunCount === 1 ? "" : "s"}`
            : "0 subscription runs"}
          {" · "}
          {formatCents(weekSpendCents)} this week
        </div>

        {billingTypeBreakdown.length > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Billing types
              </p>
              <div className="space-y-1.5">
                {billingTypeBreakdown.map(([billingType, agg]) => (
                  <div key={billingType} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{billingTypeDisplayName(billingType as any)}</span>
                    <span className="font-medium tabular-nums">
                      {formatCents(agg.costCents)}
                      {unpricedSuffix(agg.unpricedRunCount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {providerBreakdown.length > 0 && (
          <>
            <div className="border-t border-border" />
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Upstream providers
              </p>
              <div className="space-y-1.5">
                {providerBreakdown.map((entry) => (
                  <div key={entry.provider} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{providerDisplayName(entry.provider)}</span>
                    <div className="text-right tabular-nums">
                      <div className="font-medium">
                        {formatCents(entry.costCents)}
                        {unpricedSuffix(entry.unpricedRunCount)}
                      </div>
                      <div className="text-muted-foreground">
                        {formatTokens(entry.inputTokens + entry.outputTokens)} tok
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
