import { useTranslation, t, t as translate } from "@/i18n";
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
  // Matching uses canonical English, never a localized discriminator.
  const canonicalLabel = window.label.replace(/\b(\d+(?:\.\d+)?) hour limit\b/i, "$1h").replace(/\bweekly limit\b/i, "Weekly");
  const label = window.label.replace(/\b(\d+(?:\.\d+)?) hour limit\b/i, (_match, hours: string) => t("final-components-b:hours_h_31a273", { hours })).replace(/\bweekly limit\b/i, translate("connections:weekly_158f3da"));
  if (window.windowDurationSeconds == null) return label;
  const hours = window.windowDurationSeconds / 3600;
  const canonicalPeriod = hours === 168 ? "Weekly" : `${usageNumber(hours)}h`;
  const period = hours === 168 ? translate("connections:weekly_158f3da") : t("final-components-b:hours_h_31a273", { hours: usageNumber(hours) });
  if (/\b(?:Primary|Secondary)$/.test(canonicalLabel)) return `${label} · ${period}`;
  if ((hours === 168 && /weekly/i.test(canonicalLabel)) || canonicalLabel.split(/[\s·()]+/).includes(canonicalPeriod)) return label;
  return `${label} · ${period}`;
}

function limitValue(window: AiConnectionUsageLimit) {
  if (window.used === 0 && window.limit === 0) return translate("connections:cap_1c6fa5f", { amount: amount(window.limit, window.unit) });
  if (window.used != null && window.limit != null) return translate("connections:used_77f0f48", { amount: amount(window.used, window.unit), amount2: amount(window.limit, window.unit) });
  if (window.usedPercent != null) return translate("connections:used_ee6739e", { value: usageNumber(window.usedPercent) });
  if (window.used != null) return translate("connections:used_56932c7", { amount: amount(window.used, window.unit) });
  if (window.remainingPercent != null) return translate("connections:left_535e2c9", { value: usageNumber(window.remainingPercent) });
  return translate("connections:not_reported_98e8568");
}

function limitDetails(window: AiConnectionUsageLimit) {
  const details: string[] = [];
  if (window.allowed === false) details.push(translate("connections:blocked_99613c7"));
  else if (window.limitReached === true) details.push(translate("connections:limit_reached_068bb7b"));
  if (window.allowed === true && (window.limitReached === true || window.usedPercent == null)) details.push(translate("connections:usage_allowed_1969ef6"));
  if (window.used == null || window.limit == null) {
    if (window.remaining != null) details.push(translate("connections:left_7714948", { amount: amount(window.remaining, window.unit) }));
    if (window.limit != null) details.push(translate("connections:cap_1c6fa5f", { amount: amount(window.limit, window.unit) }));
  }
  if (window.resetsAt) details.push(translate("connections:resets_e662092", { formatDateTime: formatDateTime(window.resetsAt, { includeYear: false }) }));
  else if (window.resetInterval) details.push(translate("connections:resets_27fb7d8", { resetInterval: window.resetInterval }));
  return details.join(" · ");
}

function overageSummary(usage: AiConnectionUsage) {
  const overage = usage.overage!;
  const details = [overage.available === true ? translate("connections:available_7c62a14")
    : overage.enabled === false ? translate("connections:off_e3de5ab")
    : overage.available === false ? (overage.enabled === true ? translate("connections:on_unavailable_82bc896") : translate("connections:unavailable_2c9c1f7"))
    : overage.enabled === true ? translate("connections:on_availability_unknown_5141182") : translate("connections:not_reported_98e8568")];
  if (overage.unlimited === true) details.push(translate("connections:unlimited_b8bef37"));
  else if (overage.balance != null && (overage.balance !== 0 || overage.enabled !== false)) details.push(amount(overage.balance, overage.unit));
  if (overage.remaining != null && (overage.remaining !== 0 || overage.enabled !== false)
    && !usage.limits.some((window) => window.scope === "overage" && window.remaining === overage.remaining && window.unit === overage.unit)) {
    details.push(translate("connections:left_7714948", { amount: amount(overage.remaining, overage.unit) }));
  }
  return details.join(" · ");
}

function usageError(usage: AiConnectionUsage) {
  switch (usage.errorCode) {
    case "authentication_required": return translate("connections:sign_in_again_to_check_usage_decfed6");
    case "permission_denied": return translate("connections:usage_access_denied_fa90c0f");
    case "rate_limited": return translate("connections:too_many_checks_try_again_later_ee3e94a");
    case "provider_unavailable": return translate("connections:provider_unavailable_try_again_b0a4de0");
    case "invalid_response": return translate("connections:couldn_t_read_usage_try_again_0293896");
    case "connection_unavailable": return translate("connections:reconnect_to_check_usage_c8a754f");
    case "unsupported": return translate("connections:usage_unavailable_b6ab3d9");
    default: return usage.message ?? translate("connections:usage_unavailable_b6ab3d9");
  }
}

export function AiConnectionUsagePanel({ account, observation, cachedOnly = false }: { account: AiManagedConnectionSummary; observation?: AiConnectionUsage; cachedOnly?: boolean }) {
  const { t } = useTranslation("connections");
  const probe = useMutation({
    mutationFn: () => aiConnectionsApi.probeUsage(account.companyId, account.id, account.grantId),
  });
  const supported = supportsAiConnectionUsage(account.provider, account.method);
  const usage = cachedOnly ? observation : probe.isSuccess ? probe.data : undefined;
  return (
    <section aria-label={t("account_usage_limits_31ed495")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("usage_0bb1864")}</h3>
        {supported && !cachedOnly && <Button variant="outline" size="sm" disabled={probe.isPending || account.status !== "connected"} onClick={() => probe.mutate()}>
          {probe.isPending ? t("checking_820d600") : usage?.status === "ok" ? t("refresh_56e3bad") : t("check_usage_84f4200")}
        </Button>}
      </div>
      {cachedOnly && !usage && <p className="text-xs text-muted-foreground">{t("usage_not_observed_995364c")}</p>}
      {!supported && <p className="text-xs text-muted-foreground">{t("unavailable_for_this_sign_in_method_0492531")}</p>}
      {probe.error && <p role="alert" className="text-sm text-destructive">{describeError(probe.error).body}</p>}
      {usage && usage.status !== "ok" && <p role={usage.status === "unsupported" ? "status" : "alert"} className="text-sm text-muted-foreground">{usageError(usage)}</p>}
      {usage?.status === "ok" && (
        <div className="space-y-3" aria-live="polite">
          {usage.limits.length === 0 && <p className="text-xs text-muted-foreground">{t("usage_not_reported_9566e22")}</p>}
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
            <span className="text-muted-foreground">{t("overage_317c3a7")}</span>
            <span className="font-mono">{overageSummary(usage)}</span>
          </div>}
          <p className="text-xs text-muted-foreground">{t("updated_c95815a")}<time className="font-mono" dateTime={usage.checkedAt} title={formatDateTime(usage.checkedAt)}>{formatDateTime(usage.checkedAt, { includeYear: false })}</time>{usage.planType ? ` · ${usage.planType}` : ""}</p>
        </div>
      )}
    </section>
  );
}
