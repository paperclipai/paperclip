import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useContentWidth } from "../components/Layout";
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn, formatCents, formatTokens, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Network,
  X,
  Play,
  Pause,
  Clock,
  CheckCircle2,
  XCircle,
  Timer,
  Zap,
  Cpu,
  DollarSign,
  ArrowRight,
  Loader2,
  Moon,
  AlertTriangle,
  CircleSlash,
  ShieldQuestion,
  MessageSquare,
  Plus,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type HeartbeatRun, type AgentRuntimeState, type Issue } from "@paperclipai/shared";

// ── Layout constants ─────────────────────────────────────────────────────
const CARD_W = 248;
const CARD_H = 136;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;
const INSPECTOR_W = 380;
const MINIMAP_W = 180;
const MINIMAP_H = 120;

// ── Tree layout types ────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

// ── Layout algorithm ─────────────────────────────────────────────────────

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

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

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];

  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
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

/** Collect IDs of a node and all its ancestors/descendants for edge highlighting. */
function collectConnectedIds(nodeId: string, layout: LayoutNode[]): Set<string> {
  const ids = new Set<string>();

  function findAncestors(target: string, current: LayoutNode, path: string[]): boolean {
    if (current.id === target) {
      for (const id of path) ids.add(id);
      ids.add(target);
      return true;
    }
    for (const child of current.children) {
      if (findAncestors(target, child, [...path, current.id])) return true;
    }
    return false;
  }

  function findDescendants(node: LayoutNode) {
    ids.add(node.id);
    for (const child of node.children) findDescendants(child);
  }

  for (const root of layout) {
    findAncestors(nodeId, root, []);
  }

  const flat = flattenLayout(layout);
  const target = flat.find((n) => n.id === nodeId);
  if (target) findDescendants(target);

  return ids;
}

// ── Adapter / model / thinking formatters ────────────────────────────────

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  openclaw_gateway: "OpenClaw Gateway",
  hermes_local: "Hermes",
  process: "Process",
  http: "HTTP",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatAdapter(adapterType: string | null | undefined): string {
  const normalized = adapterType?.trim();
  if (!normalized) return "Auto";
  return adapterLabels[normalized] ?? normalized;
}

function formatModel(model: string | null | undefined): string {
  if (!model || model.trim().length === 0) return "Auto";
  return model;
}

function formatThinking(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "Auto";
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveThinking(agent: Agent): string | null {
  const config = asRecord(agent.adapterConfig) ?? {};
  if (agent.adapterType === "codex_local") {
    return asNonEmptyString(config.modelReasoningEffort) ?? asNonEmptyString(config.reasoningEffort);
  }
  if (agent.adapterType === "cursor") {
    return asNonEmptyString(config.mode);
  }
  if (agent.adapterType === "opencode_local") {
    return asNonEmptyString(config.variant);
  }
  return asNonEmptyString(config.effort);
}

// ── Status colors ────────────────────────────────────────────────────────

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

const agentStatusConfig: Record<string, { icon: LucideIcon; label: string; color: string; animate?: string }> = {
  running: { icon: Loader2, label: "Running", color: "text-cyan-400", animate: "animate-spin" },
  active: { icon: CheckCircle2, label: "Active", color: "text-green-400" },
  paused: { icon: Pause, label: "Paused", color: "text-yellow-500" },
  idle: { icon: Moon, label: "Idle", color: "text-blue-400/70" },
  error: { icon: AlertTriangle, label: "Error", color: "text-red-400" },
  terminated: { icon: CircleSlash, label: "Terminated", color: "text-neutral-400" },
  pending_approval: { icon: ShieldQuestion, label: "Pending", color: "text-amber-400" },
};
const defaultStatusConfig = { icon: Clock, label: "Unknown", color: "text-neutral-400" };

const runStatusIcons: Record<string, { icon: typeof Clock; color: string }> = {
  running: { icon: Timer, color: "text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-400" },
  completed: { icon: CheckCircle2, color: "text-green-400" },
  failed: { icon: XCircle, color: "text-red-400" },
  cancelled: { icon: XCircle, color: "text-neutral-400" },
};

// ── Main component ───────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { forceFullWidth, releaseFullWidth } = useContentWidth();
  const navigate = useNavigate();

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    forceFullWidth();
    return () => releaseFullWidth();
  }, [forceFullWidth, releaseFullWidth]);

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

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const connectedIds = useMemo(
    () => (selectedAgentId ? collectConnectedIds(selectedAgentId, layout) : new Set<string>()),
    [selectedAgentId, layout],
  );

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

  // Fit and center the chart on first load (delayed one frame so the
  // container has its final dimensions after full-bleed layout applies)
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;

    const container = containerRef.current;
    const doFit = () => {
      const containerW = container.clientWidth;
      const containerH = container.clientHeight;
      if (containerW === 0 || containerH === 0) return;

      hasInitialized.current = true;

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
    };

    requestAnimationFrame(() => requestAnimationFrame(doFit));
  }, [allNodes, bounds]);

  // Escape key closes inspector
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selectedAgentId) {
        setSelectedAgentId(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedAgentId]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-org-card]") || target.closest("[data-inspector]")) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
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

      const scale = newZoom / zoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-org-card]") && !target.closest("[data-inspector]") && !target.closest("[data-minimap]") && !target.closest("[data-zoom-controls]")) {
        setSelectedAgentId(null);
      }
    },
    [],
  );

  const fitToScreen = useCallback(() => {
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
  }, [bounds]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return (
      <EmptyState
        icon={Network}
        message="No organizational hierarchy defined."
        description="Define reporting relationships between agents to build your organizational hierarchy. This helps route escalations and delegation."
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-[calc(100vh-3rem)] overflow-hidden relative org-chart-canvas"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onClick={handleCanvasClick}
    >
      {/* Zoom controls */}
      <div data-zoom-controls className="absolute top-3 right-3 z-10 flex flex-col gap-1" style={{ right: selectedAgentId ? INSPECTOR_W + 12 : 12, transition: "right 300ms cubic-bezier(0.16, 1, 0.3, 1)" }}>
        <button
          className="w-8 h-8 flex items-center justify-center bg-background/90 backdrop-blur border border-border rounded-md text-sm font-medium hover:bg-accent transition-colors shadow-sm"
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
          className="w-8 h-8 flex items-center justify-center bg-background/90 backdrop-blur border border-border rounded-md text-sm font-medium hover:bg-accent transition-colors shadow-sm"
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
          className="w-8 h-8 flex items-center justify-center bg-background/90 backdrop-blur border border-border rounded-md text-[10px] font-medium hover:bg-accent transition-colors shadow-sm"
          onClick={fitToScreen}
          title="Fit to screen"
          aria-label="Fit chart to screen"
        >
          Fit
        </button>
      </div>

      {/* SVG layer for edges */}
      <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {edges.map(({ parent, child }, i) => {
            const x1 = parent.x + CARD_W / 2;
            const y1 = parent.y + CARD_H;
            const x2 = child.x + CARD_W / 2;
            const y2 = child.y;
            const midY = (y1 + y2) / 2;

            const isHighlighted = selectedAgentId && connectedIds.has(parent.id) && connectedIds.has(child.id);
            const pathLen = Math.abs(midY - y1) + Math.abs(x2 - x1) + Math.abs(y2 - midY);

            return (
              <path
                key={`${parent.id}-${child.id}`}
                d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                fill="none"
                stroke={isHighlighted ? "var(--primary)" : "var(--border)"}
                strokeWidth={isHighlighted ? 2 : 1.5}
                strokeOpacity={isHighlighted ? 0.8 : 1}
                strokeDasharray={pathLen}
                strokeDashoffset={pathLen}
                style={{
                  animation: `org-edge-draw 0.8s cubic-bezier(0.16, 1, 0.3, 1) ${i * 60}ms forwards`,
                }}
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
          const adapter = agent ? formatAdapter(agent.adapterType) : "Auto";
          const model = agent ? formatModel(asNonEmptyString(asRecord(agent.adapterConfig)?.model)) : "Auto";
          const thinking = agent ? formatThinking(resolveThinking(agent)) : "Auto";
          const isSelected = selectedAgentId === node.id;
          const statusCfg = agentStatusConfig[node.status] ?? defaultStatusConfig;
          const StatusIcon = statusCfg.icon;

          return (
            <div
              key={node.id}
              data-org-card
              role="button"
              tabIndex={0}
              aria-label={`${node.name} - ${agent?.title ?? roleLabel(node.role)} - ${statusCfg.label}`}
              className={cn(
                "absolute bg-card border border-border rounded-lg shadow-sm cursor-pointer select-none",
                "transition-all duration-200",
                isSelected
                  ? "ring-2 ring-primary/50 shadow-lg shadow-primary/10"
                  : "hover:shadow-md hover:-translate-y-px hover:border-foreground/20",
              )}
              style={{
                left: node.x,
                top: node.y,
                width: CARD_W,
                minHeight: CARD_H,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedAgentId(node.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedAgentId(node.id);
                }
              }}
            >
              {/* Status badge — top right */}
              <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-muted/60">
                <StatusIcon className={cn("h-3 w-3 shrink-0", statusCfg.color, statusCfg.animate)} />
                <span className={cn("text-[10px] font-medium leading-none", statusCfg.color)}>
                  {statusCfg.label}
                </span>
              </div>
              <div className="flex items-start px-3 pt-3 pb-3 gap-2.5">
                <div className="shrink-0">
                  <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                    <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                  </div>
                </div>
                <div className="flex flex-col items-start min-w-0 flex-1 pr-14">
                  <span className="block w-full truncate text-sm font-semibold text-foreground leading-tight">
                    {node.name}
                  </span>
                  <span className="block w-full truncate text-[11px] text-muted-foreground leading-tight mt-0.5">
                    {agent?.title ?? roleLabel(node.role)}
                  </span>
                  <div className="text-[9px] text-muted-foreground/60 leading-tight mt-1.5 flex flex-col gap-px w-full font-mono">
                    <span className="block w-full truncate">{adapter} / {model}</span>
                    <span className="block w-full truncate">Thinking: {thinking}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Minimap */}
      {allNodes.length > 0 && (
        <Minimap
          allNodes={allNodes}
          bounds={bounds}
          pan={pan}
          zoom={zoom}
          containerRef={containerRef}
          setPan={setPan}
          selectedAgentId={selectedAgentId}
        />
      )}

      {/* Agent Inspector Sidebar */}
      <OrgChartInspector
        agentId={selectedAgentId}
        agentMap={agentMap}
        companyId={selectedCompanyId}
        onClose={() => setSelectedAgentId(null)}
        navigate={navigate}
      />
    </div>
  );
}

// ── Minimap ──────────────────────────────────────────────────────────────

function Minimap({
  allNodes,
  bounds,
  pan,
  zoom,
  containerRef,
  setPan,
  selectedAgentId,
}: {
  allNodes: LayoutNode[];
  bounds: { width: number; height: number };
  pan: { x: number; y: number };
  zoom: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  setPan: (p: { x: number; y: number }) => void;
  selectedAgentId: string | null;
}) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const scale = Math.min(MINIMAP_W / bounds.width, MINIMAP_H / bounds.height);

  const containerW = containerRef.current?.clientWidth ?? 800;
  const containerH = containerRef.current?.clientHeight ?? 600;

  const viewportW = (containerW / zoom) * scale;
  const viewportH = (containerH / zoom) * scale;
  const viewportX = (-pan.x / zoom) * scale;
  const viewportY = (-pan.y / zoom) * scale;

  const handleMinimapInteraction = useCallback(
    (e: React.MouseEvent) => {
      const rect = minimapRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const chartX = mx / scale;
      const chartY = my / scale;

      setPan({
        x: -chartX * zoom + containerW / 2,
        y: -chartY * zoom + containerH / 2,
      });
    },
    [scale, zoom, containerW, containerH, setPan],
  );

  return (
    <div
      data-minimap
      ref={minimapRef}
      className="absolute bottom-3 left-3 z-10 bg-background/80 backdrop-blur-sm border border-border rounded-md overflow-hidden cursor-crosshair shadow-sm"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      onMouseDown={(e) => {
        e.stopPropagation();
        isDragging.current = true;
        handleMinimapInteraction(e);
      }}
      onMouseMove={(e) => {
        if (isDragging.current) handleMinimapInteraction(e);
      }}
      onMouseUp={() => {
        isDragging.current = false;
      }}
      onMouseLeave={() => {
        isDragging.current = false;
      }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H}>
        {allNodes.map((node) => (
          <rect
            key={node.id}
            x={node.x * scale}
            y={node.y * scale}
            width={CARD_W * scale}
            height={CARD_H * scale}
            rx={2}
            fill={
              node.id === selectedAgentId
                ? "var(--primary)"
                : "var(--muted-foreground)"
            }
            fillOpacity={node.id === selectedAgentId ? 0.6 : 0.25}
          />
        ))}
        <rect
          x={Math.max(0, viewportX)}
          y={Math.max(0, viewportY)}
          width={viewportW}
          height={viewportH}
          fill="var(--primary)"
          fillOpacity={0.08}
          stroke="var(--primary)"
          strokeWidth={1.5}
          strokeOpacity={0.5}
          rx={1}
        />
      </svg>
    </div>
  );
}

// ── Agent Inspector Sidebar ──────────────────────────────────────────────

function OrgChartInspector({
  agentId,
  agentMap,
  companyId,
  onClose,
  navigate,
}: {
  agentId: string | null;
  agentMap: Map<string, Agent>;
  companyId: string;
  onClose: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const isOpen = !!agentId;
  const { openNewIssue } = useDialog();

  const { data: fullAgent, isLoading: agentLoading } = useQuery({
    queryKey: queryKeys.agents.detail(agentId!),
    queryFn: () => agentsApi.get(agentId!, companyId),
    enabled: !!agentId,
  });

  const { data: runsResult } = useQuery({
    queryKey: queryKeys.heartbeats(companyId, agentId!),
    queryFn: () => heartbeatsApi.list(companyId, agentId!, 10),
    enabled: !!agentId,
  });

  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "orgInspector", agentId],
    queryFn: () => issuesApi.list(companyId, { assigneeAgentId: agentId! }),
    enabled: !!agentId,
  });

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(agentId!),
    queryFn: () => agentsApi.runtimeState(agentId!, companyId),
    enabled: !!agentId,
  });

  const invokeHeartbeat = useMutation({
    mutationFn: () => agentsApi.invoke(agentId!, companyId),
  });

  const pauseAgent = useMutation({
    mutationFn: () => agentsApi.pause(agentId!, companyId),
  });

  const resumeAgent = useMutation({
    mutationFn: () => agentsApi.resume(agentId!, companyId),
  });

  const agent = fullAgent ?? (agentId ? agentMap.get(agentId) : null);
  const runs = runsResult?.runs ?? [];
  const recentIssues = (issues ?? []).slice(0, 5);

  const latestRun = useMemo(() => {
    if (runs.length === 0) return null;
    const sorted = [...runs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return sorted.find((r) => r.status === "running" || r.status === "queued") ?? sorted[0] ?? null;
  }, [runs]);

  return (
    <div
      data-inspector
      className={cn(
        "absolute top-0 right-0 h-full bg-card border-l border-border z-20 flex flex-col",
        "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        isOpen ? "translate-x-0" : "translate-x-full",
      )}
      style={{ width: INSPECTOR_W }}
      onClick={(e) => e.stopPropagation()}
    >
      {agent && (
        <>
          {/* Header */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-border">
            <div className="relative shrink-0">
              <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center">
                <AgentIcon icon={agent.icon} className="h-6 w-6" />
              </div>
              <span
                className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-card"
                style={{ backgroundColor: statusDotColor[agent.status] ?? defaultDotColor }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold truncate font-display">{agent.name}</h3>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {roleLabel(agent.role)}
                {agent.title ? ` \u2014 ${agent.title}` : ""}
              </p>
              <div className="mt-1.5">
                <StatusBadge status={agent.status} />
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto">
            {/* Quick Actions */}
            <div className="px-5 py-3 border-b border-border space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-xs"
                  onClick={() => invokeHeartbeat.mutate()}
                  disabled={invokeHeartbeat.isPending || agent.status === "pending_approval"}
                >
                  <Play className="h-3 w-3 mr-1" />
                  Run Heartbeat
                </Button>
                {agent.status === "paused" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => resumeAgent.mutate()}
                    disabled={resumeAgent.isPending}
                  >
                    <Play className="h-3 w-3 mr-1" />
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => pauseAgent.mutate()}
                    disabled={pauseAgent.isPending || agent.status === "pending_approval"}
                  >
                    <Pause className="h-3 w-3 mr-1" />
                    Pause
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-xs"
                  onClick={() => navigate(`${agentUrl(agent)}/chat`)}
                >
                  <MessageSquare className="h-3 w-3 mr-1" />
                  Chat
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-xs"
                  onClick={() => openNewIssue({ assigneeAgentId: agent.id })}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  New Issue
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-xs"
                  onClick={() => navigate(`${agentUrl(agent)}/workspace`)}
                >
                  <FolderOpen className="h-3 w-3 mr-1" />
                  Workspace
                </Button>
              </div>
            </div>

            {/* Latest Run */}
            {latestRun && <InspectorLatestRun run={latestRun} agentId={agentId!} />}

            {/* Runtime Stats */}
            {runtimeState && <InspectorStats runtimeState={runtimeState} />}

            {/* Recent Issues */}
            <InspectorIssues issues={recentIssues} agentId={agentId!} />

            {/* Adapter Info */}
            {agent && (
              <div className="px-5 py-4 border-b border-border">
                <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Configuration</h4>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Adapter</span>
                    <span className="font-medium">{formatAdapter(agent.adapterType)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Model</span>
                    <span className="font-medium font-mono text-[11px]">{formatModel(asNonEmptyString(asRecord(agent.adapterConfig)?.model))}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Thinking</span>
                    <span className="font-medium">{formatThinking(resolveThinking(agent))}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border">
            <button
              onClick={() => navigate(agentUrl(agent))}
              className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium group"
            >
              View Full Profile
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </>
      )}

      {agentLoading && !agent && (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-sm text-muted-foreground">Loading...</div>
        </div>
      )}
    </div>
  );
}

// ── Inspector sub-sections ───────────────────────────────────────────────

function InspectorLatestRun({ run, agentId }: { run: HeartbeatRun; agentId: string }) {
  const isLive = run.status === "running" || run.status === "queued";
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const summary = run.resultJson
    ? String(
        (run.resultJson as Record<string, unknown>).summary ??
          (run.resultJson as Record<string, unknown>).result ??
          "",
      )
    : run.error ?? "";

  return (
    <div className="px-5 py-4 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          {isLive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
          )}
          {isLive ? "Live Run" : "Latest Run"}
        </h4>
        <span className="text-[10px] text-muted-foreground">{relativeTime(run.createdAt)}</span>
      </div>
      <div className="flex items-start gap-2">
        <StatusIcon className={cn("h-4 w-4 mt-0.5 shrink-0", statusInfo.color)} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium capitalize">{run.status}</p>
          {summary && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{summary}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function InspectorStats({ runtimeState }: { runtimeState: AgentRuntimeState }) {
  return (
    <div className="px-5 py-4 border-b border-border">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Runtime</h4>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground/60" />
          <div>
            <p className="text-[10px] text-muted-foreground">Input</p>
            <p className="text-xs font-semibold tabular-nums">{formatTokens(runtimeState.totalInputTokens)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground/60" />
          <div>
            <p className="text-[10px] text-muted-foreground">Output</p>
            <p className="text-xs font-semibold tabular-nums">{formatTokens(runtimeState.totalOutputTokens)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Timer className="h-3.5 w-3.5 text-muted-foreground/60" />
          <div>
            <p className="text-[10px] text-muted-foreground">Cached</p>
            <p className="text-xs font-semibold tabular-nums">{formatTokens(runtimeState.totalCachedInputTokens)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground/60" />
          <div>
            <p className="text-[10px] text-muted-foreground">Cost</p>
            <p className="text-xs font-semibold tabular-nums">{formatCents(runtimeState.totalCostCents)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function InspectorIssues({
  issues,
  agentId,
}: {
  issues: Issue[];
  agentId: string;
}) {
  return (
    <div className="px-5 py-4 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Assigned Issues
        </h4>
        {issues.length > 0 && (
          <Link
            to={`/issues?assignee=${agentId}`}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            See All
          </Link>
        )}
      </div>
      {issues.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">No assigned issues.</p>
      ) : (
        <div className="space-y-1.5">
          {issues.map((issue) => (
            <Link
              key={issue.id}
              to={`/issues/${issue.identifier ?? issue.id}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/50 transition-colors group no-underline"
            >
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                {issue.identifier ?? issue.id.slice(0, 8)}
              </span>
              <span className="text-xs truncate flex-1 text-foreground group-hover:text-foreground">
                {issue.title}
              </span>
              <StatusBadge status={issue.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Utilities ────────────────────────────────────────────────────────────

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
