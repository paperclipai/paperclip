import type { ProviderQuotaResult } from "@paperclipai/shared";
import { QuotaBar } from "./QuotaBar";
import { quotaUnavailableMessage } from "../lib/quota-refresh";

export function AccountQuotaPanels({
  accounts,
  failed,
}: {
  accounts: ProviderQuotaResult[];
  failed?: boolean;
}) {
  return (
    <div className="space-y-4">
      {accounts.map((account) => (
        <section
          className="space-y-2"
          key={account.accountKey ?? account.provider}
        >
          <p className="text-sm font-medium">
            {account.accountLabel ?? "Subscription account"}
          </p>
          {(failed || !account.ok) && (
            <p className="text-sm text-muted-foreground">
              {account.errorFamily === "credentials_unavailable"
                ? "Connect or reconnect a subscription in AI connections to view its quota."
                : quotaUnavailableMessage(account.windows.length > 0)}
            </p>
          )}
          {account.windows.map((window, index) => (
            <QuotaBar
              key={`${window.label}:${index}`}
              label={window.label}
              percentUsed={window.usedPercent ?? 0}
              leftLabel={
                window.valueLabel ??
                (window.usedPercent === null
                  ? "Usage not reported"
                  : `${window.usedPercent}% used`)
              }
              rightLabel={
                window.resetsAt
                  ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                  : undefined
              }
            />
          ))}
          {account.capturedAt && (
            <p className="text-xs text-muted-foreground">
              Last checked {new Date(account.capturedAt).toLocaleString()}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
