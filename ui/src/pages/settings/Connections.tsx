import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, AlertCircle } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Card } from "@/components/ui/card";
import { ConnectionDrawer } from "./connections/ConnectionDrawer";
import { ProviderTile } from "./connections/ProviderTile";
import {
  disconnectConnection,
  listConnections,
  listProviders,
  refreshConnection,
  startConnect,
  type ConnectionSummary,
  type ProviderSummary,
} from "./connections/api";
import { connectionsStrings as t } from "./connections/strings";

const PROVIDERS_QUERY_KEY = (companyId: string) => ["oauth", "providers", companyId] as const;
const CONNECTIONS_QUERY_KEY = (companyId: string) => ["oauth", "connections", companyId] as const;

export function Connections() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawerId, setDrawerId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Connections" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  // Determine the caller's role so non-admins see the read-only view.
  // We mirror CompanyAccess and use accessApi.listMembers — it returns
  // `access.currentUserRole`. A null/viewer/operator role is treated as
  // "member" for the connect/manage gates.
  const accessQuery = useQuery({
    queryKey: ["access", "current-role", selectedCompanyId ?? ""],
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const role: "admin" | "member" =
    accessQuery.data?.access.currentUserRole === "owner" ||
    accessQuery.data?.access.currentUserRole === "admin"
      ? "admin"
      : "member";

  const providersQuery = useQuery({
    queryKey: PROVIDERS_QUERY_KEY(selectedCompanyId ?? ""),
    queryFn: () => listProviders(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY(selectedCompanyId ?? ""),
    queryFn: () => listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const refreshMutation = useMutation({
    mutationFn: (connectionId: string) => refreshConnection(selectedCompanyId!, connectionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: CONNECTIONS_QUERY_KEY(selectedCompanyId ?? ""),
      });
      pushToast({ title: "Connection refreshed", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Refresh failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) => disconnectConnection(selectedCompanyId!, connectionId),
    onSuccess: async () => {
      setDrawerId(null);
      await queryClient.invalidateQueries({
        queryKey: CONNECTIONS_QUERY_KEY(selectedCompanyId ?? ""),
      });
      pushToast({ title: "Connection disconnected", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Disconnect failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const connectMutation = useMutation({
    mutationFn: (providerId: string) =>
      startConnect(selectedCompanyId!, providerId, {
        returnUrl: window.location.pathname,
      }),
    onSuccess: ({ authorizeUrl }) => {
      window.location.assign(authorizeUrl);
    },
    onError: (err) => {
      pushToast({
        title: "Could not start connection",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  // Toast based on URL query params after callback redirect.
  useEffect(() => {
    const connected = searchParams.get("oauth_connected");
    const error = searchParams.get("oauth_error");
    if (connected) {
      pushToast({ title: t.toastConnected(connected), tone: "success" });
      setSearchParams(
        (params) => {
          params.delete("oauth_connected");
          return params;
        },
        { replace: true },
      );
    } else if (error) {
      pushToast({ title: t.toastError(error), tone: "error" });
      setSearchParams(
        (params) => {
          params.delete("oauth_error");
          return params;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams, pushToast]);

  const providers = providersQuery.data?.providers ?? [];
  const connections = connectionsQuery.data?.connections ?? [];

  const sortedProviders = useMemo(() => {
    const byProvider = new Map<string, ConnectionSummary>(
      connections.map((conn) => [conn.providerId, conn]),
    );
    return [...providers].sort((a, b) => sortProviders(a, b, byProvider));
  }, [providers, connections]);

  const connectionByProvider = useMemo(() => {
    const map = new Map<string, ConnectionSummary>();
    for (const conn of connections) map.set(conn.providerId, conn);
    return map;
  }, [connections]);

  const drawerConnection = drawerId
    ? connections.find((conn) => conn.id === drawerId) ?? null
    : null;

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a company to manage connections.
      </div>
    );
  }

  if (providersQuery.isLoading || connectionsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading connections…</div>;
  }

  const queryError = providersQuery.error ?? connectionsQuery.error;
  if (queryError) {
    const message =
      queryError instanceof ApiError && queryError.status === 403
        ? "You do not have permission to view OAuth connections for this company."
        : queryError instanceof Error
          ? queryError.message
          : "Failed to load connections.";
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {message}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t.title}</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      {providers.length === 0 ? (
        <Card className="gap-2 px-6 py-8 text-center" data-testid="connections-empty-state">
          <div className="text-base font-semibold">{t.noProvidersTitle}</div>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{t.noProvidersBody}</p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sortedProviders.map((provider) => (
            <ProviderTile
              key={provider.id}
              provider={provider}
              connection={connectionByProvider.get(provider.id) ?? null}
              role={role}
              onConnect={() => connectMutation.mutate(provider.id)}
              onManage={() =>
                setDrawerId(connectionByProvider.get(provider.id)?.id ?? null)
              }
            />
          ))}
        </div>
      )}

      <ConnectionDrawer
        connection={drawerConnection}
        role={role}
        onClose={() => setDrawerId(null)}
        onRefresh={() => drawerConnection && refreshMutation.mutate(drawerConnection.id)}
        onDisconnect={() =>
          drawerConnection && disconnectMutation.mutate(drawerConnection.id)
        }
        busy={refreshMutation.isPending || disconnectMutation.isPending}
      />
    </div>
  );
}

function sortProviders(
  a: ProviderSummary,
  b: ProviderSummary,
  byProvider: Map<string, ConnectionSummary>,
): number {
  const ac = byProvider.get(a.id);
  const bc = byProvider.get(b.id);
  if (ac && !bc) return -1;
  if (!ac && bc) return 1;
  if (ac && bc) {
    const at = ac.lastRefreshedAt ? new Date(ac.lastRefreshedAt).getTime() : 0;
    const bt = bc.lastRefreshedAt ? new Date(bc.lastRefreshedAt).getTime() : 0;
    if (at !== bt) return bt - at;
  }
  return a.displayName.localeCompare(b.displayName);
}
