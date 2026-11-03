import { useQuery } from "@tanstack/react-query";
import type { AiManagedConnectionSummary, ConnectionGrant } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { retryTransientOnly } from "@/lib/query-client";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { AI_PROVIDERS, aiMethodLabel } from "./model";

const accountIdentityNotices = new Map([
  ["unsupported", { message: "Account details are not available for this sign-in method.", key: "nov03AccountIdentity.notice.unsupported" }],
  ["connection_unavailable", { message: "Reconnect or enable this connection to check its account details.", key: "nov03AccountIdentity.notice.connection_unavailable" }],
  ["authentication_required", { message: "Reconnect this account to check its account details.", key: "nov03AccountIdentity.notice.authentication_required" }],
  ["permission_denied", { message: "Anthropic did not permit this connection to read the account email.", key: "nov03AccountIdentity.notice.permission_denied" }],
  ["rate_limited", { message: "Anthropic limited this account check. Try again later.", key: "nov03AccountIdentity.notice.rate_limited" }],
  ["provider_unavailable", { message: "Could not read the account details. Try again later.", key: "nov03AccountIdentity.notice.provider_unavailable" }],
  ["invalid_response", { message: "Anthropic did not return an account email.", key: "nov03AccountIdentity.notice.invalid_response" }],
]);

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
  const notice = accountIdentityNotices.get(identity.data?.errorCode ?? "");
  const message = identity.error ? describeError(identity.error).body
    : notice && identity.data?.message === notice.message ? t(notice.key) : identity.data?.message;
  const retryable = identity.isError || identity.data?.status === "error";
  return (
    <section className="space-y-3" aria-label={t("localizationApps.connectedAccount676")}>
      <h3 className="text-sm font-semibold">{t("localizationApps.connectedAccount676")}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">{t("nov03AccountIdentity.providerAccount", { provider: AI_PROVIDERS[account.provider].name })}</dt>
        <dd className="break-words">{accountLabel ?? t("pages.apps.connect.gallery.notAvailable")}</dd>
        {identity.data?.organizationLabel && <>
          <dt className="text-muted-foreground">{t("localizationCommonTail.organization")}</dt>
          <dd className="break-words">{identity.data.organizationLabel}</dd>
        </>}
        <dt className="text-muted-foreground">{t("oct5Apps.copy054")}</dt>
        <dd>{aiMethodLabel(account.provider, account.method)}</dd>
        <dt className="text-muted-foreground">{t("sep12Connections.access")}</dt>
        <dd>{account.ownership === "shared" ? t("sep13Connections.companyShared") : t("sep13Connections.personalOwner", { owner: account.ownerName ?? t("sep13Connections.accountOwner") })}</dd>
      </dl>
      {canLookUp && identity.isPending && <p role="status" className="text-xs text-muted-foreground">{t("nov03AccountIdentity.checking")}</p>}
      {message && <p role={retryable ? "alert" : undefined} className="text-xs text-muted-foreground">{message}</p>}
      {retryable && <Button variant="outline" size="sm" disabled={identity.isFetching} onClick={() => void identity.refetch()}>{t("nov03AccountIdentity.retry")}</Button>}
    </section>
  );
}
