import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { useCurrentLocale, useLocalizedCopy } from "../i18n/ui-copy";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import {
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}

function agentRoleLabel(role: string, copy: ReturnType<typeof useLocalizedCopy>) {
  const labels: Record<string, string> = {
    ceo: copy("agentRole.ceo", "CEO", "대표"),
    cto: copy("agentRole.cto", "CTO", "기술 책임자"),
    cmo: copy("agentRole.cmo", "CMO", "마케팅 책임자"),
    cfo: copy("agentRole.cfo", "CFO", "재무 책임자"),
    security: copy("agentRole.security", "Security", "보안"),
    engineer: copy("agentRole.engineer", "Engineer", "엔지니어"),
    designer: copy("agentRole.designer", "Designer", "디자이너"),
    pm: copy("agentRole.pm", "PM", "PM"),
    qa: copy("agentRole.qa", "QA", "QA"),
    devops: copy("agentRole.devops", "DevOps", "DevOps"),
    researcher: copy("agentRole.researcher", "Researcher", "조사원"),
    general: copy("agentRole.general", "General", "일반"),
  };
  return labels[role] ?? roleLabels[role] ?? role;
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, showTerminated: boolean): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, showTerminated);
      if (matchesFilter(node.status, tab, showTerminated) || filteredReports.length > 0) {
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
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);

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

  useEffect(() => {
    setBreadcrumbs([{ label: copy("agents.breadcrumb", "Agents", "직원") }]);
  }, [copy, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message={copy("agents.noCompany", "Select a company to view agents.", "직원을 보려면 회사를 선택하세요.")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, showTerminated);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: copy("agents.tabs.all", "All", "전체") },
              { value: "active", label: copy("agents.tabs.active", "Active", "활성") },
              { value: "paused", label: copy("agents.tabs.paused", "Paused", "일시정지") },
              { value: "error", label: copy("agents.tabs.error", "Error", "오류") },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              {copy("agents.filters", "Filters", "필터")}
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  {copy("agents.showTerminated", "Show terminated", "종료된 직원 표시")}
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                aria-label={copy("agents.view.list", "List view", "목록 보기")}
                title={copy("agents.view.list", "List view", "목록 보기")}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                aria-label={copy("agents.view.org", "Org chart view", "조직도 보기")}
                title={copy("agents.view.org", "Org chart view", "조직도 보기")}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            {copy("agents.newAgent", "New Agent", "새 직원")}
          </Button>
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{copy("agents.count", "{{count}} agent", "{{count}}명", { count: filtered.length })}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message={copy("agents.empty", "Create your first agent to get started.", "첫 직원을 만들어 시작하세요.")}
          action={copy("agents.newAgent", "New Agent", "새 직원")}
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((agent) => {
            return (
              <EntityRow
                key={agent.id}
                title={agent.name}
                subtitle={`${agentRoleLabel(agent.role, copy)}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
                className={cn(
                  "group",
                  agent.pausedAt && tab !== "paused" ? "opacity-50" : "",
                  resourceMembershipState(membershipsQuery.data, "agent", agent.id) === "left" ? "text-foreground/55" : "",
                )}
                leading={
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                    />
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    <span className="sm:hidden">
                      {liveRunByAgent.has(agent.id) ? (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      ) : (
                        <StatusBadge status={agent.status} />
                      )}
                    </span>
                    <div className="hidden sm:flex items-center gap-3">
                      {liveRunByAgent.has(agent.id) && (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      )}
                      <span className="w-28 whitespace-nowrap text-left font-mono text-xs text-muted-foreground">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                      <span
                        className="w-36 truncate text-left font-mono text-xs text-muted-foreground"
                        title={getConfiguredModel(agent) ?? undefined}
                      >
                        {getConfiguredModel(agent) ?? "—"}
                      </span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt, locale) : "—"}
                      </span>
                      <span className="w-20 flex justify-end">
                        <StatusBadge status={agent.status} />
                      </span>
                    </div>
                    <MembershipAction
                      state={resourceMembershipState(membershipsQuery.data, "agent", agent.id)}
                      pending={
                        membershipMutation.isPending &&
                        membershipMutation.variables?.resourceType === "agent" &&
                        membershipMutation.variables.resourceId === agent.id
                      }
                      pendingState={
                        membershipMutation.isPending &&
                        membershipMutation.variables?.resourceType === "agent" &&
                        membershipMutation.variables.resourceId === agent.id
                          ? membershipMutation.variables.state
                          : null
                      }
                      resourceName={agent.name}
                      onJoin={() => membershipMutation.mutate({
                        resourceType: "agent",
                        resourceId: agent.id,
                        resourceName: agent.name,
                        state: "joined",
                      })}
                      onLeave={() => membershipMutation.mutate({
                        resourceType: "agent",
                        resourceId: agent.id,
                        resourceName: agent.name,
                        state: "left",
                      })}
                    />
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {copy("agents.noFilterResults", "No agents match the selected filter.", "선택한 필터와 일치하는 직원이 없습니다.")}
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              tab={tab}
              memberships={membershipsQuery.data}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {copy("agents.noFilterResults", "No agents match the selected filter.", "선택한 필터와 일치하는 직원이 없습니다.")}
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {copy("agents.noOrg", "No organizational hierarchy defined.", "정의된 조직도가 없습니다.")}
        </p>
      )}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  tab,
  memberships,
  membershipMutation,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  tab: FilterTab;
  memberships: ReturnType<typeof useResourceMemberships>["data"];
  membershipMutation: ReturnType<typeof useResourceMembershipMutation>;
}) {
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const agent = agentMap.get(node.id);
  const membershipState = resourceMembershipState(memberships, "agent", node.id);
  const pending = membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === node.id;

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn(
          "group flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit",
          agent?.pausedAt && tab !== "paused" && "opacity-50",
          membershipState === "left" && "text-foreground/55",
        )}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {agentRoleLabel(node.role, copy)}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
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
              <StatusBadge status={node.status} />
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
              <>
                <span className="w-28 whitespace-nowrap text-left font-mono text-xs text-muted-foreground">
                  {getAdapterLabel(agent.adapterType)}
                </span>
                <span
                  className="w-36 truncate text-left font-mono text-xs text-muted-foreground"
                  title={getConfiguredModel(agent) ?? undefined}
                >
                  {getConfiguredModel(agent) ?? "—"}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt, locale) : "—"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              <StatusBadge status={node.status} />
            </span>
          </div>
          <MembershipAction
            state={membershipState}
            pending={pending}
            pendingState={pending ? membershipMutation.variables?.state : null}
            resourceName={node.name}
            onJoin={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "joined",
            })}
            onLeave={() => membershipMutation.mutate({
              resourceType: "agent",
              resourceId: node.id,
              resourceName: node.name,
              state: "left",
            })}
          />
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              tab={tab}
              memberships={memberships}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}
    </div>
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
  const copy = useLocalizedCopy();
  const label = liveCount > 1
    ? copy("agents.liveWithCount", "Live ({{count}})", "실행 중 ({{count}})", { count: liveCount })
    : copy("agents.live", "Live", "실행 중");

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
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        {label}
      </span>
    </Link>
  );
}
