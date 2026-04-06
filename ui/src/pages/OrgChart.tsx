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
import { Download, Network, Upload, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

// ── Layout constants ────────────────────────────────────────────────────
const CARD_W = 220;
const CARD_H = 120;
const GAP_X = 48;
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
  depth: number;
  index: number;
  children: LayoutNode[];
}

// ── Layout algorithm ────────────────────────────────────────────────────

let globalIndex = 0;

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number, depth: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];
  const nodeIndex = globalIndex++;

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y, depth + 1));
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
    depth,
    index: nodeIndex,
    children: layoutChildren,
  };
}

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  globalIndex = 0;
  if (roots.length === 0) return [];
  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y, 0));
    x += w + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

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

// ── Status colors ──────────────────────────────────────────────────────

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

const statusConfig: Record<string, { color: string; glow: string; label: string }> = {
  running: { color: "#22d3ee", glow: "0 0 12px rgba(34,211,238,0.5)", label: "Running" },
  active: { color: "#4ade80", glow: "0 0 12px rgba(74,222,128,0.5)", label: "Active" },
  paused: { color: "#facc15", glow: "0 0 12px rgba(250,204,21,0.4)", label: "Paused" },
  idle: { color: "#facc15", glow: "0 0 8px rgba(250,204,21,0.3)", label: "Idle" },
  error: { color: "#f87171", glow: "0 0 12px rgba(248,113,113,0.5)", label: "Error" },
  terminated: { color: "#6b7280", glow: "none", label: "Terminated" },
};
const defaultStatus = { color: "#6b7280", glow: "none", label: "Unknown" };

// Depth-based accent colors for card borders
const depthAccents = [
  "rgba(6,182,212,0.5)",   // cyan — CEO level
  "rgba(139,92,246,0.4)",  // violet — VP level
  "rgba(59,130,246,0.35)", // blue — Director level
  "rgba(16,185,129,0.3)",  // emerald — Manager level
  "rgba(245,158,11,0.25)", // amber — IC level
];

function getDepthAccent(depth: number): string {
  return depthAccents[Math.min(depth, depthAccents.length - 1)];
}

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
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

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan & zoom
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  // Entrance animation
  useEffect(() => {
    if (allNodes.length > 0) {
      const timer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(timer);
    }
  }, [allNodes.length]);

  // Center chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const scaleX = (containerW - 60) / bounds.width;
    const scaleY = (containerH - 60) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (containerW - chartW) / 2, y: (containerH - chartH) / 2 });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
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

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, 0.15), 2.5);
    const scale = newZoom / zoom;
    setPan({ x: mouseX - scale * (mouseX - pan.x), y: mouseY - scale * (mouseY - pan.y) });
    setZoom(newZoom);
  }, [zoom, pan]);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 60) / bounds.width;
    const scaleY = (cH - 60) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  const zoomTo = useCallback((factor: number) => {
    const newZoom = Math.min(Math.max(zoom * factor, 0.15), 2.5);
    const container = containerRef.current;
    if (container) {
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      const scale = newZoom / zoom;
      setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
    }
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
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="mb-3 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-[var(--font-mono)]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[var(--status-active)] animate-pulse" />
            {allNodes.length} agent{allNodes.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import
            </Button>
          </Link>
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export
            </Button>
          </Link>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="w-full flex-1 min-h-0 relative rounded-[2px] border border-border"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          background: "radial-gradient(ellipse at 50% 0%, rgba(6,182,212,0.04) 0%, transparent 60%), var(--background)",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Subtle grid background */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(6,182,212,0.5) 1px, transparent 1px),
              linear-gradient(90deg, rgba(6,182,212,0.5) 1px, transparent 1px)
            `,
            backgroundSize: "40px 40px",
          }}
        />

        {/* Zoom controls — floating glass panel */}
        <div className="absolute top-4 right-4 z-10 flex flex-col gap-1 rounded-[4px] border border-border/60 bg-background/80 backdrop-blur-md p-1 shadow-lg">
          <button
            className="w-8 h-8 flex items-center justify-center rounded-[2px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200"
            onClick={() => zoomTo(1.25)}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-[2px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200"
            onClick={() => zoomTo(0.8)}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <div className="h-px bg-border/60 mx-1" />
          <button
            className="w-8 h-8 flex items-center justify-center rounded-[2px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all duration-200"
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          <div className="h-px bg-border/60 mx-1" />
          <div className="px-1.5 py-1 text-center text-[10px] font-[var(--font-mono)] text-muted-foreground/70">
            {Math.round(zoom * 100)}%
          </div>
        </div>

        {/* SVG layer — animated edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: "100%", height: "100%" }}
        >
          <defs>
            {/* Animated gradient for flowing edges */}
            <linearGradient id="edge-gradient-flow" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(6,182,212,0.6)">
                <animate attributeName="stop-color" values="rgba(6,182,212,0.6);rgba(139,92,246,0.6);rgba(6,182,212,0.6)" dur="4s" repeatCount="indefinite" />
              </stop>
              <stop offset="50%" stopColor="rgba(139,92,246,0.4)">
                <animate attributeName="stop-color" values="rgba(139,92,246,0.4);rgba(6,182,212,0.4);rgba(139,92,246,0.4)" dur="4s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="rgba(6,182,212,0.3)">
                <animate attributeName="stop-color" values="rgba(6,182,212,0.3);rgba(139,92,246,0.3);rgba(6,182,212,0.3)" dur="4s" repeatCount="indefinite" />
              </stop>
            </linearGradient>

            {/* Glow filter for edges */}
            <filter id="edge-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Particle traveling along edge */}
            {edges.map(({ parent, child }, i) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;
              return (
                <path
                  key={`path-def-${parent.id}-${child.id}`}
                  id={`edgePath-${i}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="none"
                />
              );
            })}
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Edge glow background layer */}
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;
              const isHighlighted = hoveredNode === parent.id || hoveredNode === child.id;

              return (
                <path
                  key={`glow-${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke={isHighlighted ? "rgba(6,182,212,0.3)" : "rgba(6,182,212,0.08)"}
                  strokeWidth={isHighlighted ? 6 : 4}
                  filter={isHighlighted ? "url(#edge-glow)" : undefined}
                  style={{ transition: "stroke 0.4s ease, stroke-width 0.4s ease" }}
                />
              );
            })}

            {/* Main edges */}
            {edges.map(({ parent, child }, i) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;
              const isHighlighted = hoveredNode === parent.id || hoveredNode === child.id;
              const pathD = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;

              return (
                <g key={`edge-${parent.id}-${child.id}`}>
                  <path
                    d={pathD}
                    fill="none"
                    stroke={isHighlighted ? "url(#edge-gradient-flow)" : "rgba(6,182,212,0.2)"}
                    strokeWidth={isHighlighted ? 2 : 1.5}
                    strokeDasharray={isHighlighted ? "none" : "none"}
                    style={{
                      transition: "stroke 0.4s ease, stroke-width 0.4s ease",
                      opacity: mounted ? 1 : 0,
                      transitionDelay: `${i * 80}ms`,
                    }}
                  />
                  {/* Traveling particle dot */}
                  <circle r={isHighlighted ? 3.5 : 2.5} fill="rgba(6,182,212,0.8)" style={{ opacity: mounted ? 0.8 : 0 }}>
                    <animateMotion
                      dur={`${3 + (i % 3)}s`}
                      repeatCount="indefinite"
                      path={pathD}
                    />
                  </circle>
                  {/* Connection node dots at corners */}
                  <circle cx={x1} cy={midY} r={2} fill="rgba(6,182,212,0.3)" style={{ opacity: mounted ? 1 : 0 }} />
                  <circle cx={x2} cy={midY} r={2} fill="rgba(6,182,212,0.3)" style={{ opacity: mounted ? 1 : 0 }} />
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
            const status = statusConfig[node.status] ?? defaultStatus;
            const isHovered = hoveredNode === node.id;
            const accentColor = getDepthAccent(node.depth);
            const isRunning = node.status === "running" || node.status === "active";

            return (
              <div
                key={node.id}
                data-org-card
                className="absolute select-none cursor-pointer group"
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                  opacity: mounted ? 1 : 0,
                  transform: mounted
                    ? "translateY(0) scale(1)"
                    : "translateY(20px) scale(0.95)",
                  transition: `opacity 0.5s ease ${node.index * 100}ms, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${node.index * 100}ms`,
                }}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
              >
                {/* Outer glow ring on hover */}
                <div
                  className="absolute -inset-[1px] rounded-[4px] transition-opacity duration-300"
                  style={{
                    opacity: isHovered ? 1 : 0,
                    background: `linear-gradient(135deg, ${accentColor}, transparent, ${accentColor})`,
                    filter: "blur(4px)",
                  }}
                />

                {/* Card body */}
                <div
                  className="relative rounded-[4px] border bg-card/95 backdrop-blur-sm transition-all duration-300"
                  style={{
                    borderColor: isHovered ? accentColor : "var(--border)",
                    boxShadow: isHovered
                      ? `0 8px 32px rgba(0,0,0,0.3), 0 0 20px ${accentColor}, inset 0 1px 0 rgba(255,255,255,0.05)`
                      : "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.03)",
                  }}
                >
                  {/* Top accent bar */}
                  <div
                    className="h-[2px] rounded-t-[4px] transition-all duration-300"
                    style={{
                      background: isHovered
                        ? `linear-gradient(90deg, transparent, ${accentColor}, transparent)`
                        : `linear-gradient(90deg, transparent, ${accentColor.replace(/[\d.]+\)$/, '0.2)')}, transparent)`,
                    }}
                  />

                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* Avatar with status ring */}
                      <div className="relative shrink-0 mt-0.5">
                        {/* Animated ring for running agents */}
                        {isRunning && (
                          <div
                            className="absolute -inset-1 rounded-full animate-spin"
                            style={{
                              animationDuration: "3s",
                              background: `conic-gradient(from 0deg, transparent 0%, ${status.color} 30%, transparent 60%)`,
                              opacity: 0.4,
                            }}
                          />
                        )}
                        <div
                          className="relative w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300"
                          style={{
                            background: isHovered
                              ? `linear-gradient(135deg, rgba(6,182,212,0.15), rgba(139,92,246,0.1))`
                              : "var(--muted)",
                            boxShadow: isHovered ? `0 0 12px ${accentColor}` : "none",
                          }}
                        >
                          <AgentIcon icon={agent?.icon} className="h-5 w-5 text-foreground/70" />
                        </div>
                        {/* Status dot with pulse */}
                        <span
                          className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card"
                          style={{
                            backgroundColor: status.color,
                            boxShadow: status.glow,
                          }}
                        >
                          {isRunning && (
                            <span
                              className="absolute inset-0 rounded-full animate-ping"
                              style={{ backgroundColor: status.color, opacity: 0.4 }}
                            />
                          )}
                        </span>
                      </div>

                      {/* Info */}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-[var(--font-display)] uppercase tracking-[0.06em] text-foreground leading-tight truncate">
                          {node.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground leading-tight mt-0.5 truncate">
                          {agent?.title ?? roleLabel(node.role)}
                        </span>

                        {/* Adapter badge */}
                        {agent && (
                          <div className="mt-2 flex items-center gap-1.5">
                            <span
                              className="inline-flex items-center rounded-[2px] px-1.5 py-0.5 text-[9px] font-[var(--font-mono)] uppercase tracking-wider"
                              style={{
                                backgroundColor: `${accentColor.replace(/[\d.]+\)$/, '0.1)')}`,
                                color: accentColor.replace(/[\d.]+\)$/, '0.9)'),
                                border: `1px solid ${accentColor.replace(/[\d.]+\)$/, '0.2)')}`,
                              }}
                            >
                              {adapterLabels[agent.adapterType] ?? agent.adapterType}
                            </span>
                            <span
                              className="inline-flex items-center rounded-[2px] px-1.5 py-0.5 text-[9px] font-[var(--font-mono)]"
                              style={{
                                backgroundColor: `${status.color}15`,
                                color: status.color,
                              }}
                            >
                              {status.label}
                            </span>
                          </div>
                        )}

                        {/* Capabilities preview */}
                        {agent?.capabilities && (
                          <span className="text-[10px] text-muted-foreground/60 leading-tight mt-1.5 line-clamp-1">
                            {agent.capabilities}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Bottom shimmer bar on hover */}
                  <div
                    className="h-[1px] transition-opacity duration-500"
                    style={{
                      opacity: isHovered ? 1 : 0,
                      background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
