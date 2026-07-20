import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import type { ToolMcpGatewayTokenCreated } from "@paperclipai/shared";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/pages/tools/shared";
import { GATEWAY_TABS, gatewayTabHref, isGatewayTabKey, type GatewayTabKey } from "./gateway-tabs";
import { gatewaysQueryKey } from "./NewGatewayDialog";
import { ConnectClientDialog } from "./ConnectClientDialog";
import { deriveGatewayApps, isGatewayOn } from "./gateway-helpers";
import { OverviewPanel } from "./panels/OverviewPanel";
import { AppsToolsPanel } from "./panels/AppsToolsPanel";
import { TokensPanel } from "./panels/TokensPanel";
import { GatewayActivityPanel } from "./panels/GatewayActivityPanel";
import { GatewayAdvancedPanel } from "./panels/GatewayAdvancedPanel";

export function GatewayDetail() {
  const { gatewayId = "", tab } = useParams<{ gatewayId: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<ToolMcpGatewayTokenCreated | null>(null);

  const activeTab: GatewayTabKey | null = isGatewayTabKey(tab) ? tab : null;

  const gatewaysQuery = useQuery({
    queryKey: gatewaysQueryKey(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGateways(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const gateway = useMemo(
    () => (gatewaysQuery.data?.gateways ?? []).find((g) => g.id === gatewayId),
    [gatewaysQuery.data, gatewayId],
  );
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.id === gateway?.profileId),
    [profilesQuery.data, gateway?.profileId],
  );
  const apps = useMemo(
    () =>
      deriveGatewayApps(
        profile,
        applicationsQuery.data?.applications ?? [],
        connectionsQuery.data?.connections ?? [],
      ),
    [profile, applicationsQuery.data, connectionsQuery.data],
  );
  const agentNames = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );
  const projectNames = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name])),
    [projectsQuery.data],
  );

  useEffect(() => {
    if (!gateway) return;
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: "Gateways", href: "/apps/gateways" },
      { label: gateway.name },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, gateway]);

  const toggleMutation = useMutation({
    mutationFn: () =>
      toolsApi.updateGateway(selectedCompanyId!, gatewayId, {
        status: gateway && isGatewayOn(gateway) ? "disabled" : "active",
      }),
    onSuccess: async (updated) => {
      pushToast({
        title: updated.status === "active" ? "Gateway on" : "Gateway off",
        body:
          updated.status === "active"
            ? `${updated.name} is exposing its tools again.`
            : `${updated.name} is off — every client goes silent.`,
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't update the gateway",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage gateways.</div>;
  }
  if (!activeTab) {
    return <Navigate replace to={gatewayTabHref(gatewayId, "overview")} />;
  }
  if (gatewaysQuery.isLoading) {
    return (
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-9 w-full max-w-lg" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (gatewaysQuery.isError) {
    return <ErrorState error={gatewaysQuery.error} onRetry={() => gatewaysQuery.refetch()} />;
  }
  if (!gateway) {
    return (
      <div className="max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">We couldn’t find that gateway.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/apps/gateways")}>
          Back to gateways
        </Button>
      </div>
    );
  }

  const endpointHost = (() => {
    try {
      return `${new URL(window.location.origin).host}${gateway.endpointPath}`;
    } catch {
      return gateway.endpointPath;
    }
  })();

  return (
    <div className="max-w-4xl space-y-5 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link to="/apps/gateways" className="hover:underline">
              Apps · Gateways
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{gateway.name}</h1>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{endpointHost}</p>
        </div>
        <Button onClick={() => setSnippetOpen(true)}>
          <Send className="mr-1.5 h-4 w-4" />
          Show snippet
        </Button>
      </div>

      <nav className="flex items-center gap-6 overflow-x-auto border-b border-border text-sm" aria-label="Gateway tabs">
        {GATEWAY_TABS.map((item) => {
          const isActive = item.key === activeTab;
          return (
            <Link
              key={item.key}
              to={gatewayTabHref(gatewayId, item.key)}
              className={cn(
                "-mb-px shrink-0 border-b-2 pb-2.5 pt-1 font-medium transition-colors",
                isActive
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {activeTab === "overview" && (
        <OverviewPanel
          gateway={gateway}
          profile={profile}
          apps={apps}
          agentNames={agentNames}
          projectNames={projectNames}
          toggleDisabled={toggleMutation.isPending}
          onToggle={() => toggleMutation.mutate()}
        />
      )}
      {activeTab === "apps" && <AppsToolsPanel apps={apps} profile={profile} />}
      {activeTab === "tokens" && (
        <TokensPanel
          companyId={selectedCompanyId}
          gateway={gateway}
          onTokenCreated={(token) => setCreatedToken(token)}
        />
      )}
      {activeTab === "activity" && (
        <GatewayActivityPanel companyId={selectedCompanyId} gateway={gateway} />
      )}
      {activeTab === "advanced" && (
        <GatewayAdvancedPanel companyId={selectedCompanyId} gateway={gateway} />
      )}

      <ConnectClientDialog
        gateway={gateway}
        open={snippetOpen}
        onOpenChange={setSnippetOpen}
        createdToken={createdToken}
      />
    </div>
  );
}
