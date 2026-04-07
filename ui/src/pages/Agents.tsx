import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { usePageTitle } from "../hooks/usePageTitle";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
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
import { relativeTime, cn, agentRouteRef, agentUrl, formatCents } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bot, Plus, List, LayoutGrid, GitBranch, Search, SlidersHorizontal, UserPlus, Layers, Play, X, BarChart3 } from "lucide-react";
import { AGENT_ROLE_LABELS, AGENT_LIFECYCLE_STAGES, AGENT_LIFECYCLE_LABELS, DEPARTMENTS, DEPARTMENT_LABELS, type Agent, type Department, type AgentLifecycleStage } from "@ironworksai/shared";
import { EmploymentBadge } from "../components/EmploymentBadge";
import { AgentIcon } from "../components/AgentIconPicker";
import { getRoleLevel, getAgentRingClass } from "../lib/role-icons";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  cursor: "Cursor",
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

/* ------------------------------------------------------------------ */
/*  Agent Comparison Modal                                             */
/* ------------------------------------------------------------------ */

function AgentCompareModal({
  agents,
  liveRunByAgent,
  onClose,
}: {
  agents: Agent[];
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  onClose: () => void;
}) {
  if (agents.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl mx-4 bg-background border border-border rounded-lg shadow-lg max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Agent Comparison</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Property</th>
                {agents.map((a) => (
                  <th key={a.id} className="text-left px-4 py-2 font-medium">{a.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Role</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2">{(AGENT_ROLE_LABELS as Record<string, string>)[a.role] ?? a.role}</td>
                ))}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Title</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2">{a.title || "-"}</td>
                ))}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Status</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2"><StatusBadge status={a.status} /></td>
                ))}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Adapter</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2 font-mono">{adapterLabels[a.adapterType] ?? a.adapterType}</td>
                ))}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Department</td>
                {agents.map((a) => {
                  const dept = (a as unknown as Record<string, unknown>).department as string | undefined;
                  return <td key={a.id} className="px-4 py-2">{dept ? ((DEPARTMENT_LABELS as Record<string, string>)[dept] ?? dept) : "-"}</td>;
                })}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Employment</td>
                {agents.map((a) => {
                  const emp = ((a as unknown as Record<string, unknown>).employmentType as string) ?? "full_time";
                  return <td key={a.id} className="px-4 py-2">{emp === "contractor" ? "Contractor" : "Full-Time"}</td>;
                })}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Monthly Cost</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2 tabular-nums">{a.spentMonthlyCents > 0 ? formatCents(a.spentMonthlyCents) : "-"}</td>
                ))}
              </tr>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2 text-muted-foreground">Live Runs</td>
                {agents.map((a) => {
                  const live = liveRunByAgent.get(a.id);
                  return <td key={a.id} className="px-4 py-2">{live ? `${live.liveCount} running` : "None"}</td>;
                })}
              </tr>
              <tr>
                <td className="px-4 py-2 text-muted-foreground">Last Heartbeat</td>
                {agents.map((a) => (
                  <td key={a.id} className="px-4 py-2">{a.lastHeartbeatAt ? relativeTime(a.lastHeartbeatAt) : "Never"}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function Agents() {
  usePageTitle("Agents");
  const { selectedCompanyId } = useCompany();
  const { openNewAgent, openHireAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "grid" | "org" | "pipeline">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "grid" | "org" | "pipeline" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [employmentFilter, setEmploymentFilter] = useState<string>("all");
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);

  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 3) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const invokeMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.invoke(agentId, selectedCompanyId!),
  });

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
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "pipeline",
    staleTime: 30_000,
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

  // Count completed issues per agent (done status)
  const completedIssuesByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of issues ?? []) {
      if (issue.status !== "done") continue;
      const assigneeId = (issue as unknown as Record<string, unknown>).assigneeAgentId as string | null;
      if (!assigneeId) continue;
      map.set(assigneeId, (map.get(assigneeId) ?? 0) + 1);
    }
    return map;
  }, [issues]);

  function deriveLifecycleStage(agent: Agent): AgentLifecycleStage {
    if (agent.status === "terminated") return "retired";
    const completedCount = completedIssuesByAgent.get(agent.id) ?? 0;
    if (agent.status === "active" || agent.status === "running") {
      return completedCount >= 5 ? "production" : "pilot";
    }
    return "draft";
  }

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated).filter((a) => {
    if (agentSearch.trim() && !a.name.toLowerCase().includes(agentSearch.toLowerCase()) && !(a.title ?? "").toLowerCase().includes(agentSearch.toLowerCase())) return false;
    if (departmentFilter !== "all" && (a as unknown as Record<string, unknown>).department !== departmentFilter) return false;
    const empType = ((a as unknown as Record<string, unknown>).employmentType as string) ?? "full_time";
    if (employmentFilter !== "all" && empType !== employmentFilter) return false;
    return true;
  });
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, showTerminated);

  return (
    <div className="space-y-6">
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
          {/* Search */}
          <div className="relative w-40 sm:w-52 md:w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={agentSearch}
              onChange={(e) => setAgentSearch(e.target.value)}
              placeholder="Search agents..."
              className="pl-7 text-xs h-8"
            />
          </div>
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
              {(showTerminated || departmentFilter !== "all" || employmentFilter !== "all") && (
                <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">
                  {(showTerminated ? 1 : 0) + (departmentFilter !== "all" ? 1 : 0) + (employmentFilter !== "all" ? 1 : 0)}
                </span>
              )}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-52 border border-border bg-popover shadow-md p-1 space-y-0.5">
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
                <div className="px-2 py-1.5">
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Department</label>
                  <select
                    value={departmentFilter}
                    onChange={(e) => setDepartmentFilter(e.target.value)}
                    className="w-full text-xs bg-transparent border border-border rounded px-1.5 py-1"
                  >
                    <option value="all">All departments</option>
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>{(DEPARTMENT_LABELS as Record<string, string>)[d] ?? d}</option>
                    ))}
                  </select>
                </div>
                <div className="px-2 py-1.5">
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Employment Type</label>
                  <select
                    value={employmentFilter}
                    onChange={(e) => setEmploymentFilter(e.target.value)}
                    className="w-full text-xs bg-transparent border border-border rounded px-1.5 py-1"
                  >
                    <option value="all">All types</option>
                    <option value="full_time">Full-Time</option>
                    <option value="contractor">Contractor</option>
                  </select>
                </div>
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
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("grid")}
                title="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
                title="Org chart view"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "pipeline" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("pipeline")}
                title="Pipeline view"
              >
                <Layers className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {compareIds.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => setShowCompare(true)}>
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Compare ({compareIds.size})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={openHireAgent}>
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            Hire Agent
          </Button>
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

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
            const isTerminated = agent.status === "terminated";
            return (
              <div key={agent.id} className={cn("group/row relative", isTerminated && "opacity-50")}>
              <EntityRow
                title={agent.name}
                subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
                leading={
                  <span className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleCompare(agent.id); }}
                      className={cn(
                        "flex items-center justify-center h-4 w-4 border rounded-sm text-[10px] shrink-0 transition-colors",
                        compareIds.has(agent.id)
                          ? "bg-foreground border-foreground text-background"
                          : "border-border opacity-0 group-hover/row:opacity-100",
                      )}
                      title="Add to comparison"
                    >
                      {compareIds.has(agent.id) && <span>&#10003;</span>}
                    </button>
                    <span
                      className={cn(
                        "flex items-center justify-center h-6 w-6 rounded-md",
                        getRoleLevel(agent.role) === "executive"
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : getRoleLevel(agent.role) === "management"
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            : "bg-muted text-muted-foreground",
                        getAgentRingClass(agent.role, (agent as unknown as Record<string, unknown>).employmentType as string | undefined),
                      )}
                    >
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
                    </span>
                    <span className="relative flex h-2.5 w-2.5">
                      <span
                        className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                      />
                    </span>
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    {/* Quick-invoke button on hover */}
                    {!isTerminated && (
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); invokeMutation.mutate(agent.id); }}
                        className="hidden group-hover/row:flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
                        title="Trigger heartbeat run"
                      >
                        <Play className="h-3 w-3" />
                        Run
                      </button>
                    )}
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
                      <EmploymentBadge type={(agent as unknown as Record<string, unknown>).employmentType as string ?? "full_time"} />
                      <span className="text-xs text-muted-foreground font-mono w-14 text-right">
                        {adapterLabels[agent.adapterType] ?? agent.adapterType}
                      </span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "Never"}
                      </span>
                      <span className="w-20 flex justify-end">
                        <StatusBadge status={agent.status} />
                      </span>
                      {isTerminated && (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                          Terminated
                        </span>
                      )}
                    </div>
                  </div>
                }
              />
              </div>
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Grid view */}
      {effectiveView === "grid" && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((agent) => {
            const isTerminated = agent.status === "terminated";
            const empType = ((agent as unknown as Record<string, unknown>).employmentType as string) ?? "full_time";
            const dept = (agent as unknown as Record<string, unknown>).department as string | undefined;
            const dotColor = agentStatusDot[agent.status] ?? agentStatusDotDefault;
            const costCents = (agent as unknown as Record<string, unknown>).spentMonthlyCents as number | undefined;

            return (
              <Link
                key={agent.id}
                to={agentUrl(agent)}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border border-border p-4 no-underline text-inherit transition-all duration-150 hover:bg-accent/30 hover:border-border/80 hover:shadow-sm",
                  isTerminated && "opacity-50",
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "flex items-center justify-center h-9 w-9 rounded-lg",
                        getRoleLevel(agent.role) === "executive"
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : getRoleLevel(agent.role) === "management"
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            : "bg-muted text-muted-foreground",
                        getAgentRingClass(agent.role, empType),
                      )}
                    >
                      <AgentIcon icon={agent.icon} className="h-4.5 w-4.5" />
                    </span>
                    <span className="relative flex h-2.5 w-2.5">
                      {(agent.status === "active" || agent.status === "running") && (
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${dotColor}`} />
                      )}
                      <span className={`absolute inline-flex h-full w-full rounded-full ${dotColor}`} />
                    </span>
                  </div>
                  {liveRunByAgent.has(agent.id) && (
                    <LiveRunIndicator
                      agentRef={agentRouteRef(agent)}
                      runId={liveRunByAgent.get(agent.id)!.runId}
                      liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                    />
                  )}
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm font-semibold truncate">{agent.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {roleLabels[agent.role] ?? agent.role}
                    {agent.title ? ` - ${agent.title}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {dept && (
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                      {(DEPARTMENT_LABELS as Record<string, string>)[dept] ?? dept}
                    </span>
                  )}
                  <EmploymentBadge type={empType} />
                </div>
                {agent.spentMonthlyCents > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-2 mt-auto">
                    <span>Cost to date</span>
                    <span className="tabular-nums font-medium text-foreground">
                      {formatCents(agent.spentMonthlyCents)}
                    </span>
                  </div>
                )}
                <StatusBadge status={agent.status} />
              </Link>
            );
          })}
        </div>
      )}

      {effectiveView === "grid" && agents && agents.length > 0 && filtered.length === 0 && (
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

      {/* Comparison modal */}
      {showCompare && compareIds.size > 0 && (
        <AgentCompareModal
          agents={(agents ?? []).filter((a) => compareIds.has(a.id))}
          liveRunByAgent={liveRunByAgent}
          onClose={() => setShowCompare(false)}
        />
      )}

      {/* Pipeline view */}
      {effectiveView === "pipeline" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {AGENT_LIFECYCLE_STAGES.map((stage) => {
            const stageAgents = (agents ?? []).filter(
              (a) => deriveLifecycleStage(a) === stage,
            );
            return (
              <div key={stage} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {AGENT_LIFECYCLE_LABELS[stage]}
                  </h3>
                  <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">
                    {stageAgents.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {stageAgents.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
                      No agents
                    </p>
                  ) : (
                    stageAgents.map((agent) => (
                      <Link
                        key={agent.id}
                        to={agentUrl(agent)}
                        className={cn(
                          "block rounded-md border border-border p-3 hover:bg-accent/30 transition-colors no-underline text-inherit space-y-2",
                          agent.status === "terminated" && "opacity-50",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm font-medium truncate">{agent.name}</span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {roleLabels[agent.role] ?? agent.role}
                        </div>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
                            stage === "production"
                              ? "bg-green-500/15 text-green-600 dark:text-green-400"
                              : stage === "pilot"
                                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                : stage === "draft"
                                  ? "bg-muted text-muted-foreground"
                                  : "bg-muted/50 text-muted-foreground line-through",
                          )}
                        >
                          {AGENT_LIFECYCLE_LABELS[stage]}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
  const isTerminated = node.status === "terminated";

  return (
    <div style={{ paddingLeft: depth * 24 }} className={cn(isTerminated && "opacity-50")}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit"
      >
        <span className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "flex items-center justify-center h-6 w-6 rounded-md",
              getRoleLevel(node.role) === "executive"
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : getRoleLevel(node.role) === "management"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-muted text-muted-foreground",
              getAgentRingClass(node.role, (agent as unknown as Record<string, unknown> | undefined)?.employmentType as string | undefined),
            )}
          >
            <AgentIcon icon={agent?.icon} className="h-3.5 w-3.5" />
          </span>
          <span className="relative flex h-2.5 w-2.5">
            <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
          </span>
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
                <EmploymentBadge type={(agent as unknown as Record<string, unknown>).employmentType as string ?? "full_time"} />
                <span className="text-xs text-muted-foreground font-mono w-14 text-right">
                  {adapterLabels[agent.adapterType] ?? agent.adapterType}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              <StatusBadge status={node.status} />
            </span>
            {isTerminated && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                Terminated
              </span>
            )}
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
