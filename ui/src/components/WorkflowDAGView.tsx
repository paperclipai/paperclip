import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { WorkflowTemplateNode } from "@paperclipai/shared";

// ── Layout constants ────────────────────────────────────────────────────
const CARD_W = 200;
const CARD_H = 58;
const GAP_X = 60;  // horizontal gap between columns (layers)
const GAP_Y = 24;  // vertical gap between nodes in same column
const PADDING = 30;

// ── Layout types ────────────────────────────────────────────────────────

interface LayoutNode {
  tempId: string;
  title: string;
  description?: string | null;
  blockedByTempIds: string[];
  parentTempId?: string | null;
  x: number;
  y: number;
  layer: number;
  isRoot: boolean;
}

interface Edge {
  from: LayoutNode;
  to: LayoutNode;
}

// ── Topological layering ────────────────────────────────────────────────

/**
 * Assign each node to a layer based on its longest dependency chain.
 * Nodes with no blockers go to layer 0. A node blocked by layer-N nodes
 * goes to layer N+1. This produces a top-down "depth" layout.
 */
function assignLayers(nodes: WorkflowTemplateNode[]): Map<string, number> {
  const layerMap = new Map<string, number>();
  const nodeMap = new Map(nodes.map((n) => [n.tempId, n]));

  function getLayer(id: string): number {
    if (layerMap.has(id)) return layerMap.get(id)!;
    // Sentinel to detect cycles (treat as layer 0)
    layerMap.set(id, 0);
    const node = nodeMap.get(id);
    if (!node || node.blockedByTempIds.length === 0) {
      layerMap.set(id, 0);
      return 0;
    }
    let maxDep = 0;
    for (const depId of node.blockedByTempIds) {
      if (nodeMap.has(depId)) {
        maxDep = Math.max(maxDep, getLayer(depId) + 1);
      }
    }
    layerMap.set(id, maxDep);
    return maxDep;
  }

  for (const node of nodes) {
    getLayer(node.tempId);
  }
  return layerMap;
}

function layoutDAG(nodes: WorkflowTemplateNode[]): {
  layoutNodes: LayoutNode[];
  edges: Edge[];
  width: number;
  height: number;
} {
  if (nodes.length === 0) {
    return { layoutNodes: [], edges: [], width: 400, height: 200 };
  }

  const layerMap = assignLayers(nodes);
  const rootIds = new Set(
    nodes.filter((n) => !n.parentTempId).map((n) => n.tempId),
  );

  // Group by layer
  const maxLayer = Math.max(...layerMap.values(), 0);
  const layers: WorkflowTemplateNode[][] = [];
  for (let i = 0; i <= maxLayer; i++) layers.push([]);
  for (const node of nodes) {
    const layer = layerMap.get(node.tempId) ?? 0;
    layers[layer].push(node);
  }

  // Position nodes — layers are COLUMNS (left→right), nodes within a layer stack vertically
  const layoutNodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();

  for (let layer = 0; layer <= maxLayer; layer++) {
    const layerNodes = layers[layer];

    for (let i = 0; i < layerNodes.length; i++) {
      const node = layerNodes[i];
      const x = PADDING + layer * (CARD_W + GAP_X);
      const y = PADDING + i * (CARD_H + GAP_Y);

      const ln: LayoutNode = {
        tempId: node.tempId,
        title: node.title,
        description: node.description,
        blockedByTempIds: node.blockedByTempIds,
        parentTempId: node.parentTempId,
        x,
        y,
        layer,
        isRoot: rootIds.has(node.tempId),
      };
      layoutNodes.push(ln);
      nodeById.set(node.tempId, ln);
    }
  }

  // Center each column vertically relative to the tallest column
  const layerHeights = layers.map(
    (l) => l.length * CARD_H + Math.max(0, l.length - 1) * GAP_Y,
  );
  const maxHeight = Math.max(...layerHeights);
  for (const ln of layoutNodes) {
    const lh = layerHeights[ln.layer];
    ln.y += (maxHeight - lh) / 2;
  }

  // Build edges (blocker → dependent = top-down)
  const edges: Edge[] = [];
  for (const ln of layoutNodes) {
    for (const depId of ln.blockedByTempIds) {
      const from = nodeById.get(depId);
      if (from) {
        edges.push({ from, to: ln });
      }
    }
  }

  const width = (maxLayer + 1) * (CARD_W + GAP_X) - GAP_X + PADDING * 2;
  const height = maxHeight + PADDING * 2;

  return { layoutNodes, edges, width, height };
}

// ── Component ───────────────────────────────────────────────────────────

interface WorkflowDAGViewProps {
  nodes: WorkflowTemplateNode[];
  /** Optional: highlight a node by tempId (e.g. on hover from node list) */
  highlightId?: string | null;
  /** Callback when a node card is clicked */
  onNodeClick?: (tempId: string) => void;
  /** Minimum height of the container */
  minHeight?: number;
}

export function WorkflowDAGView({
  nodes,
  highlightId,
  onNodeClick,
  minHeight = 300,
}: WorkflowDAGViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const { layoutNodes, edges, width, height } = useMemo(
    () => layoutDAG(nodes),
    [nodes],
  );

  // Auto-fit on mount / node changes
  const lastNodeCount = useRef(-1);
  useEffect(() => {
    if (layoutNodes.length === 0 || !containerRef.current) return;
    if (lastNodeCount.current === layoutNodes.length) return;
    lastNodeCount.current = layoutNodes.length;

    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 20) / width;
    const scaleY = (cH - 20) / height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = width * fitZoom;
    const chartH = height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (cW - chartW) / 2,
      y: Math.max(10, (cH - chartH) / 2),
    });
  }, [layoutNodes, width, height]);

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-dag-card]")) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setPan({
        x: dragStart.current.panX + (e.clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.clientY - dragStart.current.y),
      });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(Math.max(zoom * factor, 0.3), 2);
      const scale = newZoom / zoom;
      setPan({ x: mx - scale * (mx - pan.x), y: my - scale * (my - pan.y) });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  if (nodes.length === 0) {
    return (
      <div
        className="flex items-center justify-center border border-dashed border-border rounded-lg text-sm text-muted-foreground"
        style={{ minHeight }}
      >
        Add nodes to see the dependency graph
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden border border-border rounded-lg bg-muted/20"
      style={{ minHeight, cursor: dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Zoom controls */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
        <button
          type="button"
          className="w-6 h-6 flex items-center justify-center bg-background border border-border rounded text-xs hover:bg-accent transition-colors"
          onClick={() => {
            const c = containerRef.current;
            if (!c) return;
            const nz = Math.min(zoom * 1.2, 2);
            const cx = c.clientWidth / 2;
            const cy = c.clientHeight / 2;
            const s = nz / zoom;
            setPan({ x: cx - s * (cx - pan.x), y: cy - s * (cy - pan.y) });
            setZoom(nz);
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="w-6 h-6 flex items-center justify-center bg-background border border-border rounded text-xs hover:bg-accent transition-colors"
          onClick={() => {
            const c = containerRef.current;
            if (!c) return;
            const nz = Math.max(zoom * 0.8, 0.3);
            const cx = c.clientWidth / 2;
            const cy = c.clientHeight / 2;
            const s = nz / zoom;
            setPan({ x: cx - s * (cx - pan.x), y: cy - s * (cy - pan.y) });
            setZoom(nz);
          }}
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <button
          type="button"
          className="w-6 h-6 flex items-center justify-center bg-background border border-border rounded text-[9px] hover:bg-accent transition-colors"
          onClick={() => {
            const c = containerRef.current;
            if (!c) return;
            const scaleX = (c.clientWidth - 20) / width;
            const scaleY = (c.clientHeight - 20) / height;
            const fitZoom = Math.min(scaleX, scaleY, 1);
            const chartW = width * fitZoom;
            const chartH = height * fitZoom;
            setZoom(fitZoom);
            setPan({ x: (c.clientWidth - chartW) / 2, y: (c.clientHeight - chartH) / 2 });
          }}
          aria-label="Fit to view"
        >
          Fit
        </button>
      </div>

      {/* SVG edges */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          <marker
            id="dag-arrow"
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 4 L 0 8 z" fill="var(--muted-foreground)" fillOpacity="0.5" />
          </marker>
        </defs>
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {edges.map(({ from, to }) => {
            // Horizontal: exit right edge of source, enter left edge of target
            const x1 = from.x + CARD_W;
            const y1 = from.y + CARD_H / 2;
            const x2 = to.x;
            const y2 = to.y + CARD_H / 2;
            const midX = (x1 + x2) / 2;

            return (
              <path
                key={`${from.tempId}-${to.tempId}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeOpacity="0.4"
                strokeWidth={1.5}
                markerEnd="url(#dag-arrow)"
              />
            );
          })}
        </g>
      </svg>

      {/* Node cards */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {layoutNodes.map((node) => {
          const isHighlighted = highlightId === node.tempId;
          const hasBlockers = node.blockedByTempIds.length > 0;

          return (
            <div
              key={node.tempId}
              data-dag-card
              className={`absolute rounded-lg border shadow-sm select-none transition-[box-shadow,border-color] duration-150 ${
                isHighlighted
                  ? "border-primary shadow-md ring-1 ring-primary/30"
                  : "border-border hover:shadow-md hover:border-foreground/20"
              } ${onNodeClick ? "cursor-pointer" : ""}`}
              style={{
                left: node.x,
                top: node.y,
                width: CARD_W,
                minHeight: CARD_H,
                background: "var(--card)",
              }}
              onClick={() => onNodeClick?.(node.tempId)}
            >
              <div className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {/* Status indicator */}
                  <span
                    className={`shrink-0 w-2 h-2 rounded-full ${
                      node.isRoot
                        ? "bg-primary"
                        : hasBlockers
                          ? "bg-amber-400"
                          : "bg-emerald-400"
                    }`}
                  />
                  <span className="text-sm font-medium truncate">{node.title || "Untitled"}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded font-mono">
                    {node.tempId}
                  </code>
                  {hasBlockers && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                      <ArrowRight className="h-2.5 w-2.5" />
                      {node.blockedByTempIds.length} dep{node.blockedByTempIds.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="absolute bottom-2 left-2 flex items-center gap-3 text-[10px] text-muted-foreground bg-background/80 backdrop-blur-sm rounded px-2 py-1 border border-border">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-primary" /> Root
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400" /> Ready
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400" /> Blocked
        </span>
        <span className="flex items-center gap-1">
          → Dependency
        </span>
      </div>
    </div>
  );
}
