import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { toolsApi } from "@/api/tools";
import { useNavigate } from "@/lib/router";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import type { ToolConnection } from "@paperclipai/shared";
import { aiMethodLabel } from "./model";

export function ManagedAiConnectionRow({
  connection,
}: {
  connection: ToolConnection;
}) {
  const metadata = connection.config?.ai as
    | {
        provider: "anthropic" | "openai" | "openrouter" | "xai";
        method: "subscription" | "api_key";
      }
    | undefined;
  if (!metadata) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {aiMethodLabel(metadata.provider, metadata.method)} ·{" "}
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
  const accounts = useQuery({
    queryKey: ["ai-connections", connection.companyId],
    queryFn: () => aiConnectionsApi.list(connection.companyId),
  });
  const grants = useQuery({
    queryKey: ["ai-connection-grants", connection.id],
    queryFn: () => toolsApi.listConnectionGrants(connection.id),
  });
  const refresh = () => client.invalidateQueries();
  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      aiConnectionsApi.setDefault(connection.companyId, id),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      toolsApi.revokeConnectionGrant(connection.id, id),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (id: string) => heartbeatsApi.cancel(id),
    onSuccess: refresh,
  });
  const account = accounts.data?.connections.find(
    (a) => a.id === connection.id,
  );
  const grant = grants.data?.grants.find((g) => g.id === account?.grantId);
  const error =
    accounts.error ??
    grants.error ??
    makeDefault.error ??
    stop.error;
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  if (!account || !grant)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {accounts.isPending || grants.isPending
          ? "Loading AI account…"
          : "This account is not available to you."}
      </p>
    );
  return (
    <div className="space-y-4">
      <AiConnectionAccountControls
        account={account}
        grant={grant}
        currentUserId={accounts.data!.currentUserId}
        onMakeDefault={() => makeDefault.mutate(grant.id)}
        onRevoke={() => revoke.mutateAsync(grant.id).then(() => undefined)}
        revocationDetails={
          <div className="space-y-2">
            {runs.error && (
              <p role="alert">
                Could not load active runs. Retry before revoking.
              </p>
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

    </div>
  );
}
