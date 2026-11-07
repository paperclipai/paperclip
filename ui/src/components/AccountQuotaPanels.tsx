import { t, useTranslation, Trans } from "@/i18n";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { formatDateTime } from "../lib/utils";
import { QuotaBar } from "./QuotaBar";
import { quotaUnavailableMessage } from "../lib/quota-refresh";

export function AccountQuotaPanels({
  accounts,
  failed,
}: {
  accounts: ProviderQuotaResult[];
  failed?: boolean;
}) {
  useTranslation("task-components");
  return (
    <div className="space-y-4">
      {accounts.map((account) => (
        <section
          className="space-y-2"
          key={account.accountKey ?? account.provider}
        >
          <p className="text-sm font-medium">
            {account.accountLabel ?? t("task-components:subscriptionAccount_b9e6c304")}
          </p>
          {(failed || !account.ok) && (
            <p className="text-sm text-muted-foreground">
              {account.errorFamily === "credentials_unavailable"
                ? t("task-components:connectOrReconnectASubscriptionInAi_820f9250")
                : quotaUnavailableMessage(account.windows.length > 0)}
            </p>
          )}
          {account.windows.map((window, index) => window.usedPercent == null ? (
            <div key={`${window.label}:${index}`} className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <span>{window.label}</span>
                <span className="font-mono text-muted-foreground">{window.valueLabel ?? t("task-components:usageNotReported_714f5513")}</span>
              </div>
              {window.resetsAt && <p className="text-xs font-mono text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_c1160fbf6bbc" components={{ part1: <>{formatDateTime(window.resetsAt)}</> }} /></p>}
            </div>
          ) : (
            <QuotaBar
              key={`${window.label}:${index}`}
              className="font-mono"
              label={window.label}
              percentUsed={window.usedPercent}
              leftLabel={
                window.valueLabel ??
                (window.usedPercent === null
                  ? t("deep-ui:usage_not_reported_714f55")
                  : t("deep-ui:quota_used", { percent: window.usedPercent }))
              }
              rightLabel={
                window.resetsAt
                  ? t("deep-ui:quota_resets", { date: formatDateTime(window.resetsAt) })
                  : undefined
              }
            />
          ))}
          {account.capturedAt && (
            <p className="text-xs font-mono text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_ee5fbadbf54b" components={{ part1: <>{formatDateTime(account.capturedAt)}</> }} /></p>
          )}
        </section>
      ))}
    </div>
  );
}
