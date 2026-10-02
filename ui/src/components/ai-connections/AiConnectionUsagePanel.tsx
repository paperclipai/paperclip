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
  if (window.used === 0 && window.limit === 0) return `${amount(window.limit, window.unit)} cap`;
  if (window.used != null && window.limit != null) return `${amount(window.used, window.unit)} / ${amount(window.limit, window.unit)} used`;
  if (window.usedPercent != null) return `${usageNumber(window.usedPercent)}% used`;
  if (window.used != null) return `${amount(window.used, window.unit)} used`;
  if (window.remainingPercent != null) return `${usageNumber(window.remainingPercent)}% left`;
  return "Not reported";
}

function limitDetails(window: AiConnectionUsageLimit) {
  const details: string[] = [];
  if (window.allowed === false) details.push("Blocked");
  else if (window.limitReached === true) details.push("Limit reached");
  if (window.allowed === true && (window.limitReached === true || window.usedPercent == null)) details.push("Usage allowed");
  if (window.used == null || window.limit == null) {
    if (window.remaining != null) details.push(`${amount(window.remaining, window.unit)} left`);
    if (window.limit != null) details.push(`${amount(window.limit, window.unit)} cap`);
  }
  if (window.resetsAt) details.push(`Resets ${formatDateTime(window.resetsAt, { includeYear: false })}`);
  else if (window.resetInterval) details.push(`Resets ${window.resetInterval}`);
  return details.join(" · ");
}

function overageSummary(usage: AiConnectionUsage) {
  const overage = usage.overage!;
  const details = [overage.available === true ? "Available"
    : overage.enabled === false ? "Off"
    : overage.available === false ? (overage.enabled === true ? "On · Unavailable" : "Unavailable")
    : overage.enabled === true ? "On · Availability unknown" : "Not reported"];
  if (overage.unlimited === true) details.push("Unlimited");
  else if (overage.balance != null && (overage.balance !== 0 || overage.enabled !== false)) details.push(amount(overage.balance, overage.unit));
  if (overage.remaining != null && (overage.remaining !== 0 || overage.enabled !== false)
    && !usage.limits.some((window) => window.scope === "overage" && window.remaining === overage.remaining && window.unit === overage.unit)) {
    details.push(`${amount(overage.remaining, overage.unit)} left`);
  }
  return details.join(" · ");
}

function usageError(usage: AiConnectionUsage) {
  switch (usage.errorCode) {
    case "authentication_required": return "Sign in again to check usage.";
    case "permission_denied": return "Usage access denied.";
    case "rate_limited": return "Too many checks. Try again later.";
    case "provider_unavailable": return "Provider unavailable. Try again.";
    case "invalid_response": return "Couldn’t read usage. Try again.";
    case "connection_unavailable": return "Reconnect to check usage.";
    case "unsupported": return "Usage unavailable.";
    default: return usage.message;
  }
}

export function AiConnectionUsagePanel({ account }: { account: AiManagedConnectionSummary }) {
  const probe = useMutation({
    mutationFn: () => aiConnectionsApi.probeUsage(account.companyId, account.id, account.grantId),
  });
  const supported = supportsAiConnectionUsage(account.provider, account.method);
  const usage = probe.isSuccess ? probe.data : undefined;
  return (
    <section aria-label="Account usage limits" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Usage</h3>
        {supported && <Button variant="outline" size="sm" disabled={probe.isPending || account.status !== "connected"} onClick={() => probe.mutate()}>
          {probe.isPending ? "Checking…" : usage?.status === "ok" ? "Refresh" : "Check usage"}
        </Button>}
      </div>
      {!supported && <p className="text-xs text-muted-foreground">Unavailable for this sign-in method.</p>}
      {probe.error && <p role="alert" className="text-sm text-destructive">{probe.error.message}</p>}
      {usage && usage.status !== "ok" && <p role={usage.status === "unsupported" ? "status" : "alert"} className="text-sm text-muted-foreground">{usageError(usage)}</p>}
      {usage?.status === "ok" && (
        <div className="space-y-3" aria-live="polite">
          {usage.limits.length === 0 && <p className="text-xs text-muted-foreground">Usage not reported.</p>}
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
            <span className="text-muted-foreground">Overage</span>
            <span className="font-mono">{overageSummary(usage)}</span>
          </div>}
          <p className="text-xs text-muted-foreground">Updated <time className="font-mono" dateTime={usage.checkedAt} title={formatDateTime(usage.checkedAt)}>{formatDateTime(usage.checkedAt, { includeYear: false })}</time>{usage.planType ? ` · ${usage.planType}` : ""}</p>
        </div>
      )}
    </section>
  );
}
