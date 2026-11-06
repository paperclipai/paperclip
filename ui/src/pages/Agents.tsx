import { t, useTranslation } from "@/i18n";
import { PrimaryAgentIndicator } from "@/components/primary-agent/PrimaryAgentPresentation";
import { AgentBulkRoster } from "@/components/agents/AgentBulkRoster";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useAgentChatEnabled } from "../hooks/useAgentChatEnabled";
import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { builtInAgentsApi, type BuiltInAgentState } from "../api/builtInAgents";
import { environmentsApi } from "../api/environments";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { queryKeys } from "../lib/queryKeys";
import { isPlatformManagedEnvironment } from "../lib/managed-sandbox-environment";
import { AgentStatusBadge, AgentStatusCapsule } from "../components/StatusBadge";
import { EntityRow } from "../components/EntityRow";
import { BuiltInLifecycleChip } from "../components/BuiltInAgentBadges";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { OrgChart } from "./OrgChart";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { AgentsToolbar } from "../components/AgentsToolbar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { AlertTriangle, Bot, MessagesSquare } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type Environment, type EnvironmentCapabilities } from "@paperclipai/shared";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { agentDisplayAdapterType, getAdapterLabel } from "../adapters/adapter-display-registry";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

// Lazy-loaded so the roster page doesn't statically pull in the full
// AgentConfigForm module graph (the modal reuses its adapter/model pickers).
const ConfigureBuiltInAgentModal = lazy(() =>
  import("../components/ConfigureBuiltInAgentModal").then((m) => ({
    default: m.ConfigureBuiltInAgentModal,
  })),
);

import { AGENT_FILTER_TABS } from "../lib/agent-filter-tabs";
export { AGENT_FILTER_TABS } from "../lib/agent-filter-tabs";
type FilterTab = (typeof AGENT_FILTER_TABS)[number];

function isFilterTab(value: string): value is FilterTab {
  return (AGENT_FILTER_TABS as readonly string[]).includes(value);
}

interface EnvironmentDescriptor {
  label: string;
  detail: string;
  title: string;
}

function localEnvironmentDescriptor(): EnvironmentDescriptor {
  return {
    label: t("agents.environment.local"),
    detail: t("agents.environment.paperclipHost"),
    title: t("agents.environment.localTitle"),
  };
}

function loadingEnvironmentDescriptor(): EnvironmentDescriptor {
  return {
    label: "—",
    detail: t("agents.environment.loading"),
    title: t("agents.environment.loading"),
  };
}

// Agents in these states never appear in the agents list — `terminated` is
// hidden like an archived company, and `pending_approval` is a hiring gate that
// lives in the task thread, not an agent run state (PAP-75).
const HIDDEN_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);

function matchesFilter(status: string, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function matchesSearch(agent: Pick<Agent, "name" | "role" | "title">, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [agent.name, agent.role, roleLabels[agent.role], agent.title].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

export function filterAgents(agents: Agent[], tab: FilterTab, builtInAgentIds: Set<string>, query = ""): Agent[] {
  return agents
    .filter((a) => {
      if (HIDDEN_AGENT_STATUSES.has(a.status) || !matchesSearch(a, query)) return false;
      // The `builtin` filter keys on the built-in marker, not agent status.
      if (tab === "builtin") return builtInAgentIds.has(a.id);
      return matchesFilter(a.status, tab);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}

function formatEnvironmentDriver(driver: Environment["driver"]): string {
  if (driver === "ssh") return "SSH";
  return driver.charAt(0).toUpperCase() + driver.slice(1);
}

function getSandboxProviderLabel(
  environment: Environment,
  capabilities?: EnvironmentCapabilities | null,
): string {
  const provider = typeof environment.config.provider === "string"
    ? environment.config.provider.trim()
    : "";
  if (!provider) return t("agents.environment.sandbox");
  return capabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
}

function describeEnvironment(
  environment: Environment,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const detail = isPlatformManagedEnvironment(environment)
    ? t("agents.environment.managed")
    : environment.driver === "sandbox"
      ? t("agents.environment.sandboxProvider", { provider: getSandboxProviderLabel(environment, capabilities) })
      : environment.driver === "local"
        ? t("agents.environment.paperclipHost")
        : formatEnvironmentDriver(environment.driver);

  return {
    label: environment.name,
    detail,
    title: `${environment.name} - ${detail}`,
  };
}

function describeMissingEnvironment(environmentId: string): EnvironmentDescriptor {
  return {
    label: t("agents.environment.unknown"),
    detail: environmentId.slice(0, 8),
    title: t("agents.environment.unknownTitle", { environmentId }),
  };
}

function resolveAgentEnvironment(
  agent: Agent,
  environmentsById: Map<string, Environment>,
  instanceDefaultEnvironmentId: string | null,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const environmentId = agent.defaultEnvironmentId ?? instanceDefaultEnvironmentId;
  if (!environmentId) return localEnvironmentDescriptor();
  const environment = environmentsById.get(environmentId);
  return environment
    ? describeEnvironment(environment, capabilities)
    : describeMissingEnvironment(environmentId);
}

export function filterOrgTree(nodes: OrgNode[], tab: FilterTab, builtInAgentIds: Set<string>, matchingIds?: Set<string>): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, builtInAgentIds, matchingIds);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      const nodeMatches = tab === "builtin"
        ? builtInAgentIds.has(node.id)
        : matchesFilter(node.status, tab);
      if ((nodeMatches && (!matchingIds || matchingIds.has(node.id))) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type AgentsView = "list" | "org";

export function Agents({ initialView = "list" }: { initialView?: AgentsView } = {}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const agentChat = useAgentChatEnabled();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const requestedTab: FilterTab = isFilterTab(pathSegment) ? pathSegment : "all";
  const [view, setView] = useState<AgentsView>(() => streamlinedUiEnabled ? initialView : "org");
  const forceListView = !streamlinedUiEnabled && isMobile;
  const effectiveView: AgentsView = forceListView ? "list" : view;

  useEffect(() => {
    setView(streamlinedUiEnabled ? initialView : "org");
  }, [initialView, streamlinedUiEnabled]);

  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: !!selectedCompanyId,
  });
  const builtInAgentsEnabled = instanceSettings?.experimental.enableBuiltInAgents === true;
  const tab: FilterTab = "all";
  const { data: builtInAgents } = useQuery({
    queryKey: queryKeys.builtInAgents.list(selectedCompanyId!),
    queryFn: () => builtInAgentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && builtInAgentsEnabled,
  });
  const builtInByAgentId = useMemo(() => {
    const map = new Map<string, BuiltInAgentState>();
    if (!builtInAgentsEnabled) return map;
    for (const entry of builtInAgents ?? []) {
      if (entry.agentId) map.set(entry.agentId, entry);
    }
    return map;
  }, [builtInAgents, builtInAgentsEnabled]);
  const builtInAgentIds = useMemo(() => new Set(builtInByAgentId.keys()), [builtInByAgentId]);
  const [configureState, setConfigureState] = useState<BuiltInAgentState | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents, isLoading } = agentsQuery;
  const agentsView = useQueryView(agentsQuery);

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const environmentsEnabled = instanceSettings?.experimental.enableEnvironments === true;

  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const { data: environmentCapabilities } = useQuery({
    queryKey: queryKeys.environments.capabilities(selectedCompanyId!),
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const runsQueryKey = [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"] as const;
  const sharedRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs:agents-page",
    queryKey: runsQueryKey,
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
    leaderOnly: true,
  });
  const { data: runs, dataUpdatedAt: runsUpdatedAt } = useQuery({
    queryKey: runsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedRuns.enabled,
    refetchInterval: sharedRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedRuns, runs, runsUpdatedAt);

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const environmentsById = useMemo(() => {
    const map = new Map<string, Environment>();
    for (const environment of environments ?? []) map.set(environment.id, environment);
    return map;
  }, [environments]);

  const environmentByAgentId = useMemo(() => {
    const map = new Map<string, EnvironmentDescriptor>();
    for (const agent of agents ?? []) {
      map.set(
        agent.id,
        resolveAgentEnvironment(
          agent,
          environmentsById,
          instanceSettings?.defaultEnvironmentId ?? null,
          environmentCapabilities,
        ),
      );
    }
    return map;
  }, [agents, environmentsById, environmentCapabilities, instanceSettings?.defaultEnvironmentId]);

  useEffect(() => {
    setBreadcrumbs([{ label: t("agents.list.breadcrumb") }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (requestedTab !== "all") {
      navigate("/agents/all", { replace: true });
    }
  }, [navigate, requestedTab]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message={t("agents.list.selectCompany")} />;
  }

  // Keep a loaded list on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || agentsView.kind === "reconnecting") {
    return <PageSkeleton variant="list" />;
  }
  if (agentsView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={agentsView.error}
        action={t("errorActions.loadAgents")}
        onRetry={agentsView.retry}
        retrying={agentsView.isFetching}
      />
    );
  }

  const filtered = filterAgents(agents ?? [], tab, builtInAgentIds, query);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, builtInAgentIds, query.trim() ? new Set(filtered.map(agent => agent.id)) : undefined);
  const environmentDataLoading = environmentsEnabled && environments === undefined;
  const showEnvironmentColumn = environmentsEnabled && (environments === undefined || environments.length > 1);
  const resolveRenderedEnvironment = (agentId: string) => (
    environmentDataLoading
      ? loadingEnvironmentDescriptor()
      : environmentByAgentId.get(agentId) ?? localEnvironmentDescriptor()
  );

  const renderAgentRow = (agent: Agent) => {
    const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
    const builtInState = builtInByAgentId.get(agent.id);
    const showBuiltInLifecycle = builtInState?.status === "needs_setup" || builtInState?.status === "pending_approval";
    // Keep lifecycle controls with the metadata only when the content area
    // has enough room; the sidebar can leave less space than the viewport suggests.
    const builtInCluster = builtInState && showBuiltInLifecycle ? (
      <>
        <BuiltInLifecycleChip status={builtInState.status} />
        {builtInState.status === "needs_setup" && (
          <span
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Button
              size="xs"
              variant="outline"
              onClick={() => setConfigureState(builtInState)}
            >
              {t("agents.list.setUp")}
            </Button>
          </span>
        )}
      </>
    ) : null;
    return (
      <EntityRow
        key={agent.id}
        title={agent.name}
        titleAccessory={<PrimaryAgentIndicator agentId={agent.id} companyId={agent.companyId} />}
        titleClassName="flex-1"
        titleTextClassName="truncate"
        subtitleClassName="truncate"
        subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
        to={agentUrl(agent)}
        className="agent-roster-identity group py-3"
        leading={hasInvalidOrgChain ? (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label={t("agents.list.invalidChain")} />
        ) : (
          <AgentAvatar agent={agent} size={32} />
        )}
        secondaryRowClassName={cn("pl-11", !builtInCluster && !showEnvironmentColumn && !agent.lastHeartbeatAt && "sm:hidden")}
        secondaryRow={(agent.status === "paused" || builtInCluster || showEnvironmentColumn || agent.lastHeartbeatAt) && (
          <div className="flex flex-wrap items-center gap-2">
            {builtInCluster}
            {showEnvironmentColumn && <span className="text-xs text-muted-foreground" title={resolveRenderedEnvironment(agent.id).title}>
              {resolveRenderedEnvironment(agent.id).label} · {resolveRenderedEnvironment(agent.id).detail}
            </span>}
            {agent.lastHeartbeatAt && <span className="text-xs text-muted-foreground" title={t("agents.list.lastHeartbeat")}>{relativeTime(agent.lastHeartbeatAt)}</span>}
          </div>
        )}
      />
    );
  };

  const renderAgentStatus = (agent: Agent) => (
    <div className="flex items-center gap-3">
      {liveRunByAgent.has(agent.id) && (
        <LiveRunIndicator
          agentRef={agentRouteRef(agent)}
          runId={liveRunByAgent.get(agent.id)!.runId}
          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
        />
      )}
      <AgentStatusBadge status={agent.status} />
    </div>
  );

  return (
    <div className={cn(
      "flex flex-col gap-4 @container",
      effectiveView === "org" && "h-full min-h-0",
    )}>
      <AgentsToolbar query={query} onQueryChange={setQuery} view={effectiveView} onViewChange={setView}
        hideViewToggle={forceListView} onNewAgent={openNewAgent} />

      <div className={cn("min-h-0 space-y-4", effectiveView === "org" && "flex flex-1 flex-col")}>

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message={t("agents.list.createFirst")}
          action={t("agents.list.newAgent")}
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && agents && agents.length > 0 && (
        <AgentBulkRoster key={selectedCompanyId} companyId={selectedCompanyId}
          agents={agents.filter(agent => !HIDDEN_AGENT_STATUSES.has(agent.status))}
          visibleAgents={filtered} renderAgent={renderAgentRow} renderStatus={renderAgentStatus}
          renderChat={agentChat.enabled ? agent => (
            // Use Radix's standard hover delay, isolated from the app's instant provider.
            <TooltipPrimitive.Provider skipDelayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/agent-row:opacity-100 focus-visible:opacity-100"
                    aria-label={`Chat with ${agent.name}`}
                    onClick={() => navigate(`/chats/${agentRouteRef(agent)}`)}
                  >
                    <MessagesSquare className="size-3.5" aria-hidden />
                    Chat
                  </button>
                </TooltipTrigger>
                <TooltipContent>chat with this agent</TooltipContent>
              </Tooltip>
            </TooltipPrimitive.Provider>
          ) : undefined} />
      )}



      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <OrgChart embedded orgTree={filteredOrg} agents={agents ?? []} />
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("agents.list.noMatches")}
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("agents.list.noHierarchy")}
        </p>
      )}
      {configureState && selectedCompanyId && (
        <Suspense fallback={null}>
          <ConfigureBuiltInAgentModal
            companyId={selectedCompanyId}
            state={configureState}
            open={configureState !== null}
            onOpenChange={(open) => {
              if (!open) setConfigureState(null);
            }}
          />
        </Suspense>
      )}
      </div>
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  environmentByAgentId,
  environmentDataLoading,
  showEnvironment,
  builtInByAgentId,
  onConfigureBuiltIn,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  environmentByAgentId: Map<string, EnvironmentDescriptor>;
  environmentDataLoading: boolean;
  showEnvironment: boolean;
  builtInByAgentId: Map<string, BuiltInAgentState>;
  onConfigureBuiltIn: (state: BuiltInAgentState) => void;
}) {
  const { t } = useTranslation();
  const agent = agentMap.get(node.id);
  const builtInState = builtInByAgentId.get(node.id);
  const showBuiltInLifecycle = builtInState?.status === "needs_setup" || builtInState?.status === "pending_approval";
  const hasInvalidOrgChain = Boolean(agent && agent.orgChainHealth?.status === "invalid_org_chain");

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50 transition-colors w-full text-left no-underline text-inherit"
      >
        {hasInvalidOrgChain ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t("agents.list.invalidChain")} />
        ) : (
          <AgentAvatar agent={agent ?? node} size={24} />
        )}
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
          {/* Name floor + `truncate` keeps the primary identifier readable; the
              cluster wraps to a second line under pressure instead of starving
              the name at narrow widths. */}
          <div className="min-w-(--sz-7rem) truncate">
            <span className="text-sm font-medium">{node.name}</span>
            <span className="text-xs text-muted-foreground ml-2">
              {roleLabels[node.role] ?? node.role}
              {agent?.title ? ` - ${agent.title}` : ""}
            </span>
          </div>
          {builtInState && showBuiltInLifecycle && (
            <div className="flex items-center gap-1.5 shrink-0">
              <BuiltInLifecycleChip status={builtInState.status} />
              {builtInState.status === "needs_setup" && (
                <span
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <Button size="xs" variant="outline" onClick={() => onConfigureBuiltIn(builtInState)}>
                    {t("agents.list.setUp")}
                  </Button>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <AgentStatusBadge status={node.status} />
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <div className="hidden xl:flex items-center gap-3">
                <AgentMetaColumns
                  agent={agent}
                  environment={
                    environmentDataLoading
                      ? loadingEnvironmentDescriptor()
                      : environmentByAgentId.get(agent.id) ?? localEnvironmentDescriptor()
                  }
                  showEnvironment={showEnvironment}
                />
              </div>
            )}
            <span className="w-20 flex justify-end">
              <AgentStatusBadge status={node.status} />
            </span>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              environmentByAgentId={environmentByAgentId}
              environmentDataLoading={environmentDataLoading}
              showEnvironment={showEnvironment}
              builtInByAgentId={builtInByAgentId}
              onConfigureBuiltIn={onConfigureBuiltIn}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Provider/model + heartbeat columns shared by the list and org views. The
 * model and adapter label share one fixed-width cell, each line truncating with
 * an ellipsis so a long model id can never overlap the heartbeat column. The
 * heartbeat is single-line (`whitespace-nowrap`) and wide enough for a full
 * date like "Apr 30, 2026".
 */
function AgentMetaColumns({
  agent,
  environment,
  showEnvironment,
}: {
  agent: Agent;
  environment: EnvironmentDescriptor;
  showEnvironment: boolean;
}) {
  const model = getConfiguredModel(agent);
  const adapterLabel = getAdapterLabel(agentDisplayAdapterType(agent));
  return (
    <>
      <div className="w-44 min-w-0 leading-tight">
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={model ?? undefined}
        >
          {model ?? "—"}
        </div>
        <div className="truncate font-mono text-(length:--text-micro) text-muted-foreground/70" title={adapterLabel}>
          {adapterLabel}
        </div>
      </div>
      {showEnvironment && (
        <div className="w-44 min-w-0 leading-tight">
          <div className="truncate text-xs text-muted-foreground" title={environment.title}>
            {environment.label}
          </div>
          <div className="truncate text-(length:--text-micro) text-muted-foreground/70">
            {environment.detail}
          </div>
        </div>
      )}
      <span className="w-24 whitespace-nowrap text-right text-xs text-muted-foreground">
        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
      </span>
    </>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-(length:--text-micro) font-medium text-blue-600 dark:text-blue-400">
        {t("agents.list.live")}{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
