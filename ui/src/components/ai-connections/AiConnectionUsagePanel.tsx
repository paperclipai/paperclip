import { t, useTranslation } from "@/i18n";
import { useMutation } from "@tanstack/react-query";
import type { AiConnectionUsage, AiConnectionUsageLimit, AiManagedConnectionSummary } from "@paperclipai/shared";
import { supportsAiConnectionUsage } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { QuotaBar } from "@/components/QuotaBar";
import { formatDateTime, formatNumber } from "@/lib/utils";

const usageNumber = (value: number) => formatNumber(value, { maximumFractionDigits: 20 });
const amount = (value: number, unit: string | null) => unit === "USD"
  ? formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 20 })
  : unit && ["credits", "requests", "cents"].includes(unit)
    ? t(`oct5Apps.units.${unit}`, { count: value, value: usageNumber(value) })
    : `${usageNumber(value)}${unit ? ` ${unit}` : ""}`;

// These labels are authored by Paperclip's usage normalizer. Unknown provider
// labels and suffixes remain verbatim.
function usageLabel(label: string): string {
  const known: Record<string, string> = {
    "Weekly": "weekly", "Sonnet Weekly": "sonnetWeekly", "Opus Weekly": "opusWeekly",
    "OAuth apps Weekly": "oauthWeekly", "Code review": "codeReview",
    "Workspace spend control": "spendControl", "Monthly extra usage": "monthlyExtra",
    "Grok plan credits": "grokCredits", "Grok on-demand credits": "grokOnDemand",
    "API key credit cap": "keyCap", "Free model daily requests": "freeRequests",
    "Primary": "primary", "Secondary": "secondary",
  };
  return label.split(" · ").map((part) => {
    const hours = part.match(/^(\d+(?:\.\d+)?)h$/);
    if (hours) return t("oct5Apps.usageHours", { hours: usageNumber(Number(hours[1])) });
    return known[part] ? t(`oct5Apps.usageLabels.${known[part]}`) : part;
  }).join(" · ");
}

function limitLabel(window: AiConnectionUsageLimit) {
  // Normalize and deduplicate canonical periods before translating the final label.
  const label = window.label.replace(/\b(\d+(?:\.\d+)?) hour limit\b/i, "$1h").replace(/\bweekly limit\b/i, "Weekly");
  if (window.windowDurationSeconds == null) return usageLabel(label);
  const hours = window.windowDurationSeconds / 3600;
  const period = hours === 168 ? "Weekly" : `${hours}h`;
  if (/\b(?:Primary|Secondary)$/.test(label)) return usageLabel(`${label} · ${period}`);
  if ((hours === 168 && /weekly/i.test(label)) || label.split(/[\s·()]+/).includes(period)) return usageLabel(label);
  return usageLabel(`${label} · ${period}`);
}

function limitValue(window: AiConnectionUsageLimit) {
  if (window.used === 0 && window.limit === 0) return t("oct5Apps.usageCap", { amount: amount(window.limit, window.unit) });
  if (window.used != null && window.limit != null) return t("oct5Apps.usageFraction", { used: amount(window.used, window.unit), limit: amount(window.limit, window.unit) });
  if (window.usedPercent != null) return t("oct5Apps.usagePercent", { percent: usageNumber(window.usedPercent) });
  if (window.used != null) return t("oct5Apps.usageUsed", { amount: amount(window.used, window.unit) });
  if (window.remainingPercent != null) return t("oct5Apps.usagePercentLeft", { percent: usageNumber(window.remainingPercent) });
  return t("oct5Apps.copy007");
}

function limitDetails(window: AiConnectionUsageLimit) {
  const details: string[] = [];
  if (window.allowed === false) details.push(t("status.blocked"));
  else if (window.limitReached === true) details.push(t("oct5Apps.copy008"));
  if (window.allowed === true && (window.limitReached === true || window.usedPercent == null)) details.push(t("oct5Apps.copy009"));
  if (window.used == null || window.limit == null) {
    if (window.remaining != null) details.push(t("oct5Apps.usageLeft", { amount: amount(window.remaining, window.unit) }));
    if (window.limit != null) details.push(t("oct5Apps.usageCap", { amount: amount(window.limit, window.unit) }));
  }
  if (window.resetsAt) details.push(t("oct5Apps.usageResets", { when: formatDateTime(window.resetsAt, { includeYear: false }) }));
  else if (window.resetInterval) details.push(t("oct5Apps.usageResets", { when: window.resetInterval }));
  return details.join(" · ");
}

function overageSummary(usage: AiConnectionUsage) {
  const overage = usage.overage!;
  const details = [overage.available === true ? t("runIdentityHistory.githubStatus.available")
    : overage.enabled === false ? t("pages.instanceSettings.off")
    : overage.available === false ? (overage.enabled === true ? t("oct5Apps.copy010") : t("runIdentityHistory.githubStatus.unavailable"))
    : overage.enabled === true ? t("oct5Apps.copy011") : t("oct5Apps.copy007")];
  if (overage.unlimited === true) details.push(t("localizationActivity.unlimited"));
  else if (overage.balance != null && (overage.balance !== 0 || overage.enabled !== false)) details.push(amount(overage.balance, overage.unit));
  if (overage.remaining != null && (overage.remaining !== 0 || overage.enabled !== false)
    && !usage.limits.some((window) => window.scope === "overage" && window.remaining === overage.remaining && window.unit === overage.unit)) {
    details.push(t("oct5Apps.usageLeft", { amount: amount(overage.remaining, overage.unit) }));
  }
  return details.join(" · ");
}

function usageError(usage: AiConnectionUsage) {
  switch (usage.errorCode) {
    case "authentication_required": return t("oct5Apps.copy012");
    case "permission_denied": return t("oct5Apps.copy013");
    case "rate_limited": return t("oct5Apps.copy014");
    case "provider_unavailable": return t("oct5Apps.copy015");
    case "invalid_response": return t("oct5Apps.copy016");
    case "connection_unavailable": return t("oct5Apps.copy017");
    case "unsupported": return t("oct5Apps.copy018");
    default: return usage.message ?? t("oct5Apps.copy018");
  }
}

export function AiConnectionUsagePanel({ account, observation, cachedOnly = false }: { account: AiManagedConnectionSummary; observation?: AiConnectionUsage; cachedOnly?: boolean }) {
  useTranslation();
  const probe = useMutation({
    mutationFn: () => aiConnectionsApi.probeUsage(account.companyId, account.id, account.grantId),
  });
  const supported = supportsAiConnectionUsage(account.provider, account.method);
  const usage = cachedOnly ? observation : probe.isSuccess ? probe.data : undefined;
  return (
    <section aria-label={t("oct5Apps.copy019")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("oct5Apps.copy020")}</h3>
        {supported && !cachedOnly && <Button variant="outline" size="sm" disabled={probe.isPending || account.status !== "connected"} onClick={() => probe.mutate()}>
          {probe.isPending ? t("localizationIssueChrome.checking") : usage?.status === "ok" ? t("oct5Core.s0317") : t("oct5Apps.copy021")}
        </Button>}
      </div>
      {cachedOnly && !usage && <p className="text-xs text-muted-foreground">{t("oct6Beta.copy080")}</p>}
      {!supported && <p className="text-xs text-muted-foreground">{t("oct5Apps.copy022")}</p>}
      {probe.error && <p role="alert" className="text-sm text-destructive">{probe.error.message}</p>}
      {usage && usage.status !== "ok" && <p role={usage.status === "unsupported" ? "status" : "alert"} className="text-sm text-muted-foreground">{usageError(usage)}</p>}
      {usage?.status === "ok" && (
        <div className="space-y-3" aria-live="polite">
          {usage.limits.length === 0 && <p className="text-xs text-muted-foreground">{t("oct5Apps.copy023")}</p>}
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
            <span className="text-muted-foreground">{t("oct5Apps.copy024")}</span>
            <span className="font-mono">{overageSummary(usage)}</span>
          </div>}
          <p className="text-xs text-muted-foreground">{t("oct5Apps.copy025")} <time className="font-mono" dateTime={usage.checkedAt} title={formatDateTime(usage.checkedAt)}>{formatDateTime(usage.checkedAt, { includeYear: false })}</time>{usage.planType ? ` · ${usage.planType}` : ""}</p>
        </div>
      )}
    </section>
  );
}
