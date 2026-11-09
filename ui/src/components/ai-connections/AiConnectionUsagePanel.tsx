import { t, useTranslation } from "@/i18n";
import { useMutation } from "@tanstack/react-query";
import type { AiConnectionUsage, AiConnectionUsageLimit, AiManagedConnectionSummary } from "@paperclipai/shared";
import { supportsAiConnectionUsage } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { QuotaBar } from "@/components/QuotaBar";
import { formatDateTime, formatNumber } from "@/lib/utils";

const usageNumber = (value: number) => formatNumber(value, { maximumFractionDigits: 20 });
const amount = (value: number, unit: string | null) => unit === "USD"
  ? formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 20 })
  : `${usageNumber(value)}${unit ? ` ${unit}` : ""}`;

function limitLabel(window: AiConnectionUsageLimit) {
  const label = window.label.replace(/\b(\d+(?:\.\d+)?) hour limit\b/i, "$1h").replace(/\bweekly limit\b/i, "Weekly");
  if (window.windowDurationSeconds == null) return label;
  const hours = window.windowDurationSeconds / 3600;
  const period = hours === 168 ? "Weekly" : `${usageNumber(hours)}h`;
  if (/\b(?:Primary|Secondary)$/.test(label)) return `${label} · ${period}`;
  if ((hours === 168 && /weekly/i.test(label)) || label.split(/[\s·()]+/).includes(period)) return label;
  return `${label} · ${period}`;
}

function limitValue(window: AiConnectionUsageLimit) {
  if (window.used === 0 && window.limit === 0) return t("agents.AiConnectionUsagePanel.capValue", { amount: amount(window.limit, window.unit) });
  if (window.used != null && window.limit != null) return t("agents.AiConnectionUsagePanel.usedOfLimit", { used: amount(window.used, window.unit), limit: amount(window.limit, window.unit) });
  if (window.usedPercent != null) return t("agents.AiConnectionUsagePanel.usedPercent", { percent: usageNumber(window.usedPercent) });
  if (window.used != null) return t("agents.AiConnectionUsagePanel.usedAmount", { amount: amount(window.used, window.unit) });
  if (window.remainingPercent != null) return t("agents.AiConnectionUsagePanel.leftPercent", { percent: usageNumber(window.remainingPercent) });
  return t("agents.AiConnectionUsagePanel.notReported");
}

function limitDetails(window: AiConnectionUsageLimit) {
  const details: string[] = [];
  if (window.allowed === false) details.push(t("agents.AiConnectionUsagePanel.blocked"));
  else if (window.limitReached === true) details.push(t("agents.AiConnectionUsagePanel.limitReached"));
  if (window.allowed === true && (window.limitReached === true || window.usedPercent == null)) details.push(t("agents.AiConnectionUsagePanel.usageAllowed"));
  if (window.used == null || window.limit == null) {
    if (window.remaining != null) details.push(t("agents.AiConnectionUsagePanel.amountLeft", { amount: amount(window.remaining, window.unit) }));
    if (window.limit != null) details.push(t("agents.AiConnectionUsagePanel.capValue", { amount: amount(window.limit, window.unit) }));
  }
  if (window.resetsAt) details.push(t("agents.AiConnectionUsagePanel.resets", { when: formatDateTime(window.resetsAt, { includeYear: false }) }));
  else if (window.resetInterval) details.push(t("agents.AiConnectionUsagePanel.resets", { when: window.resetInterval }));
  return details.join(" · ");
}

function overageSummary(usage: AiConnectionUsage) {
  const overage = usage.overage!;
  const details = [overage.available === true ? t("agents.AiConnectionUsagePanel.available")
    : overage.enabled === false ? t("agents.AiConnectionUsagePanel.off")
    : overage.available === false ? (overage.enabled === true ? t("agents.AiConnectionUsagePanel.onUnavailable") : t("agents.AiConnectionUsagePanel.unavailable"))
    : overage.enabled === true ? t("agents.AiConnectionUsagePanel.onAvailabilityUnknown") : t("agents.AiConnectionUsagePanel.notReported")];
  if (overage.unlimited === true) details.push(t("agents.AiConnectionUsagePanel.unlimited"));
  else if (overage.balance != null && (overage.balance !== 0 || overage.enabled !== false)) details.push(amount(overage.balance, overage.unit));
  if (overage.remaining != null && (overage.remaining !== 0 || overage.enabled !== false)
    && !usage.limits.some((window) => window.scope === "overage" && window.remaining === overage.remaining && window.unit === overage.unit)) {
    details.push(t("agents.AiConnectionUsagePanel.amountLeft", { amount: amount(overage.remaining, overage.unit) }));
  }
  return details.join(" · ");
}

function usageError(usage: AiConnectionUsage) {
  switch (usage.errorCode) {
    case "authentication_required": return t("agents.AiConnectionUsagePanel.signInAgain");
    case "permission_denied": return t("agents.AiConnectionUsagePanel.accessDenied");
    case "rate_limited": return t("agents.AiConnectionUsagePanel.rateLimited");
    case "provider_unavailable": return t("agents.AiConnectionUsagePanel.providerUnavailable");
    case "invalid_response": return t("agents.AiConnectionUsagePanel.invalidResponse");
    case "connection_unavailable": return t("agents.AiConnectionUsagePanel.reconnectToCheck");
    case "unsupported": return t("agents.AiConnectionUsagePanel.unavailableUsage");
    default: return usage.message ?? t("agents.AiConnectionUsagePanel.unavailableUsage");
  }
}

export function AiConnectionUsagePanel({ account, observation, cachedOnly = false }: { account: AiManagedConnectionSummary; observation?: AiConnectionUsage; cachedOnly?: boolean }) {
  const probe = useMutation({
    mutationFn: () => aiConnectionsApi.probeUsage(account.companyId, account.id, account.grantId),
  });
  const supported = supportsAiConnectionUsage(account.provider, account.method);
  const usage = cachedOnly ? observation : probe.isSuccess ? probe.data : undefined;
  return (
    <section aria-label={t("agents.AiConnectionUsagePanel.usageLimitsAria")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("agents.AiConnectionUsagePanel.usage")}</h3>
        {supported && !cachedOnly && <Button variant="outline" size="sm" disabled={probe.isPending || account.status !== "connected"} onClick={() => probe.mutate()}>
          {probe.isPending ? t("agents.AiConnectionUsagePanel.checking") : usage?.status === "ok" ? t("agents.AiConnectionUsagePanel.refresh") : t("agents.AiConnectionUsagePanel.checkUsage")}
        </Button>}
      </div>
      {cachedOnly && !usage && <p className="text-xs text-muted-foreground">{t("agents.AiConnectionUsagePanel.usageNotObserved")}</p>}
      {!supported && <p className="text-xs text-muted-foreground">{t("agents.AiConnectionUsagePanel.unavailableForMethod")}</p>}
      {probe.error && <p role="alert" className="text-sm text-destructive">{describeError(probe.error).body}</p>}
      {usage && usage.status !== "ok" && <p role={usage.status === "unsupported" ? "status" : "alert"} className="text-sm text-muted-foreground">{usageError(usage)}</p>}
      {usage?.status === "ok" && (
        <div className="space-y-3" aria-live="polite">
          {usage.limits.length === 0 && <p className="text-xs text-muted-foreground">{t("agents.AiConnectionUsagePanel.usageNotReported")}</p>}
          {usage.limits.map((window) => {
            const details = limitDetails(window);
            return <div key={window.id} className="space-y-1.5">
              {window.usedPercent != null ? <QuotaBar label={limitLabel(window)} percentUsed={window.usedPercent} leftLabel={limitValue(window)} />
                : <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">{limitLabel(window)}</span>
                  <span className="font-mono">{limitValue(window)}</span>
                </div>}
              {details && <p className="text-xs text-muted-foreground">{details}</p>}
            </div>;
          })}
          {usage.overage && <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t("agents.AiConnectionUsagePanel.overage")}</span>
            <span className="font-mono">{overageSummary(usage)}</span>
          </div>}
          <p className="text-xs text-muted-foreground">{t("agents.AiConnectionUsagePanel.updated")} <time className="font-mono" dateTime={usage.checkedAt} title={formatDateTime(usage.checkedAt)}>{formatDateTime(usage.checkedAt, { includeYear: false })}</time>{usage.planType ? ` · ${usage.planType}` : ""}</p>
        </div>
      )}
    </section>
  );
}
