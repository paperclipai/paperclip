import { useMemo } from "react";
import type { BudgetPolicySummary, ProviderQuotaResult, SubscriptionBudgetWindowKind } from "@paperclipai/shared";
import { SUBSCRIPTION_BUDGET_WINDOW_KINDS, SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

/**
 * Company-wide subscription usage limits. One card per provider window
 * (session, week). A window without a policy yet renders a placeholder card
 * seeded from the live quota snapshot so the operator sees current usage
 * before choosing a limit.
 */
export function SubscriptionWindowBudgets({
  companyId,
  companyName,
  policies,
  quotaResults,
  isSaving,
  onSave,
}: {
  companyId: string;
  companyName: string;
  policies: BudgetPolicySummary[];
  quotaResults: ProviderQuotaResult[];
  isSaving: boolean;
  onSave: (input: { windowKind: SubscriptionBudgetWindowKind; amount: number }) => void;
}) {
  const summaries = useMemo(() => {
    const now = new Date();
    return SUBSCRIPTION_BUDGET_WINDOW_KINDS.map((windowKind) => {
      const existing = policies.find(
        (policy) => policy.scopeType === "company" && policy.windowKind === windowKind,
      );
      if (existing) return existing;
      const quotaKey = SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[windowKind];
      // null until some provider reports the window; the card then shows the
      // usage as unavailable instead of a healthy 0%.
      let usedPercent: number | null = null;
      let resetsAt: Date | null = null;
      let usageStale = false;
      let usageObservedAt: string | null = null;
      for (const result of quotaResults) {
        if (!result.ok) continue;
        const window = result.windows.find((row) => row.key === quotaKey);
        if (!window || window.usedPercent == null) continue;
        if (usedPercent == null || window.usedPercent > usedPercent) {
          usedPercent = window.usedPercent;
          resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
          usageStale = result.stale === true;
          usageObservedAt = result.observedAt ?? null;
        }
      }
      const placeholder: BudgetPolicySummary = {
        policyId: `placeholder:${windowKind}`,
        companyId,
        scopeType: "company",
        scopeId: companyId,
        scopeName: companyName,
        metric: "subscription_percent",
        windowKind,
        amount: 0,
        observedAmount: usedPercent ?? 0,
        remainingAmount: 0,
        utilizationPercent: 0,
        usageUnavailable: usedPercent == null,
        usageStale,
        usageObservedAt,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: false,
        status: "ok",
        paused: false,
        pauseReason: null,
        windowStart: now,
        windowEnd: resetsAt ?? now,
      };
      return placeholder;
    });
  }, [companyId, companyName, policies, quotaResults]);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Subscription usage limits</h2>
        <p className="text-sm text-muted-foreground">
          Defer new runs while the provider subscription window is at or above the limit. Runs resume on their own when the window resets; nothing is paused and no approval is opened.
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {summaries.map((summary) => (
          <BudgetPolicyCard
            key={summary.policyId}
            summary={summary}
            isSaving={isSaving}
            onSave={(amount) =>
              onSave({ windowKind: summary.windowKind as SubscriptionBudgetWindowKind, amount })}
          />
        ))}
      </div>
    </section>
  );
}
