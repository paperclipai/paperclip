import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useT } from "../i18n";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { leaderProcessesApi, type LeaderProcessRow } from "../api/leader-processes";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bot, Plus, List, GitBranch, SlidersHorizontal, MoreHorizontal, Play, RotateCw, Square, Terminal, RefreshCw } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

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
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useT();
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
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: leaderProcesses } = useQuery({
    queryKey: queryKeys.leaderProcesses.list(selectedCompanyId!),
    queryFn: () => leaderProcessesApi.listForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const cliAliveSet = useMemo(() => {
    const set = new Set<string>();
    for (const proc of leaderProcesses ?? []) {
      if (proc.status === "running") set.add(proc.agentId);
    }
    return set;
  }, [leaderProcesses]);

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
    setBreadcrumbs([{ label: t("page.agents.title") }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message={t("agents.selectCompany")} />;
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
          <RestartAllLeadersButton companyId={selectedCompanyId} agents={agents ?? []} leaderProcesses={leaderProcesses ?? []} />
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
          message={t("agents.createFirst")}
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
                className={agent.pausedAt && tab !== "paused" ? "opacity-50" : ""}
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
                      <span className="text-xs text-muted-foreground font-mono w-40 text-right">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono w-20 text-right">
                        {agent.spentMonthlyCents > 0 ? `$${(agent.spentMonthlyCents / 100).toFixed(2)}` : "—"}
                      </span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                      </span>
                      <span className="w-20 flex justify-end">
                        {cliAliveSet.has(agent.id) ? (
                          <StatusBadge status="online" />
                        ) : (
                          <StatusBadge status={agent.status} />
                        )}
                      </span>
                      <AgentContextMenu
                        agent={agent}
                        companyId={selectedCompanyId!}
                        cliAlive={cliAliveSet.has(agent.id)}
                      />
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
            <OrgTreeNode key={node.id} node={node} depth={0} agentMap={agentMap} liveRunByAgent={liveRunByAgent} cliAliveSet={cliAliveSet} tab={tab} companyId={selectedCompanyId!} />
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
  cliAliveSet,
  tab,
  companyId,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  cliAliveSet: Set<string>;
  tab: FilterTab;
  companyId: string;
}) {
  const agent = agentMap.get(node.id);

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 6 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className={cn("flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit", agent?.pausedAt && tab !== "paused" && "opacity-50")}
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
                <span className="text-xs text-muted-foreground font-mono w-40 text-right">
                  {getAdapterLabel(agent.adapterType)}
                </span>
                <span className="text-xs text-muted-foreground font-mono w-20 text-right">
                  {agent.spentMonthlyCents > 0 ? `$${(agent.spentMonthlyCents / 100).toFixed(2)}` : "—"}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              {agent && cliAliveSet.has(agent.id) ? (
                <StatusBadge status="online" />
              ) : (
                <StatusBadge status={node.status} />
              )}
            </span>
            {agent && (
              <AgentContextMenu
                agent={agent}
                companyId={companyId}
                cliAlive={cliAliveSet.has(agent.id)}
              />
            )}
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} agentMap={agentMap} liveRunByAgent={liveRunByAgent} cliAliveSet={cliAliveSet} tab={tab} companyId={companyId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Restart all leader (claude_local) agents */
function RestartAllLeadersButton({
  companyId,
  agents,
  leaderProcesses,
}: {
  companyId: string;
  agents: Agent[];
  leaderProcesses: LeaderProcessRow[];
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [loading, setLoading] = useState(false);

  const leaders = agents.filter((a) => a.adapterType === "claude_local" && a.status !== "terminated");
  if (leaders.length === 0) return null;

  const runningSet = new Set(
    leaderProcesses.filter((p) => p.status === "running").map((p) => p.agentId),
  );
  const runningCount = leaders.filter((a) => runningSet.has(a.id)).length;

  const handleRestartAll = async () => {
    if (!confirm(`Restart all ${leaders.length} leader agents?`)) return;
    setLoading(true);
    let ok = 0;
    let fail = 0;
    for (const agent of leaders) {
      try {
        if (runningSet.has(agent.id)) {
          await leaderProcessesApi.restart(companyId, agent.id);
        } else {
          await leaderProcessesApi.start(companyId, agent.id);
        }
        ok++;
      } catch {
        fail++;
      }
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.leaderProcesses.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    pushToast({
      title: `Leaders: ${ok} started${fail ? `, ${fail} failed` : ""}`,
      tone: fail ? "error" : "success",
    });
    setLoading(false);
  };

  return (
    <Button size="sm" variant="outline" onClick={handleRestartAll} disabled={loading}>
      <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
      {loading ? "Restarting..." : `Restart Leaders (${runningCount}/${leaders.length})`}
    </Button>
  );
}

/** Context menu for individual agent actions */
function AgentContextMenu({
  agent,
  companyId,
  cliAlive,
}: {
  agent: Agent;
  companyId: string;
  cliAlive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const isLeader = agent.adapterType === "claude_local";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.leaderProcesses.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  };

  const startMutation = useMutation({
    mutationFn: () => leaderProcessesApi.start(companyId, agent.id),
    onSuccess: () => { invalidate(); pushToast({ title: `${agent.name} started`, tone: "success" }); },
    onError: (e: Error) => pushToast({ title: `Start failed: ${e.message}`, tone: "error" }),
  });

  const restartMutation = useMutation({
    mutationFn: () => leaderProcessesApi.restart(companyId, agent.id),
    onSuccess: () => { invalidate(); pushToast({ title: `${agent.name} restarted`, tone: "success" }); },
    onError: (e: Error) => pushToast({ title: `Restart failed: ${e.message}`, tone: "error" }),
  });

  const stopMutation = useMutation({
    mutationFn: () => leaderProcessesApi.stop(companyId, agent.id),
    onSuccess: () => { invalidate(); pushToast({ title: `${agent.name} stopped`, tone: "success" }); },
    onError: (e: Error) => pushToast({ title: `Stop failed: ${e.message}`, tone: "error" }),
  });

  const isMutating = startMutation.isPending || restartMutation.isPending || stopMutation.isPending;

  // Close menu on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!isLeader) return null;

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
          className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 w-44 border border-border bg-popover shadow-lg rounded-md py-1">
            {!cliAlive ? (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 disabled:opacity-50"
                disabled={isMutating}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); startMutation.mutate(); setOpen(false); }}
              >
                <Play className="h-3.5 w-3.5" />
                {startMutation.isPending ? "Starting..." : "Start"}
              </button>
            ) : (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 disabled:opacity-50"
                disabled={isMutating}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); restartMutation.mutate(); setOpen(false); }}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {restartMutation.isPending ? "Restarting..." : "Restart"}
              </button>
            )}
            {cliAlive && (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 text-destructive disabled:opacity-50"
                disabled={isMutating}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); stopMutation.mutate(); setOpen(false); }}
              >
                <Square className="h-3.5 w-3.5" />
                {stopMutation.isPending ? "Stopping..." : "Stop"}
              </button>
            )}
            <div className="border-t border-border my-1" />
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setLogOpen(true); setOpen(false); }}
            >
              <Terminal className="h-3.5 w-3.5" />
              Logs
            </button>
          </div>
        )}
      </div>
      {logOpen && (
        <AgentLogModal
          companyId={companyId}
          agent={agent}
          open={logOpen}
          onClose={() => setLogOpen(false)}
        />
      )}
    </>
  );
}

/** Modal showing live CLI logs */
function AgentLogModal({
  companyId,
  agent,
  open,
  onClose,
}: {
  companyId: string;
  agent: Agent;
  open: boolean;
  onClose: () => void;
}) {
  const [logKind, setLogKind] = useState<"out" | "err">("out");
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: logs, isLoading } = useQuery({
    queryKey: ["agent-logs", companyId, agent.id, logKind],
    queryFn: () => leaderProcessesApi.logs(companyId, agent.id, { kind: logKind, lines: 200 }),
    enabled: open,
    refetchInterval: 3000,
  });

  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (logs) scrollToBottom();
  }, [logs, scrollToBottom]);

  // Strip ANSI escape codes for clean display
  const cleanLines = (logs?.lines ?? []).map((line) =>
    line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[\d;]*m/g, ""),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            {agent.name} — CLI Logs
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-1 mb-2">
          <button
            className={cn(
              "px-2 py-1 text-xs rounded",
              logKind === "out" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => setLogKind("out")}
          >
            stdout
          </button>
          <button
            className={cn(
              "px-2 py-1 text-xs rounded",
              logKind === "err" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => setLogKind("err")}
          >
            stderr
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-black rounded-md p-3 font-mono text-xs text-green-400 leading-relaxed">
          {isLoading && <p className="text-muted-foreground">Loading...</p>}
          {cleanLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line || "\u00A0"}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </DialogContent>
    </Dialog>
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
