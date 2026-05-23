import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { connectorsApi, type AgentConnector, type ConnectorProvider } from "../api/connectors";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Briefcase,
  Calendar,
  CheckCircle2,
  FileText,
  Github,
  Mail,
  MessageSquare,
  Plus,
  Radio,
  Search,
  Shield,
  GitBranch,
  Trash2,
  Video,
  Wifi,
  XCircle,
  Loader2,
  Circle,
} from "lucide-react";

/**
 * Mapping of provider IDs to their Lucide icons
 */
const providerIcons: Record<string, typeof Mail> = {
  google_workspace: Mail,
  microsoft_365: Calendar,
  slack: MessageSquare,
  github: Github,
  notion: FileText,
  jira: GitBranch,
  linear: Circle,
  hubspot: Briefcase,
  youtube: Video,
  twitter: Radio,
};

function statusBadge(status: AgentConnector["status"]) {
  switch (status) {
    case "connected":
      return <Badge variant="default" className="bg-green-500 hover:bg-green-600">Connected</Badge>;
    case "pending":
      return <Badge variant="outline">Pending</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    case "revoked":
      return <Badge variant="secondary">Revoked</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface AgentConnectorsTabProps {
  agentId: string;
  companyId: string;
}

export function AgentConnectorsTab({ agentId, companyId }: AgentConnectorsTabProps) {
  const queryClient = useQueryClient();

  const { data: connectors, isLoading } = useQuery({
    queryKey: queryKeys.agents.connectors(agentId),
    queryFn: () => connectorsApi.list(agentId),
  });

  const { data: providers } = useQuery({
    queryKey: ["connectors", "providers"],
    queryFn: () => connectorsApi.providers(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const createMutation = useMutation({
    mutationFn: (provider: string) => connectorsApi.create(agentId, provider),
    onSuccess: (data) => {
      // Redirect to OAuth auth URL
      window.location.href = data.authUrl;
    },
    onError: (err: Error) => {
      console.error("Failed to initiate OAuth:", err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (connectorId: string) => connectorsApi.delete(agentId, connectorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.connectors(agentId) });
    },
    onError: (err: Error) => {
      console.error("Failed to remove connector:", err);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (connectorId: string) => connectorsApi.revoke(agentId, connectorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.connectors(agentId) });
    },
    onError: (err: Error) => {
      console.error("Failed to revoke connector:", err);
    },
  });

  // Filter out already-connected providers
  const connectedProviders = new Set(connectors?.map((c) => c.provider) ?? []);
  const availableProviders = providers?.filter((p) => !connectedProviders.has(p.id)) ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connected Connectors */}
      {connectors && connectors.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Connected Accounts</h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connectors.map((connector) => {
              const Icon = providerIcons[connector.provider] ?? Wifi;
              return (
                <Card key={connector.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg border p-2">
                          <Icon className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div>
                          <CardTitle className="text-base">
                            {providers?.find((p) => p.id === connector.provider)?.name ?? connector.provider}
                          </CardTitle>
                          {connector.displayName && (
                            <CardDescription className="text-xs">{connector.displayName}</CardDescription>
                          )}
                        </div>
                      </div>
                      {statusBadge(connector.status)}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {connector.errorMessage && (
                      <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                        {connector.errorMessage}
                      </div>
                    )}
                    {connector.scopes && connector.scopes.length > 0 && (
                      <div>
                        <div className="mb-1.5 text-xs font-medium text-muted-foreground">Granted scopes</div>
                        <div className="flex flex-wrap gap-1">
                          {connector.scopes.slice(0, 4).map((scope) => (
                            <Badge key={scope} variant="outline" className="text-xs">
                              {scope}
                            </Badge>
                          ))}
                          {connector.scopes.length > 4 && (
                            <Badge variant="outline" className="text-xs">
                              +{connector.scopes.length - 4} more
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        disabled={connector.status !== "connected"}
                      >
                        {connector.status === "connected" ? "Test" : "Reconnect"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => deleteMutation.mutate(connector.id)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Available Connectors */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Available Connectors</h3>
        <p className="text-sm text-muted-foreground">
          Connect external services to enable your agent to interact with them via MCP
        </p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {availableProviders.map((provider) => {
            const Icon = providerIcons[provider.id] ?? Wifi;
            return (
              <Card key={provider.id} className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg border p-2">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{provider.name}</CardTitle>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1">
                    {provider.scopes.slice(0, 3).map((scope) => (
                      <Badge key={scope} variant="outline" className="text-xs">
                        {scope}
                      </Badge>
                    ))}
                    {provider.scopes.length > 3 && (
                      <Badge variant="outline" className="text-xs">
                        +{provider.scopes.length - 3}
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => createMutation.mutate(provider.id)}
                    disabled={createMutation.isPending}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Connect
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Empty state */}
      {!connectors?.length && !availableProviders.length && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Wifi className="mb-4 h-12 w-12 text-muted-foreground" />
          <h3 className="text-lg font-semibold">No connectors available</h3>
          <p className="text-sm text-muted-foreground">
            Check back later as we add more OAuth integrations
          </p>
        </div>
      )}
    </div>
  );
}
