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
          {account.windows.map((window, index) => window.usedPercent == null ? (
            <div key={`${window.label}:${index}`} className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <span>{window.label}</span>
                <span className="font-mono text-muted-foreground">{window.valueLabel ?? "Usage not reported"}</span>
              </div>
              {window.resetsAt && <p className="text-xs font-mono text-muted-foreground">Resets {formatDateTime(window.resetsAt)}</p>}
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
                  ? "Usage not reported"
                  : `${window.usedPercent}% used`)
              }
              rightLabel={
                window.resetsAt
                  ? `Resets ${formatDateTime(window.resetsAt)}`
                  : undefined
              }
            />
          ))}
          {account.capturedAt && (
            <p className="text-xs font-mono text-muted-foreground">
              Last checked {formatDateTime(account.capturedAt)}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
