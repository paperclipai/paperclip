import { PrimaryAgentIndicator } from "@/components/primary-agent/PrimaryAgentPresentation";
import { AgentBulkRoster } from "@/components/agents/AgentBulkRoster";
import { AgentAvatar } from "@/components/AgentAvatar";
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
import { queryKeys } from "../lib/queryKeys";
import { isPlatformManagedEnvironment } from "../lib/managed-sandbox-environment";
import { AgentStatusBadge, AgentStatusCapsule } from "../components/StatusBadge";
import { EntityRow } from "../components/EntityRow";
import { BuiltInLifecycleChip } from "../components/BuiltInAgentBadges";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Bot, Plus, List, GitBranch } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type Environment, type EnvironmentCapabilities } from "@paperclipai/shared";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

// Lazy-loaded so the roster page doesn't statically pull in the full
// AgentConfigForm module graph (the modal reuses its adapter/model pickers).
const ConfigureBuiltInAgentModal = lazy(() =>
  import("../components/ConfigureBuiltInAgentModal").then((m) => ({
    default: m.ConfigureBuiltInAgentModal,
  })),
);

export const AGENT_FILTER_TABS = ["all", "active", "paused", "error", "builtin"] as const;
type FilterTab = (typeof AGENT_FILTER_TABS)[number];

function isFilterTab(value: string): value is FilterTab {
  return (AGENT_FILTER_TABS as readonly string[]).includes(value);
}

interface EnvironmentDescriptor {
  label: string;
  detail: string;
  title: string;
}

const localEnvironmentDescriptor: EnvironmentDescriptor = {
  label: "Local",
  detail: "Paperclip host",
  title: "Local - Paperclip host",
};

const loadingEnvironmentDescriptor: EnvironmentDescriptor = {
  label: "—",
  detail: "Loading environment",
  title: "Loading environment",
};

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

function filterAgents(agents: Agent[], tab: FilterTab, builtInAgentIds: Set<string>): Agent[] {
  return agents
    .filter((a) => {
      if (HIDDEN_AGENT_STATUSES.has(a.status)) return false;
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
  if (!provider) return "Sandbox";
  return capabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
}

function describeEnvironment(
  environment: Environment,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const detail = isPlatformManagedEnvironment(environment)
    ? "Managed by Paperclip"
    : environment.driver === "sandbox"
      ? `${getSandboxProviderLabel(environment, capabilities)} sandbox provider`
      : environment.driver === "local"
        ? "Paperclip host"
        : formatEnvironmentDriver(environment.driver);

  return {
    label: environment.name,
    detail,
    title: `${environment.name} - ${detail}`,
  };
}

function describeMissingEnvironment(environmentId: string): EnvironmentDescriptor {
  return {
    label: "Unknown environment",
    detail: environmentId.slice(0, 8),
    title: `Unknown environment - ${environmentId}`,
  };
}

function resolveAgentEnvironment(
  agent: Agent,
  environmentsById: Map<string, Environment>,
  instanceDefaultEnvironmentId: string | null,
  capabilities?: EnvironmentCapabilities | null,
): EnvironmentDescriptor {
  const environmentId = agent.defaultEnvironmentId ?? instanceDefaultEnvironmentId;
  if (!environmentId) return localEnvironmentDescriptor;
  const environment = environmentsById.get(environmentId);
  return environment
    ? describeEnvironment(environment, capabilities)
    : describeMissingEnvironment(environmentId);
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, builtInAgentIds: Set<string>): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, builtInAgentIds);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      const nodeMatches = tab === "builtin"
        ? builtInAgentIds.has(node.id)
        : matchesFilter(node.status, tab);
      if (nodeMatches || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const requestedTab: FilterTab = isFilterTab(pathSegment) ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;

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

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

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
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (requestedTab !== "all") {
      navigate("/agents/all", { replace: true });
    }
  }, [navigate, requestedTab]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, builtInAgentIds);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, builtInAgentIds);
  const environmentDataLoading = environmentsEnabled && environments === undefined;
  const showEnvironmentColumn = environmentsEnabled && (environments === undefined || environments.length > 1);
  const resolveRenderedEnvironment = (agentId: string) => (
    environmentDataLoading
      ? loadingEnvironmentDescriptor
      : environmentByAgentId.get(agentId) ?? localEnvironmentDescriptor
  );

  const renderAgentRow = (agent: Agent) => {
    const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
    const builtInState = builtInByAgentId.get(agent.id);
    const showBuiltInLifecycle = builtInState?.status === "needs_setup" || builtInState?.status === "pending_approval";
    // Lifecycle chip + inline `Set up`. Rendered inline in
    // `meta` at xl (where there's room and the meta columns align) and on a
    // dedicated full-width line beneath the name below xl, so the chips never
    // starve the name — the row's primary identifier — at narrow widths.
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
              Set up
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
        // Fixed (truncating) title width at xl so the `meta` group starts at a
        // constant x on every row — that's what makes the model + timestamp
        // columns line up vertically. Below xl the meta columns are hidden, so
        // the title flexes instead: a fixed width there let the shrink-0
        // trailing actions squeeze the name to zero width on mobile.
        titleClassName="flex-1"
        titleTextClassName="whitespace-normal break-words xl:truncate xl:whitespace-nowrap"
        subtitleClassName="whitespace-normal break-words xl:truncate xl:whitespace-nowrap"
        subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
        to={agentUrl(agent)}
        className="group"
        leading={hasInvalidOrgChain ? (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Invalid reporting chain" />
        ) : (
          <AgentAvatar agent={agent} size={32} />
        )}
        secondaryRowClassName={cn("pl-11", !builtInCluster && !showEnvironmentColumn && !agent.lastHeartbeatAt && "sm:hidden")}
        secondaryRow={(agent.status === "paused" || builtInCluster || showEnvironmentColumn || agent.lastHeartbeatAt) && (
          <div className="flex flex-wrap items-center gap-2">
            {agent.status === "paused" && <span className="sm:hidden"><AgentStatusBadge status={agent.status} /></span>}
            {builtInCluster}
            {showEnvironmentColumn && <span className="text-xs text-muted-foreground" title={resolveRenderedEnvironment(agent.id).title}>
              {resolveRenderedEnvironment(agent.id).label} · {resolveRenderedEnvironment(agent.id).detail}
            </span>}
            {agent.lastHeartbeatAt && <span className="text-xs text-muted-foreground" title="Last heartbeat">{relativeTime(agent.lastHeartbeatAt)}</span>}
          </div>
        )}
        trailing={
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-3">
              {liveRunByAgent.has(agent.id) && (
                <LiveRunIndicator
                  agentRef={agentRouteRef(agent)}
                  runId={liveRunByAgent.get(agent.id)!.runId}
                  liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                />
              )}
              <span className="w-20 flex justify-end">
                <AgentStatusBadge status={agent.status} />
              </span>
            </div>
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="flex items-center gap-2">
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border" role="group" aria-label="View mode">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
                title="List view"
                aria-label="List view"
                aria-pressed={effectiveView === "list"}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
                title="Org chart view"
                aria-label="Org chart view"
                aria-pressed={effectiveView === "org"}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && agents && agents.length > 0 && (
        <AgentBulkRoster key={selectedCompanyId} companyId={selectedCompanyId}
          agents={agents.filter(agent => !HIDDEN_AGENT_STATUSES.has(agent.status))}
          visibleAgents={filtered} renderAgent={renderAgentRow} />
      )}



      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              environmentByAgentId={environmentByAgentId}
              environmentDataLoading={environmentDataLoading}
              showEnvironment={showEnvironmentColumn}
              builtInByAgentId={builtInByAgentId}
              onConfigureBuiltIn={setConfigureState}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected status.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
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
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
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
                    Set up
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
                      ? loadingEnvironmentDescriptor
                      : environmentByAgentId.get(agent.id) ?? localEnvironmentDescriptor
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
  const adapterLabel = getAdapterLabel(agent.adapterType);
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
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
