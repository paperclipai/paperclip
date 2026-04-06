import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { issuesApi } from "../api/issues";
import { hiringApi } from "../api/hiring";
import { expertiseMapApi, type AgentExpertiseProfile } from "../api/expertiseMap";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Copy, Download, Network, Upload, UserPlus, Users } from "lucide-react";
import { AGENT_ROLE_LABELS, DEPARTMENT_LABELS, type Agent, type Issue } from "@ironworksai/shared";
import { getRoleLevel, getAgentRingClass } from "../lib/role-icons";
import { cn } from "../lib/utils";

// Layout constants
const CARD_MIN_W = 260;
const CARD_MAX_W = 360;
const CARD_W = 320;
const CARD_H = 130;
const GAP_X = 56;
const GAP_Y = 100;
const PADDING = 80;

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
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
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
  ollama_cloud: "Ollama Cloud",
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

const departmentBorderColor: Record<string, string> = {
  executive: "border-l-amber-500/40",
  engineering: "border-l-blue-500/40",
  design: "border-l-purple-500/40",
  operations: "border-l-emerald-500/40",
  finance: "border-l-green-500/40",
  security: "border-l-red-500/40",
  research: "border-l-cyan-500/40",
  marketing: "border-l-pink-500/40",
  support: "border-l-orange-500/40",
  compliance: "border-l-indigo-500/40",
  hr: "border-l-violet-500/40",
};

const departmentSvgColor: Record<string, string> = {
  executive: "rgba(245,158,11,0.04)",
  engineering: "rgba(59,130,246,0.04)",
  design: "rgba(168,85,247,0.04)",
  operations: "rgba(16,185,129,0.04)",
  finance: "rgba(34,197,94,0.04)",
  security: "rgba(239,68,68,0.04)",
  research: "rgba(6,182,212,0.04)",
  marketing: "rgba(236,72,153,0.04)",
  support: "rgba(249,115,22,0.04)",
  compliance: "rgba(99,102,241,0.04)",
  hr: "rgba(139,92,246,0.04)",
};

const departmentLabels = DEPARTMENT_LABELS as Record<string, string>;

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

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: skillMap } = useQuery({
    queryKey: ["expertise-map", "skills", selectedCompanyId!] as const,
    queryFn: () => expertiseMapApi.skills(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 120_000,
  });

  // Hiring requests for vacant position placeholders (12.14)
  const { data: hiringRequests } = useQuery({
    queryKey: queryKeys.hiring.list(selectedCompanyId!),
    queryFn: () => hiringApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const skillsByAgent = useMemo(() => {
    const map = new Map<string, AgentExpertiseProfile>();
    for (const agent of skillMap?.agents ?? []) {
      map.set(agent.agentId, agent);
    }
    return map;
  }, [skillMap]);

  // Mock data for local dev preview when no agents exist
  const MOCK_ORG: OrgNode[] = [
    { id: "m-ceo", name: "CEO", role: "ceo", status: "active", reports: [
      { id: "m-cto", name: "CTO", role: "cto", status: "active", reports: [
        { id: "m-eng", name: "SeniorEngineer", role: "engineer", status: "active", reports: [] },
        { id: "m-devops", name: "DevOpsEngineer", role: "engineer", status: "active", reports: [] },
        { id: "m-sec", name: "SecurityEngineer", role: "engineer", status: "active", reports: [] },
      ]},
      { id: "m-cfo", name: "CFO", role: "cfo", status: "active", reports: [] },
      { id: "m-cmo", name: "CMO", role: "cmo", status: "active", reports: [
        { id: "m-content", name: "ContentMarketer", role: "marketer", status: "active", reports: [] },
      ]},
      { id: "m-vphr", name: "VPofHR", role: "director", status: "active", reports: [] },
      { id: "m-legal", name: "LegalCounsel", role: "director", status: "active", reports: [] },
      { id: "m-comp", name: "ComplianceDirector", role: "director", status: "active", reports: [] },
      { id: "m-ux", name: "UXDesigner", role: "designer", status: "idle", reports: [] },
    ]},
  ];
  const MOCK_AGENTS: Agent[] = [
    { id: "m-ceo", name: "CEO", role: "ceo", title: "Chief Executive Officer", status: "active", icon: "crown", adapterType: "ollama_cloud", adapterConfig: { model: "kimi-k2.5:cloud" } },
    { id: "m-cto", name: "CTO", role: "cto", title: "Chief Technology Officer", status: "active", icon: "code", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-cfo", name: "CFO", role: "cfo", title: "Chief Financial Officer", status: "active", icon: "dollar-sign", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-cmo", name: "CMO", role: "cmo", title: "Chief Marketing Officer", status: "active", icon: "megaphone", adapterType: "ollama_cloud", adapterConfig: { model: "kimi-k2.5:cloud" } },
    { id: "m-vphr", name: "VPofHR", role: "director", title: "VP of Human Resources", status: "active", icon: "users", adapterType: "ollama_cloud", adapterConfig: { model: "qwen3.5:27b-cloud" } },
    { id: "m-legal", name: "LegalCounsel", role: "director", title: "Legal Counsel", status: "active", icon: "gavel", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-comp", name: "ComplianceDirector", role: "director", title: "Compliance Director", status: "active", icon: "scale", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-eng", name: "SeniorEngineer", role: "engineer", title: "Senior Full-Stack Engineer", status: "active", icon: "terminal", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-devops", name: "DevOpsEngineer", role: "engineer", title: "DevOps & Infrastructure Engineer", status: "active", icon: "server", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-sec", name: "SecurityEngineer", role: "engineer", title: "Application Security Engineer", status: "active", icon: "shield", adapterType: "ollama_cloud", adapterConfig: { model: "deepseek-v3.2:cloud" } },
    { id: "m-ux", name: "UXDesigner", role: "designer", title: "UX Designer", status: "idle", icon: "palette", adapterType: "ollama_cloud", adapterConfig: { model: "kimi-k2.5:cloud" } },
    { id: "m-content", name: "ContentMarketer", role: "marketer", title: "Content Marketer", status: "active", icon: "pen-line", adapterType: "ollama_cloud", adapterConfig: { model: "qwen3.5:27b-cloud" } },
  ] as unknown as Agent[];

  const useMockData = !orgTree || orgTree.length === 0;
  const effectiveOrg = useMockData ? MOCK_ORG : orgTree ?? [];
  const effectiveAgents = useMockData ? MOCK_AGENTS : agents ?? [];

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of effectiveAgents) m.set(a.id, a);
    return m;
  }, [effectiveAgents]);

  // Active task count per agent for workload badges
  const taskCountByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of (issues ?? []) as Issue[]) {
      if (issue.assigneeAgentId && (issue.status === "in_progress" || issue.status === "todo")) {
        map.set(issue.assigneeAgentId, (map.get(issue.assigneeAgentId) ?? 0) + 1);
      }
    }
    return map;
  }, [issues]);

  // Performance score per agent for hover mini-profiles
  const perfScoreByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of effectiveAgents) {
      const agentIssues = (issues ?? []).filter((i: Issue) => i.assigneeAgentId === a.id);
      const done = agentIssues.filter((i: Issue) => i.status === "done").length;
      const total = agentIssues.length;
      if (total > 0) map.set(a.id, Math.round((done / total) * 100));
    }
    return map;
  }, [issues, effectiveAgents]);

  // Hover card state
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(effectiveOrg), [effectiveOrg]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Department grouping for background rects
  const departmentGroups = useMemo(() => {
    const groups = new Map<string, { nodes: LayoutNode[]; dept: string }>();
    for (const node of allNodes) {
      const agent = agentMap.get(node.id);
      const dept = (agent as unknown as Record<string, unknown> | undefined)?.department as string | undefined;
      if (dept) {
        if (!groups.has(dept)) groups.set(dept, { nodes: [], dept });
        groups.get(dept)!.nodes.push(node);
      }
    }
    return Array.from(groups.values()).filter((g) => g.nodes.length > 1);
  }, [allNodes, agentMap]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
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
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
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
  }, [zoom, pan]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div className="flex flex-col -mx-4 -mt-3 -mb-3" style={{ height: "calc(100vh - 40px)", width: "calc(100% + 2rem)" }}>
    <div className="mb-2 flex items-center justify-start gap-2 shrink-0">
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const svgEl = containerRef.current?.querySelector("svg");
          if (!svgEl) return;
          const svgData = new XMLSerializer().serializeToString(svgEl);
          navigator.clipboard.writeText(svgData).catch(() => {});
        }}
      >
        <Copy className="mr-1.5 h-3.5 w-3.5" />
        Copy SVG
      </Button>
    </div>
    <div
      ref={containerRef}
      className="w-full flex-1 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
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
              setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
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
              setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
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

      {/* Minimap overlay (12.14) */}
      {allNodes.length > 5 && (
        <div className="absolute bottom-3 left-3 z-10 w-36 h-24 rounded border border-border bg-background/80 backdrop-blur-sm overflow-hidden pointer-events-none">
          <svg width="100%" height="100%" viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="xMidYMid meet">
            {/* Minimap edges */}
            {edges.map(({ parent, child }) => (
              <line
                key={`mm-${parent.id}-${child.id}`}
                x1={parent.x + CARD_W / 2}
                y1={parent.y + CARD_H / 2}
                x2={child.x + CARD_W / 2}
                y2={child.y + CARD_H / 2}
                stroke="var(--border)"
                strokeWidth={3}
              />
            ))}
            {/* Minimap nodes */}
            {allNodes.map((node) => (
              <rect
                key={`mm-${node.id}`}
                x={node.x}
                y={node.y}
                width={CARD_W}
                height={CARD_H}
                rx={4}
                fill="var(--primary)"
                opacity={0.4}
              />
            ))}
            {/* Viewport indicator */}
            {containerRef.current && (
              <rect
                x={-pan.x / zoom}
                y={-pan.y / zoom}
                width={containerRef.current.clientWidth / zoom}
                height={containerRef.current.clientHeight / zoom}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={4}
                rx={4}
                opacity={0.6}
              />
            )}
          </svg>
        </div>
      )}

      {/* SVG layer for edges */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{
          width: "100%",
          height: "100%",
        }}
      >
        {/* Background grid for blueprint feel (12.14) */}
        <defs>
          <pattern id="blueprint-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--border)" strokeWidth="0.3" opacity="0.5" />
          </pattern>
          <pattern id="blueprint-grid-major" width="200" height="200" patternUnits="userSpaceOnUse">
            <path d="M 200 0 L 0 0 0 200" fill="none" stroke="var(--border)" strokeWidth="0.6" opacity="0.3" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#blueprint-grid)" />
        <rect width="100%" height="100%" fill="url(#blueprint-grid-major)" />

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Department background groupings */}
          {departmentGroups.map(({ nodes: dNodes, dept }) => {
            const pad = 20;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of dNodes) {
              minX = Math.min(minX, n.x);
              minY = Math.min(minY, n.y);
              maxX = Math.max(maxX, n.x + CARD_W);
              maxY = Math.max(maxY, n.y + CARD_H);
            }
            const deptColor = departmentSvgColor[dept] ?? "rgba(100,100,100,0.04)";
            return (
              <g key={`dept-bg-${dept}`}>
                <rect
                  x={minX - pad}
                  y={minY - pad - 16}
                  width={maxX - minX + pad * 2}
                  height={maxY - minY + pad * 2 + 16}
                  rx={12}
                  fill={deptColor}
                  stroke="none"
                />
                <text
                  x={minX - pad + 8}
                  y={minY - pad - 4}
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--muted-foreground)"
                  opacity={0.6}
                  style={{ textTransform: "uppercase" as const, letterSpacing: "0.05em" }}
                >
                  {departmentLabels[dept] ?? dept}
                </text>
              </g>
            );
          })}
          {/* Curved bezier connecting lines */}
          {edges.map(({ parent, child }) => {
            const x1 = parent.x + CARD_W / 2;
            const y1 = parent.y + CARD_H;
            const x2 = child.x + CARD_W / 2;
            const y2 = child.y;
            const cy1 = y1 + (y2 - y1) * 0.5;
            const cy2 = y2 - (y2 - y1) * 0.5;

            return (
              <path
                key={`${parent.id}-${child.id}`}
                d={`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
              />
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
          const empType = (agent as unknown as Record<string, unknown> | undefined)?.employmentType as string | undefined;
          const dept = (agent as unknown as Record<string, unknown> | undefined)?.department as string | undefined;
          const isContractor = empType === "contractor";
          const activeTasks = taskCountByAgent.get(node.id) ?? 0;
          const isHovered = hoveredNode === node.id;

          return (
            <div
              key={node.id}
              data-org-card
              className={cn(
                "absolute bg-card rounded-xl shadow-sm shadow-black/5 hover:shadow-lg hover:border-foreground/20 transition-all duration-200 cursor-pointer select-none border-l-[3px]",
                isContractor ? "border border-dashed border-amber-400/50" : "border border-border",
                dept && departmentBorderColor[dept] ? departmentBorderColor[dept] : "border-l-border",
              )}
              style={{
                left: node.x,
                top: node.y,
                width: CARD_W,
                minHeight: CARD_H,
              }}
              onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
              onMouseEnter={() => {
                if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
                hoverTimeout.current = setTimeout(() => setHoveredNode(node.id), 300);
              }}
              onMouseLeave={() => {
                if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
                setHoveredNode(null);
              }}
            >
              {/* Workload badge */}
              {activeTasks > 0 && (
                <span className="absolute -top-2 -right-2 flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-blue-500 text-white text-[10px] font-bold shadow-sm z-10">
                  {activeTasks}
                </span>
              )}
              <div className="flex items-start px-4 py-4 gap-3">
                {/* Agent icon + status dot */}
                <div className="relative shrink-0">
                  <div className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center mt-0.5",
                    getRoleLevel(node.role) === "executive"
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : getRoleLevel(node.role) === "management"
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "bg-muted text-foreground/70",
                    getAgentRingClass(node.role, empType),
                  )}>
                    <AgentIcon icon={agent?.icon} className="h-5 w-5" />
                  </div>
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                    style={{ backgroundColor: dotColor }}
                  />
                </div>
                {/* Name + role + badges + model */}
                <div className="flex flex-col items-start min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {node.name}
                    </span>
                    {/* Role level badge */}
                    {getRoleLevel(node.role) === "executive" && (
                      <span className="text-[8px] font-semibold px-1 py-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 leading-tight">C</span>
                    )}
                    {getRoleLevel(node.role) === "management" && (
                      <span className="text-[8px] font-semibold px-1 py-0 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 leading-tight">M</span>
                    )}
                    {getRoleLevel(node.role) === "staff" && !isContractor && (
                      <span className="text-[8px] font-semibold px-1 py-0 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 leading-tight">FTE</span>
                    )}
                    {isContractor && (
                      <span className="text-[8px] font-semibold px-1 py-0 rounded-full border border-dashed border-amber-400/60 text-amber-500 leading-tight">CTR</span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                    {agent?.title ?? roleLabel(node.role)}
                  </span>
                  {dept && (
                    <span className="text-[10px] text-muted-foreground/50 leading-tight mt-0.5">
                      {departmentLabels[dept] ?? dept}
                    </span>
                  )}
                  {agent && (() => {
                    const modelRaw = agent.adapterConfig?.model as string | undefined;
                    const modelName = modelRaw ? modelRaw.replace(/:cloud$/, "") : null;
                    const provider = adapterLabels[agent.adapterType] ?? agent.adapterType;
                    return (
                      <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1.5">
                        {provider}{modelName ? ` - ${modelName}` : ""}
                      </span>
                    );
                  })()}
                  {/* Span of control metric for managers (12.14) */}
                  {node.children.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 mt-1">
                      <Users className="h-2.5 w-2.5" />
                      {node.children.length} report{node.children.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {/* Skill tags from expertise map */}
                  {(() => {
                    const profile = skillsByAgent.get(node.id);
                    if (!profile || profile.topSkills.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-0.5 mt-1">
                        {profile.topSkills.slice(0, 2).map((sk) => (
                          <span
                            key={sk.labelId}
                            className="inline-flex items-center gap-0.5 text-[8px] px-1 py-0 rounded bg-muted/50 text-muted-foreground/70"
                          >
                            <span className="w-1 h-1 rounded-full shrink-0" style={{ backgroundColor: sk.labelColor }} />
                            {sk.labelName}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
              {/* Hover mini-profile card */}
              {isHovered && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 w-56 bg-popover border border-border rounded-lg shadow-lg p-3 space-y-2 pointer-events-none"
                  style={{ transformOrigin: "top center" }}
                >
                  <div className="text-xs font-semibold">{node.name}</div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-[10px] text-muted-foreground">Active</div>
                      <div className="text-sm font-bold tabular-nums">{activeTasks}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Score</div>
                      <div className="text-sm font-bold tabular-nums">
                        {perfScoreByAgent.get(node.id) !== undefined ? `${perfScoreByAgent.get(node.id)}%` : "-"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Tenure</div>
                      <div className="text-sm font-bold tabular-nums">
                        {agent && (agent as unknown as Record<string, unknown>).createdAt
                          ? relativeTime(new Date((agent as unknown as Record<string, unknown>).createdAt as string))
                          : "-"}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    {/* Vacant position placeholders for open hiring requests (12.14) */}
    {(hiringRequests ?? []).filter((h: { status: string }) => h.status === "pending" || h.status === "pending_approval").length > 0 && (
      <div className="absolute bottom-3 right-3 z-10 max-w-xs print:hidden">
        <div className="rounded-lg border border-dashed border-amber-400/50 bg-amber-50/50 dark:bg-amber-900/10 p-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <UserPlus className="h-3 w-3" />
            Open Positions
          </p>
          {(hiringRequests ?? [])
            .filter((h: { status: string }) => h.status === "pending" || h.status === "pending_approval")
            .slice(0, 4)
            .map((h: { id: string; role: string; title?: string }) => (
              <div key={h.id} className="flex items-center gap-2 text-xs">
                <div className="h-6 w-6 rounded-full border-2 border-dashed border-amber-400/50 flex items-center justify-center">
                  <UserPlus className="h-3 w-3 text-amber-400/50" />
                </div>
                <span className="text-muted-foreground">{h.title ?? roleLabel(h.role)}</span>
              </div>
            ))}
        </div>
      </div>
    )}
    </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
