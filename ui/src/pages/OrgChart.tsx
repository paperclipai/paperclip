import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Network,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { costsApi } from "../api/costs";
import { issuesApi } from "../api/issues";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  const totalW = roots.reduce((sum, r) => sum + subtreeWidth(r), 0);
  const gaps = (roots.length - 1) * GAP_X;
  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  // Compute bounds and return
  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(
  nodes: LayoutNode[],
): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

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

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 4000,
  });

  const activeAgentIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of liveRuns ?? []) {
      if (r.status === "running" && r.agentId) s.add(r.agentId);
    }
    return s;
  }, [liveRuns]);

  const activeRunCount = activeAgentIds.size;

  const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
  const panelAgent = panelAgentId ? agentMap.get(panelAgentId) : undefined;

  const { data: panelIssues, isLoading: panelLoading } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      panelAgentId,
      "open",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeAgentId: panelAgentId!,
        status: "open",
      }),
    enabled: !!selectedCompanyId && !!panelAgentId,
  });

  const { data: agentCosts } = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!),
    queryFn: () => costsApi.byAgent(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const warningAgents = useMemo(() => {
    if (!agentCosts) return [];
    return agentCosts
      .map((c) => {
        const agent = agentMap.get(c.agentId);
        const budget = agent?.budgetMonthlyCents ?? 0;
        if (budget <= 0) return null;
        const pct = (c.costCents / budget) * 100;
        if (pct < 80) return null;
        return { id: c.agentId, name: c.agentName, pct };
      })
      .filter(Boolean) as { id: string; name: string; pct: number }[];
  }, [agentCosts, agentMap]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0,
      maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (
      hasInitialized.current ||
      allNodes.length === 0 ||
      !containerRef.current
    )
      return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Fit chart to container
    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // Don't drag if clicking a card
      const target = e.target as HTMLElement;
      if (target.closest("[data-org-card]")) return;
      setDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({
        x: dragStart.current.panX + dx,
        y: dragStart.current.panY + dy,
      });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);

      // Zoom toward mouse position
      const scale = newZoom / zoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Network}
        message="Select a company to view the org chart."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return (
      <EmptyState
        icon={Network}
        message="No organizational hierarchy defined."
      />
    );
  }

  return (
    <div className="relative flex flex-col h-full">
      <div className="mb-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import company
            </Button>
          </Link>
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export company
            </Button>
          </Link>
        </div>
        {activeRunCount > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-medium">
            <Zap className="h-3 w-3 animate-pulse" />
            {activeRunCount} agent{activeRunCount !== 1 ? "s" : ""} running
          </div>
        )}
      </div>
      {warningAgents.length > 0 && (
        <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs shrink-0 flex-wrap">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-amber-700 font-medium shrink-0">
            Budget warning:
          </span>
          {warningAgents.map((a) => (
            <span
              key={a.id}
              className={`px-2 py-0.5 rounded-full font-medium ${a.pct >= 95 ? "bg-red-500/15 text-red-600" : "bg-amber-500/15 text-amber-700"}`}
            >
              {a.name} {Math.round(a.pct)}%
            </span>
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Zoom controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
          <button
            className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
            onClick={() => {
              const newZoom = Math.min(zoom * 1.2, 2);
              const container = containerRef.current;
              if (container) {
                const cx = container.clientWidth / 2;
                const cy = container.clientHeight / 2;
                const scale = newZoom / zoom;
                setPan({
                  x: cx - scale * (cx - pan.x),
                  y: cy - scale * (cy - pan.y),
                });
              }
              setZoom(newZoom);
            }}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
            onClick={() => {
              const newZoom = Math.max(zoom * 0.8, 0.2);
              const container = containerRef.current;
              if (container) {
                const cx = container.clientWidth / 2;
                const cy = container.clientHeight / 2;
                const scale = newZoom / zoom;
                setPan({
                  x: cx - scale * (cx - pan.x),
                  y: cy - scale * (cy - pan.y),
                });
              }
              setZoom(newZoom);
            }}
            aria-label="Zoom out"
          >
            &minus;
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-[10px] hover:bg-accent transition-colors"
            onClick={() => {
              if (!containerRef.current) return;
              const cW = containerRef.current.clientWidth;
              const cH = containerRef.current.clientHeight;
              const scaleX = (cW - 40) / bounds.width;
              const scaleY = (cH - 40) / bounds.height;
              const fitZoom = Math.min(scaleX, scaleY, 1);
              const chartW = bounds.width * fitZoom;
              const chartH = bounds.height * fitZoom;
              setZoom(fitZoom);
              setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
            }}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            Fit
          </button>
        </div>

        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;
              const isHot =
                activeAgentIds.has(parent.id) || activeAgentIds.has(child.id);
              const edgePath = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;

              return (
                <g key={`${parent.id}-${child.id}`}>
                  <path
                    d={edgePath}
                    fill="none"
                    stroke={isHot ? "var(--color-primary)" : "var(--border)"}
                    strokeWidth={isHot ? 2 : 1.5}
                    strokeOpacity={isHot ? 0.4 : 1}
                  />
                  {isHot && (
                    <circle r={4} fill="var(--color-primary)" opacity={0.85}>
                      <animateMotion
                        dur="1.6s"
                        repeatCount="indefinite"
                        path={edgePath}
                      />
                    </circle>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Card layer */}
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;
            const isRunning = activeAgentIds.has(node.id);

            return (
              <div
                key={node.id}
                data-org-card
                className={[
                  "absolute bg-card border rounded-lg shadow-sm hover:shadow-md transition-[box-shadow,border-color] duration-150 cursor-pointer select-none",
                  isRunning
                    ? "border-primary/50 shadow-primary/10"
                    : "border-border hover:border-foreground/20",
                ].join(" ")}
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                }}
                onClick={() => setPanelAgentId(node.id)}
              >
                {isRunning && (
                  <div className="h-0.5 w-full rounded-t-lg bg-primary/60 animate-pulse" />
                )}
                <div className="flex items-center px-4 py-3 gap-3">
                  {/* Agent icon + status dot */}
                  <div className="relative shrink-0">
                    <div
                      className={[
                        "w-9 h-9 rounded-full flex items-center justify-center",
                        isRunning ? "bg-primary/10" : "bg-muted",
                      ].join(" ")}
                    >
                      <AgentIcon
                        icon={agent?.icon}
                        className={[
                          "h-4.5 w-4.5",
                          isRunning ? "text-primary" : "text-foreground/70",
                        ].join(" ")}
                      />
                    </div>
                    <span
                      className={[
                        "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card",
                        isRunning ? "animate-pulse" : "",
                      ].join(" ")}
                      style={{
                        backgroundColor: isRunning
                          ? "var(--color-primary)"
                          : dotColor,
                      }}
                    />
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {node.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      {agent?.title ?? roleLabel(node.role)}
                    </span>
                    {agent && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
                        {adapterLabels[agent.adapterType] ?? agent.adapterType}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Agent open-issues panel */}
      {panelAgentId && (
        <div className="absolute top-0 right-0 h-full w-80 bg-card border-l border-border flex flex-col shadow-lg z-20">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-foreground truncate">
                {panelAgent?.name ?? "Agent"}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {panelAgent?.title ?? ""}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              <a
                href={`/agents/${panelAgentId}`}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Open agent page"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                onClick={() => setPanelAgentId(null)}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Issue list */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {panelLoading ? (
              <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
                Loading…
              </div>
            ) : !panelIssues || panelIssues.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
                No open issues
              </div>
            ) : (
              <ul className="space-y-1">
                {panelIssues.map((issue) => (
                  <li key={issue.id}>
                    <a
                      href={`/issues/${issue.id}`}
                      className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-muted transition-colors group"
                    >
                      <span
                        className={[
                          "mt-0.5 shrink-0 h-2 w-2 rounded-full",
                          issue.priority === "critical"
                            ? "bg-red-500"
                            : issue.priority === "high"
                              ? "bg-orange-400"
                              : issue.priority === "medium"
                                ? "bg-yellow-400"
                                : "bg-muted-foreground/40",
                        ].join(" ")}
                      />
                      <span className="text-xs text-foreground leading-snug group-hover:text-primary transition-colors line-clamp-3">
                        {issue.title}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
