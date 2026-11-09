import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useNavigate } from "@/lib/router";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import { AiConnectionUsagePanel } from "./AiConnectionUsagePanel";
import { AiConnectionAccountDetails } from "./AiConnectionAccountDetails";
import type { ToolConnection, AiConnectionMetadata } from "@paperclipai/shared";
import { aiMethodLabel } from "./model";
import { queryKeys } from "@/lib/queryKeys";
import { retryTransientOnly } from "@/lib/query-client";
import { useAccountSessionQuery } from "@/api/companies-query";
import { useAiConnectionDefaults } from "./useAiConnectionDefaults";
import { AiDefaultError } from "./AiConnectionDefault";
import { AI_PROVIDERS } from "./model";

export function ManagedAiConnectionRow({
  connection,
}: {
  connection: ToolConnection;
}) {
  const metadata = connection.config?.ai as AiConnectionMetadata | undefined;
  if (!metadata) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {metadata.routing ? metadata.routing.kind === "bedrock" ? `Bedrock · ${metadata.routing.region}` : metadata.routing.kind === "openrouter" ? "OpenRouter" : metadata.routing.baseUrl : aiMethodLabel(metadata.provider, metadata.method)} ·{" "}
      {connection.credentialPolicy === "per_user"
        ? "Personal"
        : "Company shared"}
    </p>
  );
}
export function ManagedAiConnectionDetails({
  connection,
}: {
  connection: ToolConnection;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const runs = useQuery({
    queryKey: ["ai-connection-active-runs", connection.id],
    queryFn: () =>
      aiConnectionsApi.activeRuns(connection.companyId, connection.id),
  });
  const session = useAccountSessionQuery();
  const defaults = useAiConnectionDefaults(connection.companyId, {
    userId: session.data?.user.id ?? null,
    settled: session.isSuccess,
  });
  const accounts = defaults.accounts;
  const grants = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connection.id),
    queryFn: ({ signal }) => toolsApi.listConnectionGrants(connection.id, { signal }),
    retry: retryTransientOnly(1),
  });
  const runsView = useQueryView(runs);
  const sessionView = useQueryView(session);
  const accountsView = useQueryView(accounts);
  const grantsView = useQueryView(grants);
  const refresh = () => client.invalidateQueries();
  const revoke = useMutation({
    mutationFn: (id: string) =>
      toolsApi.revokeConnectionGrant(connection.id, id),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (id: string) => heartbeatsApi.cancel(id),
    onSuccess: refresh,
  });
  const visibleGrants = new Set(grants.data?.grants.map(grant => grant.id));
  const candidates = defaults.data?.connections.filter(account => account.id === connection.id && account.companyId === connection.companyId && visibleGrants.has(account.grantId)) ?? [];
  // Routed personal accounts also need details; default eligibility excludes them.
  const ownPersonal = (account: (typeof candidates)[number]) => account.ownership === "personal" && account.ownerUserId === defaults.data?.currentUserId;
  const account = candidates.find(account => ownPersonal(account) && account.isDefault)
    ?? candidates.find(ownPersonal) ?? candidates[0];
  const grant = grants.data?.grants.find((g) => g.id === account?.grantId);
  const loadError = [sessionView, accountsView, grantsView].find((view) => view.kind === "error")?.error;
  const error = stop.error;
  const loadFailure = loadError ? (
    <div role="alert" className="space-y-2">
      <p className="text-sm text-destructive">{describeError(loadError).body}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={sessionView.isFetching || accounts.isFetching || grants.isFetching}
        onClick={() => {
          if (sessionView.kind === "error") {
            sessionView.retry();
            return;
          }
          if (accounts.error) void accounts.refetch();
          if (grants.error) void grants.refetch();
        }}
      >
        Retry
      </Button>
    </div>
  ) : null;
  if ((!account || !grant) && loadFailure) return loadFailure;
  if (!account || !grant)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {accounts.isPending || grants.isPending || sessionView.kind === "reconnecting" || accountsView.kind === "reconnecting" || grantsView.kind === "reconnecting"
          ? "Loading AI account…"
          : "This account is not available to you."}
      </p>
    );
  return (
    <div className="space-y-4">
      {loadFailure}
      {error && <p role="alert" className="text-sm text-destructive">{describeError(error).body}</p>}
      {defaults.error && defaults.failedProvider && <AiDefaultError provider={AI_PROVIDERS[defaults.failedProvider].name}
        pending={defaults.pending(defaults.failedProvider)} onRetry={defaults.retry} />}
      <AiConnectionAccountDetails account={account} grant={grant} />
      {account.routing && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Provider settings</summary><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">Destination</dt><dd className="break-all">{account.routing.baseUrl ?? (account.routing.kind === "bedrock" ? account.routing.region : "OpenRouter")}</dd><dt className="text-muted-foreground">API format</dt><dd>{account.routing.kind === "openrouter" ? "Selected by harness" : account.routing.protocol}</dd><dt className="text-muted-foreground">Authentication</dt><dd>{account.routing.auth}</dd><dt className="text-muted-foreground">Models</dt><dd>{account.routing.models.map(m => m.label ?? m.id).join(", ") || "Enter a model ID on the agent"}</dd></dl></details>}
      <AiConnectionAccountControls
        account={account}
        grant={grant}
        currentUserId={accounts.data!.currentUserId}
        defaultPending={defaults.pending(account.provider)}
        onMakeDefault={() => defaults.choose(account)}
        onRevoke={() => revoke.mutateAsync(grant.id).then(() => undefined)}
        revocationDetails={
          <div className="space-y-2">
            {runsView.kind === "error" && (
              <QueryErrorState
                size="inline"
                error={runs.error}
                action="load active runs"
                onRetry={runsView.retry}
                retrying={runsView.isFetching}
              />
            )}
            {runs.data?.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span>
                  {run.agentName} · {run.status}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate(run.id)}
                >
                  Stop run
                </Button>
              </div>
            ))}
          </div>
        }
        onReconnect={() =>
          navigate(
            `/apps/connect?source=${account.provider}&reconnect=${connection.id}&method=ai-${account.method}`,
          )
        }
      />
      <AiConnectionUsagePanel key={`${account.id}:${account.grantId}:${account.status}`} account={account} />
    </div>
  );
}
