import { useQuery } from "@tanstack/react-query";
import type { AiManagedConnectionSummary, ConnectionGrant } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { retryTransientOnly } from "@/lib/query-client";
import { Button } from "@/components/ui/button";
import { AI_PROVIDERS, aiMethodLabel } from "./model";
import { useTranslation } from "@/i18n";

/** Provider profile loading is independent of account access and maintenance controls. */
export function AiConnectionAccountDetails({ account, grant }: {
  account: AiManagedConnectionSummary;
  grant: ConnectionGrant;
}) {
  const { t } = useTranslation();
  const canLookUp = account.provider === "anthropic" && account.method === "subscription" && account.status === "connected";
  const identity = useQuery({
    queryKey: ["ai-account-identity", account.companyId, account.id, grant.id, grant.updatedAt],
    queryFn: ({ signal }) => aiConnectionsApi.accountIdentity(account.companyId, account.id, grant.id, { signal }),
    enabled: canLookUp,
    staleTime: 5 * 60_000,
    retry: retryTransientOnly(0),
  });
  const accountLabel = identity.data?.accountLabel ?? account.accountLabel;
  const message = identity.error ? describeError(identity.error).body : identity.data?.message;
  const retryable = identity.isError || identity.data?.status === "error";
  return (
    <section className="space-y-3" aria-label={t("agents.AiConnectionAccountDetails.connectedAccount")}>
      <h3 className="text-sm font-semibold">{t("agents.AiConnectionAccountDetails.connectedAccount")}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">{t("agents.AiConnectionAccountDetails.providerAccount", { provider: AI_PROVIDERS[account.provider].name })}</dt>
        <dd className="break-words">{accountLabel ?? t("agents.AiConnectionAccountDetails.notAvailable")}</dd>
        {identity.data?.organizationLabel && <>
          <dt className="text-muted-foreground">{t("agents.AiConnectionAccountDetails.organization")}</dt>
          <dd className="break-words">{identity.data.organizationLabel}</dd>
        </>}
        <dt className="text-muted-foreground">{t("agents.AiConnectionAccountDetails.signInMethod")}</dt>
        <dd>{aiMethodLabel(account.provider, account.method)}</dd>
        <dt className="text-muted-foreground">{t("agents.AiConnectionAccountDetails.access")}</dt>
        <dd>{account.ownership === "shared" ? t("agents.AiConnectionAccountDetails.companyShared") : t("agents.AiConnectionAccountDetails.personal", { owner: account.ownerName ?? t("agents.AiConnectionAccountDetails.accountOwner") })}</dd>
      </dl>
      {canLookUp && identity.isPending && <p role="status" className="text-xs text-muted-foreground">{t("agents.AiConnectionAccountDetails.checkingDetails")}</p>}
      {message && <p role={retryable ? "alert" : undefined} className="text-xs text-muted-foreground">{message}</p>}
      {retryable && <Button variant="outline" size="sm" disabled={identity.isFetching} onClick={() => void identity.refetch()}>{t("agents.AiConnectionAccountDetails.retryCheck")}</Button>}
    </section>
  );
}
