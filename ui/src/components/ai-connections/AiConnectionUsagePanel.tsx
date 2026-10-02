import { useMutation } from "@tanstack/react-query";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { supportsAiConnectionUsage } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { QuotaBar } from "@/components/QuotaBar";
import { formatDateTime, formatNumber } from "@/lib/utils";

const usageNumber = (value: number) => formatNumber(value, { maximumFractionDigits: 20 });

export function AiConnectionUsagePanel({ account }: { account: AiManagedConnectionSummary }) {
  const probe = useMutation({
    mutationFn: () => aiConnectionsApi.probeUsage(account.companyId, account.id, account.grantId),
  });
  const supported = supportsAiConnectionUsage(account.provider, account.method);
  const usage = probe.isSuccess ? probe.data : undefined;
  return (
    <section aria-label="Account usage limits" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Usage limits</h3>
          <p className="text-xs text-muted-foreground">
            {supported ? "Check this account’s limits and remaining allowance." : "Usage limits are unavailable through this sign-in method."}
          </p>
        </div>
        {supported && <Button variant="outline" size="sm" disabled={probe.isPending || account.status !== "connected"} onClick={() => probe.mutate()}>
          {probe.isPending ? "Checking usage…" : "Check usage"}
        </Button>}
      </div>
      {probe.error && <p role="alert" className="text-sm text-destructive">{probe.error.message}</p>}
      {usage && usage.status !== "ok" && <p role={usage.status === "unsupported" ? "status" : "alert"} className="text-sm text-muted-foreground">{usage.message}</p>}
      {usage?.status === "ok" && (
        <div className="space-y-3" aria-live="polite">
          <p className="text-xs text-muted-foreground">Checked <span className="font-mono">{formatDateTime(usage.checkedAt)}</span>{usage.planType ? ` · ${usage.planType}` : ""}</p>
          {usage.limits.map((window) => (
            <div key={window.id} className="space-y-1.5">
              {window.usedPercent != null ? <QuotaBar label={window.label} percentUsed={window.usedPercent}
                leftLabel={`${usageNumber(window.usedPercent)}% used`} rightLabel={`${usageNumber(window.remainingPercent!)}% remaining`} />
                : <p className="text-sm">{window.label} · {window.used != null ? `${usageNumber(window.used)} used` : "Usage not reported"}</p>}
              <p className="text-xs text-muted-foreground">
                {window.limitReached === true ? "Limit reached. " : ""}
                {window.allowed === true ? "Provider allows usage. " : window.allowed === false ? "Provider denies usage. " : ""}
                {window.windowDurationSeconds != null ? `${usageNumber(window.windowDurationSeconds / 3600)} hour window. ` : ""}
                {window.resetInterval ? `Resets ${window.resetInterval}. ` : ""}
                {window.limit != null ? `${usageNumber(window.limit)} ${window.unit ?? "units"} limit. ` : ""}
                {window.remaining != null ? `${usageNumber(window.remaining)} ${window.unit ?? "units"} remaining. ` : ""}
                {window.resetsAt ? `Resets ${formatDateTime(window.resetsAt)}.` : "Reset time not reported."}
              </p>
            </div>
          ))}
          {usage.overage && <div className="space-y-1.5 text-sm">
            <p>Overage · {usage.overage.enabled === true ? "Enabled" : usage.overage.enabled === false ? "Disabled" : "Status not reported"}</p>
            <p className="text-xs text-muted-foreground">
              {usage.overage.unlimited === true ? "Unlimited credits. " : ""}
              {usage.overage.balance != null ? `${usageNumber(usage.overage.balance)} ${usage.overage.unit ?? "units"} balance. ` : ""}
              {usage.overage.remaining != null ? `${usageNumber(usage.overage.remaining)} ${usage.overage.unit ?? "units"} allowance remaining. ` : ""}
              {usage.overage.available === true ? "Overage is available." : usage.overage.available === false ? "Overage is unavailable." : "Provider has not confirmed overage availability."}
            </p>
          </div>}
        </div>
      )}
    </section>
  );
}
