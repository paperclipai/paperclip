// LET-503 (CEO comment 420a4229) — first-class org/agent graph for EAOS.
// Pan/zoom/fit canvas with compact, real-data-backed cards. Click a card
// to surface details in the page-level sidebar rather than dumping detail
// into the node itself. Layout/interaction primitives mirror the existing
// `pages/OrgChart.tsx` so this matches familiar Paperclip pan/zoom feel
// while presenting in the cleaner EAOS card density.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { OrgNode } from "@/api/agents";
import { redactSecretLikeText } from "../secret-redact";

const CARD_W = 200;
const CARD_H = 88;
const GAP_X = 24;
const GAP_Y = 60;
const PADDING = 48;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const TOUCH_MOVE_THRESHOLD = 6;

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  status: string;
  workloadLabel: string | null;
  reportsCount: number;
  x: number;
  y: number;
  children: LayoutNode[];
}

interface Point {
  x: number;
  y: number;
}

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point;
  startPan: Point;
  startZoom: number;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

export interface EaosOrgGraphNodeDecoration {
  roleLabel: string;
  workloadLabel: string | null;
}

export interface EaosOrgGraphProps {
  tree: OrgNode[];
  decorate?: (node: OrgNode) => EaosOrgGraphNodeDecoration;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ariaLabel?: string;
}

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(
  node: OrgNode,
  x: number,
  y: number,
  decorate: (node: OrgNode) => EaosOrgGraphNodeDecoration,
): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y, decorate));
      cx += cw + GAP_X;
    }
  }

  const decoration = decorate(node);
  return {
    id: node.id,
    name: node.name,
    role: node.role,
    roleLabel: decoration.roleLabel,
    status: node.status,
    workloadLabel: decoration.workloadLabel,
    reportsCount: node.reports.length,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

function layoutForest(
  roots: OrgNode[],
  decorate: (node: OrgNode) => EaosOrgGraphNodeDecoration,
): LayoutNode[] {
  if (roots.length === 0) return [];

  let x = PADDING;
  const y = PADDING;
  const out: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    out.push(layoutTree(root, x, y, decorate));
    x += w + GAP_X;
  }
  return out;
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

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function touchPoint(touch: { clientX: number; clientY: number }): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
  container: HTMLDivElement,
): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  pending_approval: "#a78bfa",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

function defaultDecorate(node: OrgNode): EaosOrgGraphNodeDecoration {
  return {
    roleLabel: node.role,
    workloadLabel: node.reports.length > 0 ? `${node.reports.length} reports` : null,
  };
}

export function EaosOrgGraph({
  tree,
  decorate = defaultDecorate,
  selectedId,
  onSelect,
  ariaLabel = "Org graph canvas",
}: EaosOrgGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  const layout = useMemo(() => layoutForest(tree, decorate), [tree, decorate]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 480 };
    let maxX = 0;
    let maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) {
      return;
    }
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth || 800;
    const containerH = container.clientHeight || 480;
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
    (e: ReactMouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-eaos-org-card]")) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent) => {
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
    (e: React.WheelEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = clampZoom(zoom * factor);
      const scale = newZoom / zoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  const zoomTowardPoint = useCallback(
    (newZoom: number, point: Point) => {
      const clampedZoom = clampZoom(newZoom);
      const scale = clampedZoom / zoom;
      setPan({
        x: point.x - scale * (point.x - pan.x),
        y: point.y - scale * (point.y - pan.y),
      });
      setZoom(clampedZoom);
    },
    [zoom, pan],
  );

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth || 800;
    const cH = containerRef.current.clientHeight || 480;
    const scaleX = (cW - 40) / bounds.width;
    const scaleY = (cH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  const handleTouchStart = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      if (e.touches.length >= 2 && containerRef.current) {
        const first = e.touches[0]!;
        const second = e.touches[1]!;
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startPan: pan,
          startZoom: zoom,
          startDistance: touchDistance(first, second),
          startCenter: touchCenter(first, second, containerRef.current),
          moved: false,
        };
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;
      touchGesture.current = {
        mode: "pan",
        startPoint: touchPoint(touch),
        startPan: pan,
        startZoom: zoom,
        startDistance: 0,
        startCenter: { x: 0, y: 0 },
        moved: false,
      };
    },
    [pan, zoom],
  );

  const handleTouchMove = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container || !touchGesture.current.mode) return;

      if (e.touches.length >= 2) {
        const first = e.touches[0]!;
        const second = e.touches[1]!;
        const distance = touchDistance(first, second);
        const center = touchCenter(first, second, container);

        if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
          touchGesture.current = {
            mode: "pinch",
            startPoint: { x: 0, y: 0 },
            startPan: pan,
            startZoom: zoom,
            startDistance: distance,
            startCenter: center,
            moved: false,
          };
          return;
        }

        const gesture = touchGesture.current;
        const nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
        const scale = nextZoom / gesture.startZoom;
        const dx = center.x - gesture.startCenter.x;
        const dy = center.y - gesture.startCenter.y;
        gesture.moved =
          gesture.moved ||
          Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
          Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
        setZoom(nextZoom);
        setPan({
          x: center.x - scale * (gesture.startCenter.x - gesture.startPan.x),
          y: center.y - scale * (gesture.startCenter.y - gesture.startPan.y),
        });
        return;
      }

      const touch = e.touches[0];
      if (!touch || touchGesture.current.mode !== "pan") return;
      const dx = touch.clientX - touchGesture.current.startPoint.x;
      const dy = touch.clientY - touchGesture.current.startPoint.y;
      touchGesture.current.moved =
        touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      setPan({
        x: touchGesture.current.startPan.x + dx,
        y: touchGesture.current.startPan.y + dy,
      });
    },
    [pan, zoom],
  );

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = {
      mode: null,
      startPoint: { x: 0, y: 0 },
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  const handleNodeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(id);
      }
    },
    [onSelect],
  );

  return (
    <div
      ref={containerRef}
      data-testid="eaos-org-graph"
      role="application"
      aria-label={ariaLabel}
      className="relative h-full w-full min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/20"
      style={{
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        overscrollBehavior: "contain",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className="absolute top-3 right-3 z-10 flex flex-col gap-1.5"
        data-testid="eaos-org-graph-controls"
      >
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent"
          onClick={() => {
            const container = containerRef.current;
            if (!container) return;
            zoomTowardPoint(zoom * 1.2, {
              x: container.clientWidth / 2,
              y: container.clientHeight / 2,
            });
          }}
          data-testid="eaos-org-graph-zoom-in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent"
          onClick={() => {
            const container = containerRef.current;
            if (!container) return;
            zoomTowardPoint(zoom * 0.8, {
              x: container.clientWidth / 2,
              y: container.clientHeight / 2,
            });
          }}
          data-testid="eaos-org-graph-zoom-out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Fit graph to screen"
          title="Fit to screen"
          className="flex size-7 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent"
          onClick={fitToScreen}
          data-testid="eaos-org-graph-fit"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <svg
        className="pointer-events-none absolute inset-0"
        style={{ width: "100%", height: "100%" }}
        aria-hidden="true"
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {edges.map(({ parent, child }) => {
            const x1 = parent.x + CARD_W / 2;
            const y1 = parent.y + CARD_H;
            const x2 = child.x + CARD_W / 2;
            const y2 = child.y;
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={`${parent.id}-${child.id}`}
                d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.25}
              />
            );
          })}
        </g>
      </svg>

      <div
        data-testid="eaos-org-graph-cards"
        className="absolute inset-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {allNodes.map((node) => {
          const dotColor = statusDotColor[node.status] ?? defaultDotColor;
          const isSelected = node.id === selectedId;
          return (
            <div
              key={node.id}
              data-eaos-org-card
              data-testid={`eaos-org-node-${node.id}`}
              data-selected={isSelected ? "true" : "false"}
              role="button"
              tabIndex={0}
              aria-label={`${node.name}, ${node.roleLabel}, status ${node.status}`}
              aria-pressed={isSelected}
              className={
                "absolute flex select-none flex-col gap-1 rounded-md border bg-card px-3 py-2 text-left shadow-sm transition-[box-shadow,border-color] duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
                (isSelected
                  ? "border-foreground/60 ring-2 ring-foreground/20"
                  : "border-border hover:border-foreground/30")
              }
              style={{
                left: node.x,
                top: node.y,
                width: CARD_W,
                minHeight: CARD_H,
                cursor: "pointer",
              }}
              onClick={() => {
                if (suppressNextCardClick.current) {
                  suppressNextCardClick.current = false;
                  return;
                }
                onSelect(node.id);
              }}
              onKeyDown={(event) => handleNodeKey(event, node.id)}
            >
              <div className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">
                    {redactSecretLikeText(node.name)}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {node.roleLabel}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
                <span data-testid={`eaos-org-node-${node.id}-status`}>{node.status}</span>
                {node.workloadLabel ? (
                  <span data-testid={`eaos-org-node-${node.id}-workload`}>
                    {node.workloadLabel}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
