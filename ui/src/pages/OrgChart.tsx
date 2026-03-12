import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Network, Lock, GripVertical } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

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

/** Check if targetId is a descendant of sourceId in the org tree. */
function isDescendant(nodes: OrgNode[], sourceId: string, targetId: string): boolean {
  function findNode(tree: OrgNode[], id: string): OrgNode | null {
    for (const n of tree) {
      if (n.id === id) return n;
      const found = findNode(n.reports, id);
      if (found) return found;
    }
    return null;
  }

  function hasDescendant(node: OrgNode, id: string): boolean {
    for (const child of node.reports) {
      if (child.id === id) return true;
      if (hasDescendant(child, id)) return true;
    }
    return false;
  }

  const source = findNode(nodes, sourceId);
  if (!source) return false;
  return hasDescendant(source, targetId);
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

// ── Draggable card component ────────────────────────────────────────────

interface OrgCardProps {
  node: LayoutNode;
  agent: Agent | undefined;
  isCeo: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  isInvalidDrop: boolean;
  onNavigate: () => void;
}

function OrgCard({ node, agent, isCeo, isDragging, isDropTarget, isInvalidDrop, onNavigate }: OrgCardProps) {
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: node.id,
    disabled: isCeo,
  });

  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop-${node.id}`,
    data: { agentId: node.id, role: node.role },
  });

  const dotColor = statusDotColor[node.status] ?? defaultDotColor;
  const showDropHighlight = isDropTarget && !isInvalidDrop;
  const showDropError = isDropTarget && isInvalidDrop;

  return (
    <div
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      data-org-card
      className={`absolute bg-card border rounded-lg shadow-sm transition-all duration-150 select-none ${
        isDragging
          ? "opacity-30 scale-95"
          : showDropHighlight
            ? "border-blue-500 ring-2 ring-blue-500/30 shadow-lg scale-105"
            : showDropError
              ? "border-red-400 ring-2 ring-red-400/30"
              : "border-border hover:shadow-md hover:border-foreground/20"
      }`}
      style={{
      style={{
        left: node.x,
        top: node.y,
        width: CARD_W,
        minHeight: CARD_H,
        cursor: "default",
      }}
    >
      {/* Drag handle — top-left absolute overlay */}
      {!isCeo ? (
        <div
          {...listeners}
          {...attributes}
          className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground/80 hover:border-foreground/30 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3 w-3" />
        </div>
      ) : (
        <div
          className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-background border border-amber-500/40 shadow-sm flex items-center justify-center text-amber-500/60"
          title="CEO position is locked"
        >
          <Lock className="h-3 w-3" />
        </div>
      )}

      <div className="flex items-center px-4 py-3 gap-3">
        {/* Agent icon + status dot */}
        <div className="relative shrink-0" onClick={onNavigate}>
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center cursor-pointer">
            <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
            style={{ backgroundColor: dotColor }}
          />
        </div>

        {/* Name + role + adapter type */}
        <div className="flex flex-col items-start min-w-0 flex-1 cursor-pointer" onClick={onNavigate}>
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

      {/* Drop indicator text */}
      {showDropHighlight && (
        <div className="absolute -bottom-6 left-0 right-0 text-center text-[10px] text-blue-500 font-medium">
          Move here
        </div>
      )}
      {showDropError && (
        <div className="absolute -bottom-6 left-0 right-0 text-center text-[10px] text-red-400 font-medium">
          Cannot move here
        </div>
      )}
    </div>
  );
}

// ── Drag overlay card (follows cursor) ──────────────────────────────────

function DragOverlayCard({ node, agent }: { node: LayoutNode; agent: Agent | undefined }) {
  const dotColor = statusDotColor[node.status] ?? defaultDotColor;

  return (
    <div
      className="bg-card border border-blue-500 rounded-lg shadow-xl select-none relative"
      style={{ width: CARD_W, minHeight: CARD_H }}
    >
      {/* Drag handle — same absolute top-left position as OrgCard */}
      <div className="absolute -top-2 -left-2 z-10 w-6 h-6 rounded-full bg-background border border-blue-500 shadow-sm flex items-center justify-center text-blue-500">
        <GripVertical className="h-3 w-3" />
      </div>

      <div className="flex items-center px-4 py-3 gap-3">
        <div className="relative shrink-0">
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
            <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
            style={{ backgroundColor: dotColor }}
          />
        </div>
        <div className="flex flex-col items-start min-w-0 flex-1">
          <span className="text-sm font-semibold text-foreground leading-tight">
            {node.name}
          </span>
          <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
            {agent?.title ?? roleLabel(node.role)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Drag & drop state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDropId, setOverDropId] = useState<string | null>(null);

  // Timed error toast state
  const [dragError, setDragError] = useState<string | null>(null);

  // Mutation for updating agent reportsTo
  const updateReportsTo = useMutation({
    mutationFn: async ({ agentId, reportsTo }: { agentId: string; reportsTo: string | null }) => {
      return agentsApi.update(agentId, { reportsTo }, selectedCompanyId ?? undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
    },
    onError: (error: Error) => {
      setDragError(error.message ?? "Unknown error");
      setTimeout(() => setDragError(null), 4000);
    },
  });

  // DnD sensors — use a distance activation so clicks still work
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (event.over) {
      // Strip `drop-` prefix
      const dropId = String(event.over.id).replace(/^drop-/, "");
      setOverDropId(dropId);
    } else {
      setOverDropId(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const draggedId = event.active.id as string;
      const overId = event.over ? String(event.over.id).replace(/^drop-/, "") : null;

      setActiveDragId(null);
      setOverDropId(null);

      if (!overId || overId === draggedId) return;

      // Don't re-parent to the current parent (no-op)
      const currentParent = agentMap.get(draggedId)?.reportsTo;
      if (currentParent === overId) return;

      // Don't allow dropping onto self or descendants
      if (orgTree && isDescendant(orgTree, draggedId, overId)) return;

      // Don't allow dropping a CEO
      const draggedNode = allNodes.find((n) => n.id === draggedId);
      if (draggedNode?.role === "ceo") return;

      // Don't allow dropping onto a terminated agent
      const targetNode = allNodes.find((n) => n.id === overId);
      if (targetNode?.status === "terminated") return;

      // Update reportsTo
      updateReportsTo.mutate({ agentId: draggedId, reportsTo: overId });
    },
    [orgTree, allNodes, updateReportsTo],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setOverDropId(null);
  }, []);

  // Determine invalid drop
  const isInvalidDropTarget = useMemo(() => {
    if (!activeDragId || !overDropId) return false;
    if (activeDragId === overDropId) return true;
    if (orgTree && isDescendant(orgTree, activeDragId, overDropId)) return true;
    const targetNode = allNodes.find((n) => n.id === overDropId);
    if (targetNode?.status === "terminated") return true;
    return false;
  }, [activeDragId, overDropId, orgTree, allNodes]);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

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
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!panning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panStart.current.panX + dx, y: panStart.current.panY + dy });
  }, [panning]);

  const handleMouseUp = useCallback(() => {
    setPanning(false);
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

    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  // Active drag node for overlay
  const activeDragNode = useMemo(
    () => (activeDragId ? allNodes.find((n) => n.id === activeDragId) ?? null : null),
    [activeDragId, allNodes],
  );

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
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        ref={containerRef}
        className="w-full h-[calc(100vh-4rem)] overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{ cursor: panning ? "grabbing" : activeDragId ? "default" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Drag mode banner */}
        {activeDragId && (
          <div className="absolute top-3 left-3 z-10 bg-blue-500/10 border border-blue-500/30 rounded-md px-3 py-1.5 text-xs text-blue-500 font-medium">
            Drop on another agent to reassign reporting line
          </div>
        )}

        {/* Mutation status toast */}
        {updateReportsTo.isPending && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium shadow-lg">
            Updating org structure…
          </div>
        )}
        {dragError && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-red-500 text-white rounded-md px-4 py-2 text-sm font-medium shadow-lg flex items-center gap-2">
            <span>Failed to update: {dragError}</span>
            <button onClick={() => setDragError(null)} className="ml-1 hover:text-white/70 text-white font-bold">✕</button>
          </div>
        )}

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

              // Highlight edge if child is being dragged
              const isActive = activeDragId === child.id;

              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke={isActive ? "var(--color-blue-500, #3b82f6)" : "var(--border)"}
                  strokeWidth={isActive ? 2 : 1.5}
                  strokeDasharray={isActive ? "6 4" : undefined}
                  opacity={isActive ? 0.5 : 1}
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
            const isCeo = node.role === "ceo";
            const isDragging = activeDragId === node.id;
            const isDropTarget = overDropId === node.id && activeDragId !== null && activeDragId !== node.id;

            return (
              <OrgCard
                key={node.id}
                node={node}
                agent={agent}
                isCeo={isCeo}
                isDragging={isDragging}
                isDropTarget={isDropTarget}
                isInvalidDrop={isDropTarget && isInvalidDropTarget}
                onNavigate={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
              />
            );
          })}
        </div>
      </div>

      {/* Drag overlay — follows cursor outside the transform */}
      <DragOverlay dropAnimation={null}>
        {activeDragNode ? (
          <DragOverlayCard node={activeDragNode} agent={agentMap.get(activeDragNode.id)} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
