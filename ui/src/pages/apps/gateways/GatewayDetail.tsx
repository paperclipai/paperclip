import { useTranslation } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Send } from "lucide-react";
import type { ToolMcpGatewayTokenCreated } from "@paperclipai/shared";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GATEWAY_TABS, gatewayTabHref, isGatewayTabKey, type GatewayTabKey } from "./gateway-tabs";
import { gatewaysQueryKey } from "./NewGatewayDialog";
import { ConnectClientDialog } from "./ConnectClientDialog";
import { EditGatewayDialog } from "./EditGatewayDialog";
import { deriveGatewayApps, isGatewayOn } from "./gateway-helpers";
import { OverviewPanel } from "./panels/OverviewPanel";
import { AppsToolsPanel } from "./panels/AppsToolsPanel";
import { TokensPanel } from "./panels/TokensPanel";
import { GatewayActivityPanel } from "./panels/GatewayActivityPanel";
import { GatewayAdvancedPanel } from "./panels/GatewayAdvancedPanel";
import { CopyableGatewayUrl } from "./CopyableGatewayUrl";
import { describeError } from "@/api/errors";

export function GatewayDetail() {
  const { t } = useTranslation("connections");
  const { gatewayId = "", tab } = useParams<{ gatewayId: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [createdTokens, setCreatedTokens] = useState<ToolMcpGatewayTokenCreated[]>([]);

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
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "__none__", { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const gatewaysView = useQueryView(gatewaysQuery);

  const gateway = useMemo(
    () => (gatewaysQuery.data?.gateways ?? []).find((g) => g.id === gatewayId),
    [gatewaysQuery.data, gatewayId, t],
  );
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.id === gateway?.profileId),
    [profilesQuery.data, gateway?.profileId, t],
  );
  const apps = useMemo(
    () =>
      deriveGatewayApps(
        profile,
        applicationsQuery.data?.applications ?? [],
        connectionsQuery.data?.connections ?? [],
      ),
    [profile, applicationsQuery.data, connectionsQuery.data, t],
  );
  const agentNames = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data, t],
  );
  const projectNames = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name])),
    [projectsQuery.data, t],
  );

  function rememberCreatedToken(token: ToolMcpGatewayTokenCreated) {
    setCreatedTokens((current) => [token, ...current.filter((item) => item.id !== token.id)]);
  }

  useEffect(() => {
    if (!gateway) return;
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: t("gateways_8220856"), href: "/apps/gateways" },
      { label: gateway.name },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, gateway, t]);

  const toggleMutation = useMutation({
    mutationFn: () =>
      toolsApi.updateGateway(selectedCompanyId!, gatewayId, {
        status: gateway && isGatewayOn(gateway) ? "disabled" : "active",
      }),
    onSuccess: async (updated) => {
      pushToast({
        title: updated.status === "active" ? t("gateway_on_000445d") : t("gateway_off_c7a89c2"),
        body:
          updated.status === "active"
            ? t("is_exposing_its_tools_again_63e6b47", { name: updated.name })
            : t("is_off_every_client_goes_silent_4507e64", { name: updated.name }),
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_update_the_gateway_c98b694"),
        body: describeError(error).body,
        tone: "error",
      }),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("select_an_organization_to_manage_gateways_78cafb1")}</div>;
  }
  if (!activeTab) {
    return <Navigate replace to={gatewayTabHref(gatewayId, "overview")} />;
  }
  if (gatewaysQuery.isLoading || gatewaysView.kind === "reconnecting") {
    return (
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-9 w-full max-w-lg" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (gatewaysView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={gatewaysQuery.error}
        action="load the gateway"
        onRetry={gatewaysView.retry}
        retrying={gatewaysView.isFetching}
      />
    );
  }
  if (!gateway) {
    return (
      <div className="max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">{t("we_couldn_t_find_that_gateway_b0d144a")}</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/apps/gateways")}>{t("back_to_gateways_c22de08")}</Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-5 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link to="/apps/gateways" className="hover:underline">{t("apps_gateways_90eda07")}</Link>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{gateway.name}</h1>
          <CopyableGatewayUrl endpointPath={gateway.endpointPath} className="mt-1 max-w-xl" />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 h-4 w-4" />{t("edit_16f01b4")}</Button>
          <Button onClick={() => setSnippetOpen(true)}>
            <Send className="mr-1.5 h-4 w-4" />{t("client_snippets_a8ebe47")}</Button>
        </div>
      </div>

      <nav className="flex items-center gap-6 overflow-x-auto border-b border-border text-sm" aria-label={t("gateway_tabs_76b67c2")}>
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
          onTokenCreated={rememberCreatedToken}
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
        createdTokens={createdTokens}
        onTokenCreated={rememberCreatedToken}
      />
      <EditGatewayDialog
        companyId={selectedCompanyId}
        gateway={gateway}
        profiles={profilesQuery.data?.profiles ?? []}
        open={editing}
        onOpenChange={setEditing}
      />
    </div>
  );
}
