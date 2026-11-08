import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import type { AiManagedConnectionSummary, ConnectionGrant } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { retryTransientOnly } from "@/lib/query-client";
import { Button } from "@/components/ui/button";
import { AI_PROVIDERS, aiMethodLabel } from "./model";

/** Provider profile loading is independent of account access and maintenance controls. */
export function AiConnectionAccountDetails({ account, grant }: {
  account: AiManagedConnectionSummary;
  grant: ConnectionGrant;
}) {
  const { t } = useTranslation("connections");
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
    <section className="space-y-3" aria-label={t("connected_account_a86f2ef")}>
      <h3 className="text-sm font-semibold">{t("connected_account_a86f2ef")}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">{t("final-components-a:providerAccount_8e0d964c", { provider: AI_PROVIDERS[account.provider].name })}</dt>
        <dd className="break-words">{accountLabel ?? t("not_available_d1a17af")}</dd>
        {identity.data?.organizationLabel && <>
          <dt className="text-muted-foreground">{t("organization_519255a")}</dt>
          <dd className="break-words">{identity.data.organizationLabel}</dd>
        </>}
        <dt className="text-muted-foreground">{t("sign_in_method_764b4b3")}</dt>
        <dd>{aiMethodLabel(account.provider, account.method)}</dd>
        <dt className="text-muted-foreground">{t("access_2f81a22")}</dt>
        <dd>{account.ownership === "shared" ? t("company_shared_62c7551") : t("personal_6cd45bd", { value: account.ownerName ?? t("account_owner_75b7703") })}</dd>
      </dl>
      {canLookUp && identity.isPending && <p role="status" className="text-xs text-muted-foreground">{t("checking_account_details_db18b59")}</p>}
      {message && <p role={retryable ? "alert" : undefined} className="text-xs text-muted-foreground">{message}</p>}
      {retryable && <Button variant="outline" size="sm" disabled={identity.isFetching} onClick={() => void identity.refetch()}>{t("retry_account_check_ec7ab65")}</Button>}
    </section>
  );
}
