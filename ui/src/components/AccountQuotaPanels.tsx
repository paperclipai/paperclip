import { t, useTranslation } from "@/i18n";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { formatDateTime, formatNumber } from "../lib/utils";
import { QuotaBar } from "./QuotaBar";
import { quotaUnavailableMessage } from "../lib/quota-refresh";
import { quotaWindowLabel as claudeQuotaWindowLabel, quotaValueLabel as claudeQuotaValueLabel } from "./ClaudeSubscriptionPanel";
import { quotaWindowLabel as codexQuotaWindowLabel, quotaValueLabel as codexQuotaValueLabel } from "./CodexSubscriptionPanel";

function accountQuotaWindowLabel(provider: string, label: string): string {
  return provider === "anthropic" ? claudeQuotaWindowLabel(label)
    : provider === "openai" ? codexQuotaWindowLabel(label) : label;
}

function accountQuotaValueLabel(provider: string, window: ProviderQuotaResult["windows"][number]) {
  return provider === "anthropic" ? claudeQuotaValueLabel(window)
    : provider === "openai" ? codexQuotaValueLabel(window) : window.valueLabel;
}

export function AccountQuotaPanels({
  accounts,
  failed,
}: {
  accounts: ProviderQuotaResult[];
  failed?: boolean;
}) {
  useTranslation();
  return (
    <div className="space-y-4">
      {accounts.map((account) => (
        <section
          className="space-y-2"
          key={account.accountKey ?? account.provider}
        >
          <p className="text-sm font-medium">
            {account.accountLabel ?? t("oct19Core.coverage001")}
          </p>
          {(failed || !account.ok) && (
            <p className="text-sm text-muted-foreground">
              {account.errorFamily === "credentials_unavailable"
                ? t("oct19Core.coverage002")
                : quotaUnavailableMessage(account.windows.length > 0)}
            </p>
          )}
          {account.windows.map((window, index) => window.usedPercent == null ? (
            <div key={`${window.label}:${index}`} className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <span>{accountQuotaWindowLabel(account.provider, window.label)}</span>
                <span className="font-mono text-muted-foreground">{accountQuotaValueLabel(account.provider, window) ?? t("oct19Core.coverage003")}</span>
              </div>
              {window.resetsAt && <p className="text-xs font-mono text-muted-foreground">{t("oct19Core.quotaResets", { time: formatDateTime(window.resetsAt) })}</p>}
            </div>
          ) : (
            <QuotaBar
              key={`${window.label}:${index}`}
              className="font-mono"
              label={accountQuotaWindowLabel(account.provider, window.label)}
              percentUsed={window.usedPercent}
              leftLabel={
                accountQuotaValueLabel(account.provider, window) ??
                (window.usedPercent === null
                  ? t("oct19Core.coverage003")
                  : t("oct19Core.quotaPercentUsed", { percent: formatNumber(window.usedPercent) }))
              }
              rightLabel={
                window.resetsAt
                  ? t("oct19Core.quotaResets", { time: formatDateTime(window.resetsAt) })
                  : undefined
              }
            />
          ))}
          {account.capturedAt && (
            <p className="text-xs font-mono text-muted-foreground">
              {t("oct19Core.quotaLastChecked", { time: formatDateTime(account.capturedAt) })}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
