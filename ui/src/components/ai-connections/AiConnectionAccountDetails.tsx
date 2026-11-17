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
  const isChatGpt = account.provider === "openai" && account.method === "subscription" && !account.routing;
  const canLookUp = !account.routing && (account.provider === "anthropic" || isChatGpt) && account.method === "subscription" && account.status === "connected";
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
    <section className="space-y-3" aria-label="Connected account">
      <h3 className="text-sm font-semibold">Connected account</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">{AI_PROVIDERS[account.provider].name} account</dt>
        <dd className="break-words">{accountLabel ?? "Not available"}</dd>
        {(isChatGpt || identity.data?.organizationLabel) && <>
          <dt className="text-muted-foreground">{isChatGpt ? "ChatGPT workspace" : "Organization"}</dt>
          <dd className="break-words">{identity.data?.organizationLabel ?? (identity.isPending && canLookUp ? "Checking…" : "Not available")}</dd>
        </>}
        <dt className="text-muted-foreground">Sign-in method</dt>
        <dd>{aiMethodLabel(account.provider, account.method)}</dd>
        <dt className="text-muted-foreground">Access</dt>
        <dd>{account.ownership === "shared" ? "Company shared" : `Personal · ${account.ownerName ?? "Account owner"}`}</dd>
      </dl>
      {canLookUp && identity.isPending && <p role="status" className="text-xs text-muted-foreground">Checking account details…</p>}
      {message && <p role={retryable ? "alert" : undefined} className="text-xs text-muted-foreground">{message}</p>}
      {retryable && <Button variant="outline" size="sm" disabled={identity.isFetching} onClick={() => void identity.refetch()}>Retry account check</Button>}
    </section>
  );
}
