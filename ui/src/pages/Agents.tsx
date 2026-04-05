import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { RaavaStarMark } from "../components/RaavaStarMark";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { useIsRaava } from "../hooks/useIsRaava";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  hermes_local: "Hermes",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

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

// ---------------------------------------------------------------------------
// Raava tab mapping (Figma uses Working/Paused/Needs Attention)
// ---------------------------------------------------------------------------

type RaavaFilterTab = "all" | "working" | "paused" | "attention";

function matchesRaavaFilter(agent: Agent, tab: RaavaFilterTab): boolean {
  if (agent.status === "terminated") return false;
  if (tab === "all") return true;
  if (tab === "working")
    return agent.status === "active" || agent.status === "running" || agent.status === "idle";
  if (tab === "paused") return agent.status === "paused";
  if (tab === "attention") return agent.status === "error";
  return true;
}

// ---------------------------------------------------------------------------
// Raava avatar colors (per Figma: each team member has a unique hue)
// ---------------------------------------------------------------------------

const AVATAR_COLORS = [
  { bg: "rgba(34,74,232,0.15)", text: "#224ae8" },
  { bg: "rgba(113,110,255,0.15)", text: "#716eff" },
  { bg: "rgba(73,92,244,0.15)", text: "#495cf4" },
  { bg: "rgba(140,51,217,0.15)", text: "#8c33d9" },
  { bg: "rgba(229,140,26,0.15)", text: "#e58c1a" },
  { bg: "rgba(26,166,153,0.15)", text: "#1aa699" },
];

function getAvatarColor(index: number) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Mock team members (used when real agent data is unavailable/empty)
// ---------------------------------------------------------------------------

interface MockTeamMember {
  id: string;
  name: string;
  role: string;
  status: "working" | "idle" | "attention" | "paused";
  activity: string;
  cost: string;
}

const MOCK_TEAM: MockTeamMember[] = [
  { id: "mock-1", name: "Alex", role: "Sales Assistant", status: "working", activity: "Following up on leads...", cost: "$34.20/wk" },
  { id: "mock-2", name: "Jordan", role: "Ops Manager", status: "idle", activity: "Last active 2h ago", cost: "$28.10/wk" },
  { id: "mock-3", name: "Sam", role: "Data Analyst", status: "attention", activity: "Error: DB conn failed", cost: "$12.00/wk" },
  { id: "mock-4", name: "Taylor", role: "Customer Support", status: "working", activity: "Drafting ticket responses", cost: "$22.50/wk" },
  { id: "mock-5", name: "Riley", role: "Marketing Coordinator", status: "paused", activity: "Paused by user", cost: "$0.00/wk" },
  { id: "mock-6", name: "Casey", role: "General Assistant", status: "working", activity: "Organizing inbox", cost: "$18.90/wk" },
];

function mapAgentStatusToRaava(status: string): "working" | "idle" | "attention" | "paused" {
  if (status === "error") return "attention";
  if (status === "paused") return "paused";
  if (status === "active" || status === "running" || status === "idle") return "working";
  return "idle";
}

const RAAVA_STATUS_CONFIG: Record<string, { label: string; dotClass: string; textClass: string }> = {
  working: { label: "Working", dotClass: "bg-emerald-500", textClass: "text-emerald-500" },
  idle: { label: "Idle", dotClass: "bg-gray-400", textClass: "text-muted-foreground" },
  attention: { label: "Needs Attention", dotClass: "bg-red-500", textClass: "text-red-500" },
  paused: { label: "Paused", dotClass: "bg-amber-500", textClass: "text-amber-600" },
};

// ---------------------------------------------------------------------------
// Raava My Team Page
// ---------------------------------------------------------------------------

function RaavaMyTeamPage({
  agents,
  isLoading: loading,
  error,
  openNewAgent,
}: {
  agents: Agent[] | undefined;
  isLoading: boolean;
  error: Error | null;
  openNewAgent: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RaavaFilterTab>("all");

  // Derive card data from agents or fallback to mock
  const teamMembers = useMemo(() => {
    if (!agents || agents.length === 0) return [];
    return agents
      .filter((a) => a.status !== "terminated")
      .map((a, i) => ({
        id: a.id,
        name: a.name,
        role: roleLabels[a.role] ?? a.role,
        raavaStatus: mapAgentStatusToRaava(a.status),
        activity: a.title ?? `${roleLabels[a.role] ?? a.role}`,
        cost: `$${(a.spentMonthlyCents / 100).toFixed(2)}/mo`,
        colorIndex: i,
        agent: a,
      }));
  }, [agents]);

  const useMock = teamMembers.length === 0 && !loading && agents === undefined;

  // Count by status for tab badges
  const counts = useMemo(() => {
    const items = useMock ? MOCK_TEAM : teamMembers;
    const all = items.length;
    const working = items.filter((m) =>
      useMock
        ? (m as MockTeamMember).status === "working"
        : (m as (typeof teamMembers)[number]).raavaStatus === "working",
    ).length;
    const paused = items.filter((m) =>
      useMock
        ? (m as MockTeamMember).status === "paused"
        : (m as (typeof teamMembers)[number]).raavaStatus === "paused",
    ).length;
    const attention = items.filter((m) =>
      useMock
        ? (m as MockTeamMember).status === "attention"
        : (m as (typeof teamMembers)[number]).raavaStatus === "attention",
    ).length;
    return { all, working, paused, attention };
  }, [useMock, teamMembers]);

  // Filter items by tab
  const filteredItems = useMemo(() => {
    if (useMock) {
      if (activeTab === "all") return MOCK_TEAM;
      return MOCK_TEAM.filter((m) => m.status === activeTab);
    }
    if (activeTab === "all") return teamMembers;
    return teamMembers.filter((m) => m.raavaStatus === activeTab);
  }, [useMock, teamMembers, activeTab]);

  if (loading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-destructive">{error.message}</p>
      </div>
    );
  }

  // Empty state (Screen 24)
  if (agents && agents.length === 0 && !useMock) {
    return <RaavaEmptyState openNewAgent={openNewAgent} />;
  }

  const tabs: { value: RaavaFilterTab; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "working", label: "Working", count: counts.working },
    { value: "paused", label: "Paused", count: counts.paused },
    { value: "attention", label: "Needs Attention", count: counts.attention },
  ];

  return (
    <div className="space-y-7">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[26px] text-foreground">My Team</h1>
        <Button variant="gradient" size="sm" onClick={openNewAgent}>
          <Plus className="h-4 w-4" />
          Hire
        </Button>
      </div>

      {/* Filter tabs (pill style matching Figma) */}
      <div className="flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setActiveTab(t.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-colors",
              activeTab === t.value
                ? "bg-foreground text-background"
                : "bg-secondary text-muted-foreground hover:bg-accent/50",
            )}
          >
            {t.label}
            <span
              className={cn(
                "text-[11px] font-semibold",
                activeTab === t.value
                  ? "text-background"
                  : "text-muted-foreground",
              )}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Card grid - 2x3 */}
      {filteredItems.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No team members match the selected filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filteredItems.map((member, idx) => {
            const isMock = useMock;
            const m = isMock ? (member as MockTeamMember) : (member as (typeof teamMembers)[number]);
            const name = m.name;
            const initial = name[0].toUpperCase();
            const color = getAvatarColor(isMock ? idx : (m as (typeof teamMembers)[number]).colorIndex);
            const statusKey = isMock
              ? (m as MockTeamMember).status
              : (m as (typeof teamMembers)[number]).raavaStatus;
            const statusConfig = RAAVA_STATUS_CONFIG[statusKey];
            const role = isMock ? (m as MockTeamMember).role : (m as (typeof teamMembers)[number]).role;
            const activity = isMock ? (m as MockTeamMember).activity : (m as (typeof teamMembers)[number]).activity;
            const cost = isMock ? (m as MockTeamMember).cost : (m as (typeof teamMembers)[number]).cost;
            const href = isMock ? "#" : agentUrl((m as (typeof teamMembers)[number]).agent);

            return (
              <Link
                key={m.id}
                to={href}
                className="raava-card bg-white px-6 pt-6 pb-5 flex flex-col gap-3.5 no-underline text-inherit hover:shadow-md transition-shadow dark:bg-card"
              >
                {/* Header: avatar + name/role */}
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                    style={{ backgroundColor: color.bg }}
                  >
                    <span
                      className="font-display text-lg"
                      style={{ color: color.text }}
                    >
                      {initial}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-display text-base text-foreground">
                      {name}
                    </span>
                    <span className="inline-flex w-fit rounded-xl bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {role}
                    </span>
                  </div>
                </div>

                {/* Divider */}
                <div className="h-px w-full bg-border" />

                {/* Status dot + label */}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full shrink-0",
                      statusConfig.dotClass,
                    )}
                  />
                  <span
                    className={cn(
                      "text-xs font-medium",
                      statusConfig.textClass,
                    )}
                  >
                    {statusConfig.label}
                  </span>
                </div>

                {/* Activity */}
                <p
                  className={cn(
                    "text-[13px] truncate",
                    statusKey === "attention"
                      ? "text-red-500"
                      : "text-muted-foreground",
                  )}
                >
                  {activity}
                </p>

                {/* Cost */}
                <p className="text-sm font-semibold text-foreground font-mono">
                  {cost}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raava Empty State (Screen 24)
// ---------------------------------------------------------------------------

function RaavaEmptyState({ openNewAgent }: { openNewAgent: () => void }) {
  return (
    <div className="space-y-7">
      {/* Header row (same as populated page) */}
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[26px] text-foreground">My Team</h1>
        <Button variant="gradient" size="sm" onClick={openNewAgent}>
          <Plus className="h-4 w-4" />
          Hire
        </Button>
      </div>

      {/* Centered empty state */}
      <div className="flex flex-col items-center justify-center py-24 gap-6">
        <RaavaStarMark size={80} className="drop-shadow-lg" />

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="font-display text-xl text-foreground">
            Your team is empty
          </h2>
          <p className="text-sm text-muted-foreground max-w-[400px] leading-relaxed">
            Hire your first AI team member to get started. Pick a role, name
            them, and they&apos;ll be working in under 2 minutes.
          </p>
        </div>

        <Button
          variant="gradient"
          size="lg"
          className="rounded-xl px-8 py-3.5 text-base shadow-[0_4px_16px_rgba(34,74,232,0.2)]"
          onClick={openNewAgent}
        >
          <span className="font-display font-semibold">
            Hire Your First Team Member
          </span>
        </Button>

        <button className="text-sm font-medium text-primary hover:underline">
          Learn how it works &rarr;
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Agents component (unchanged for non-Raava, delegates for Raava)
// ---------------------------------------------------------------------------

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const { isRaava } = useIsRaava();
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
    enabled: !!selectedCompanyId && effectiveView === "org" && !isRaava,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

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
    setBreadcrumbs([{ label: isRaava ? "My Team" : "Agents" }]);
  }, [setBreadcrumbs, isRaava]);

  // -----------------------------------------------------------------------
  // Raava mode: render the card-grid My Team page
  // -----------------------------------------------------------------------
  if (isRaava) {
    return (
      <RaavaMyTeamPage
        agents={agents}
        isLoading={isLoading}
        error={error as Error | null}
        openNewAgent={openNewAgent}
      />
    );
  }

  // -----------------------------------------------------------------------
  // Standard (non-Raava) Agents page
  // -----------------------------------------------------------------------

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
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
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
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
              Filters
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
                  Show terminated
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
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
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
        <p className="text-xs text-muted-foreground">
          {filtered.length} agent{filtered.length !== 1 ? "s" : ""}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
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
                subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
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
                      <span className="text-xs text-muted-foreground font-mono w-14 text-right">
                        {adapterLabels[agent.adapterType] ?? agent.adapterType}
                      </span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "\u2014"}
                      </span>
                      <span className="w-20 flex justify-end">
                        <StatusBadge status={agent.status} />
                      </span>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode key={node.id} node={node} depth={0} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
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
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
}) {
  const agent = agentMap.get(node.id);

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {roleLabels[node.role] ?? node.role}
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
                <span className="text-xs text-muted-foreground font-mono w-14 text-right">
                  {adapterLabels[agent.adapterType] ?? agent.adapterType}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "\u2014"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              <StatusBadge status={node.status} />
            </span>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} agentMap={agentMap} liveRunByAgent={liveRunByAgent} />
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
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
