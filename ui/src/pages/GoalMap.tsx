import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { List, Lock, Maximize2, Minus, Plus, Target } from "lucide-react";
import type { Agent, GoalMapNode, GoalMapStatusCounts } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { StatusGlyph } from "../components/StatusGlyph";

// Layout constants (left-to-right layered tree, transposed from OrgChart)
const NODE_W = 248;
const NODE_H = 116;
const GAP_X = 72;
const GAP_Y = 20;
const ROOT_GAP = 40;
const PADDING = 60;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

interface PlacedNode {
  node: GoalMapNode;
  x: number;
  y: number;
}

interface GoalMapLayout {
  placed: PlacedNode[];
  placedById: Map<string, PlacedNode>;
  width: number;
  height: number;
}

function layoutGoalMap(nodes: GoalMapNode[]): GoalMapLayout {
  const nodeIds = new Set(nodes.map((n) => n.goal.id));
  const childrenByParentId = new Map<string, GoalMapNode[]>();
  for (const node of nodes) {
    const parentId = node.goal.parentId;
    if (!parentId || !nodeIds.has(parentId)) continue;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(node);
    childrenByParentId.set(parentId, siblings);
  }
  const roots = nodes.filter((n) => !n.goal.parentId || !nodeIds.has(n.goal.parentId));

  const heightMemo = new Map<string, number>();
  function subtreeHeight(node: GoalMapNode, stack: Set<string>): number {
    const memoized = heightMemo.get(node.goal.id);
    if (memoized !== undefined) return memoized;
    if (stack.has(node.goal.id)) return NODE_H;
    stack.add(node.goal.id);
    const children = childrenByParentId.get(node.goal.id) ?? [];
    let height = NODE_H;
    if (children.length > 0) {
      const childrenHeight = children.reduce((sum, child) => sum + subtreeHeight(child, stack), 0);
      height = Math.max(NODE_H, childrenHeight + (children.length - 1) * GAP_Y);
    }
    stack.delete(node.goal.id);
    heightMemo.set(node.goal.id, height);
    return height;
  }

  const placedById = new Map<string, PlacedNode>();
  function place(node: GoalMapNode, x: number, y: number) {
    if (placedById.has(node.goal.id)) return;
    const totalHeight = subtreeHeight(node, new Set());
    placedById.set(node.goal.id, { node, x, y: y + (totalHeight - NODE_H) / 2 });
    let childY = y;
    for (const child of childrenByParentId.get(node.goal.id) ?? []) {
      place(child, x + NODE_W + GAP_X, childY);
      childY += subtreeHeight(child, new Set()) + GAP_Y;
    }
  }

  let yCursor = PADDING;
  for (const root of roots) {
    place(root, PADDING, yCursor);
    yCursor += subtreeHeight(root, new Set()) + ROOT_GAP;
  }
  // Nodes unreachable from any root (parentId cycles): stack them below.
  for (const node of nodes) {
    if (placedById.has(node.goal.id)) continue;
    placedById.set(node.goal.id, { node, x: PADDING, y: yCursor });
    yCursor += NODE_H + GAP_Y;
  }

  const placed = [...placedById.values()];
  let width = 800;
  let height = 600;
  for (const p of placed) {
    width = Math.max(width, p.x + NODE_W + PADDING);
    height = Math.max(height, p.y + NODE_H + PADDING);
  }
  return { placed, placedById, width, height };
}

function progressDenominator(counts: GoalMapStatusCounts): number {
  return Math.max(0, counts.total - counts.cancelled);
}

function edgePath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(28, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

export function GoalMap() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals", href: "/goals" }, { label: "Map" }]);
  }, [setBreadcrumbs]);

  const { data: goalMap, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.map(selectedCompanyId!),
    queryFn: () => goalsApi.map(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);
  const agentName = useCallback(
    (agentId: string | null) => (agentId ? agentById.get(agentId)?.name ?? "an agent" : null),
    [agentById],
  );

  const layout = useMemo(() => layoutGoalMap(goalMap?.nodes ?? []), [goalMap]);
  const gateEdges = useMemo(
    () => (goalMap?.edges ?? []).filter((e) => e.kind === "gates"),
    [goalMap],
  );
  const parentEdges = useMemo(
    () => (goalMap?.edges ?? []).filter((e) => e.kind === "parent"),
    [goalMap],
  );

  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedGoalId && layout.placedById.has(selectedGoalId)) return;
    setSelectedGoalId(layout.placed[0]?.node.goal.id ?? null);
  }, [layout, selectedGoalId]);
  const selected = selectedGoalId ? layout.placedById.get(selectedGoalId)?.node ?? null : null;

  // Why-chain: goal ancestry from the root down to the selected goal.
  const whyChain = useMemo(() => {
    if (!selected || !goalMap) return [];
    const byId = new Map(goalMap.nodes.map((n) => [n.goal.id, n]));
    const chain: GoalMapNode[] = [];
    const seen = new Set<string>();
    let current: GoalMapNode | undefined = selected;
    while (current && !seen.has(current.goal.id)) {
      seen.add(current.goal.id);
      chain.unshift(current);
      current = current.goal.parentId ? byId.get(current.goal.parentId) : undefined;
    }
    return chain;
  }, [selected, goalMap]);

  const inboundGates = useMemo(
    () => (selected ? gateEdges.filter((e) => e.toGoalId === selected.goal.id) : []),
    [gateEdges, selected],
  );
  const outboundGates = useMemo(
    () => (selected ? gateEdges.filter((e) => e.fromGoalId === selected.goal.id) : []),
    [gateEdges, selected],
  );

  // Pan & zoom (same interaction model as OrgChart)
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || layout.placed.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;
    const container = containerRef.current;
    const scaleX = (container.clientWidth - 40) / layout.width;
    const scaleY = (container.clientHeight - 40) / layout.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    setZoom(fitZoom);
    setPan({
      x: (container.clientWidth - layout.width * fitZoom) / 2,
      y: (container.clientHeight - layout.height * fitZoom) / 2,
    });
  }, [layout]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-goal-map-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + e.clientX - dragStart.current.x,
      y: dragStart.current.panY + e.clientY - dragStart.current.y,
    });
  }, [dragging]);
  const handleMouseUp = useCallback(() => setDragging(false), []);

  const zoomTowardPoint = useCallback((newZoom: number, point: { x: number; y: number }) => {
    const clamped = clampZoom(newZoom);
    const scale = clamped / zoom;
    setPan({
      x: point.x - scale * (point.x - pan.x),
      y: point.y - scale * (point.y - pan.y),
    });
    setZoom(clamped);
  }, [zoom, pan]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    zoomTowardPoint(zoom * (e.deltaY < 0 ? 1.1 : 0.9), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, [zoom, zoomTowardPoint]);

  const fitToScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scaleX = (container.clientWidth - 40) / layout.width;
    const scaleY = (container.clientHeight - 40) / layout.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    setZoom(fitZoom);
    setPan({
      x: (container.clientWidth - layout.width * fitZoom) / 2,
      y: (container.clientHeight - layout.height * fitZoom) / 2,
    });
  }, [layout]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view the goal map." />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }
  if (!goalMap || goalMap.nodes.length === 0) {
    return <EmptyState icon={Target} message="No goals yet. Create a goal to see the map." />;
  }

  return (
    <div className="flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <Link to="/goals">
          <Button variant="outline" size="sm">
            <List className="mr-1.5 h-3.5 w-3.5" />
            Tree view
          </Button>
        </Link>
        <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke="var(--border)" strokeWidth="1.5" /></svg>
            sub-goal
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke="var(--hex-facc15)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
            gates (open blockers)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke="var(--hex-4ade80)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
            gate cleared
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border md:flex-row">
        <div
          ref={containerRef}
          data-testid="goal-map-viewport"
          className="relative min-h-(--sz-280px) flex-1 overflow-hidden bg-muted/20"
          style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none", overscrollBehavior: "contain" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          {/* Zoom controls */}
          <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
            <button
              className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
              onClick={() => {
                const container = containerRef.current;
                if (container) {
                  zoomTowardPoint(zoom * 1.2, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
                }
              }}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
            <button
              className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
              onClick={() => {
                const container = containerRef.current;
                if (container) {
                  zoomTowardPoint(zoom * 0.8, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
                }
              }}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
            <button
              className="flex size-9 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-accent sm:size-7"
              onClick={fitToScreen}
              title="Fit to screen"
              aria-label="Fit map to screen"
            >
              <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
          </div>

          {/* Edge layer */}
          <svg className="pointer-events-none absolute inset-0" style={{ width: "100%", height: "100%" }}>
            <defs>
              <marker id="goal-map-arrow-parent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--border)" />
              </marker>
              <marker id="goal-map-arrow-gate-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--hex-facc15)" />
              </marker>
              <marker id="goal-map-arrow-gate-cleared" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--hex-4ade80)" />
              </marker>
            </defs>
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {parentEdges.map((edge) => {
                const from = layout.placedById.get(edge.fromGoalId);
                const to = layout.placedById.get(edge.toGoalId);
                if (!from || !to) return null;
                return (
                  <path
                    key={`parent-${edge.fromGoalId}-${edge.toGoalId}`}
                    d={edgePath(from, to)}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    markerEnd="url(#goal-map-arrow-parent)"
                  />
                );
              })}
              {gateEdges.map((edge) => {
                const from = layout.placedById.get(edge.fromGoalId);
                const to = layout.placedById.get(edge.toGoalId);
                if (!from || !to) return null;
                const open = edge.kind === "gates" && edge.openIssueCount > 0;
                return (
                  <path
                    key={`gates-${edge.fromGoalId}-${edge.toGoalId}`}
                    d={edgePath(from, to)}
                    fill="none"
                    stroke={open ? "var(--hex-facc15)" : "var(--hex-4ade80)"}
                    strokeOpacity={open ? 0.9 : 0.55}
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                    markerEnd={`url(#goal-map-arrow-gate-${open ? "open" : "cleared"})`}
                  />
                );
              })}
            </g>
          </svg>

          {/* Card layer */}
          <div
            data-testid="goal-map-card-layer"
            className="absolute inset-0"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
          >
            {layout.placed.map(({ node, x, y }) => {
              const denom = progressDenominator(node.subtreeCounts);
              const pct = denom > 0 ? Math.round((node.subtreeCounts.done / denom) * 100) : 0;
              const isSelected = node.goal.id === selectedGoalId;
              return (
                <Card
                  key={node.goal.id}
                  data-goal-map-card
                  role="button"
                  tabIndex={0}
                  aria-label={`Goal ${node.goal.title}`}
                  className={cn(
                    "absolute block cursor-pointer overflow-hidden py-0 select-none transition-(--tp-box-shadow-border-color) duration-150 hover:border-foreground/20 hover:shadow-md",
                    isSelected && "border-ring ring-2 ring-ring/40",
                    node.gated && !isSelected && "opacity-80",
                  )}
                  style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                  onClick={() => setSelectedGoalId(node.goal.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedGoalId(node.goal.id);
                    }
                  }}
                >
                  <div className="flex h-full flex-col gap-1.5 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs capitalize text-muted-foreground">{node.goal.level}</span>
                      {node.gated && <Lock aria-label="Gated by open blockers" className="h-3 w-3 text-(--hex-facc15)" />}
                      <span className="ml-auto">
                        <StatusBadge status={node.goal.status} />
                      </span>
                    </div>
                    <span className="line-clamp-2 text-sm font-medium leading-snug">{node.goal.title}</span>
                    <div className="mt-auto flex items-center gap-2">
                      {denom > 0 ? (
                        <>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {node.subtreeCounts.done}/{denom}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No tasks yet</span>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Inspector */}
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-background p-4 md:w-80 md:border-t-0 md:border-l">
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select a goal to see why it exists and what it unlocks.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs capitalize text-muted-foreground">{selected.goal.level} goal</span>
                  <StatusBadge status={selected.goal.status} />
                  {selected.gated && (
                    <span className="flex items-center gap-1 text-xs text-(--hex-facc15)">
                      <Lock className="h-3 w-3" />
                      {selected.inboundOpenGateCount} open blocker{selected.inboundOpenGateCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-semibold leading-snug">{selected.goal.title}</h2>
              </div>

              <InspectorSection title="Why this exists">
                <div className="space-y-1">
                  {whyChain.map((entry, index) => {
                    const isLast = index === whyChain.length - 1;
                    return (
                      <div key={entry.goal.id} className="flex items-start gap-2">
                        <span className="w-16 shrink-0 pt-0.5 text-xs capitalize text-muted-foreground">
                          {entry.goal.level}
                        </span>
                        {isLast ? (
                          <span className="text-sm font-medium">{entry.goal.title}</span>
                        ) : (
                          <button
                            className="text-left text-sm text-muted-foreground hover:text-foreground hover:underline"
                            onClick={() => setSelectedGoalId(entry.goal.id)}
                          >
                            {entry.goal.title}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {selected.goal.description && (
                  <p className="mt-2 text-sm text-muted-foreground">{selected.goal.description}</p>
                )}
                {agentName(selected.goal.ownerAgentId) && (
                  <div className="mt-2 flex items-center justify-between py-1.5">
                    <span className="text-xs text-muted-foreground">Owner</span>
                    <span className="text-sm">{agentName(selected.goal.ownerAgentId)}</span>
                  </div>
                )}
              </InspectorSection>

              <InspectorSection title="Progress">
                <div className="space-y-1">
                  <CountRow label="Done" value={selected.subtreeCounts.done} />
                  <CountRow label="In progress" value={selected.subtreeCounts.inProgress} />
                  <CountRow label="In review" value={selected.subtreeCounts.inReview} />
                  <CountRow label="Blocked" value={selected.subtreeCounts.blocked} />
                  <CountRow label="Backlog + todo" value={selected.subtreeCounts.backlog + selected.subtreeCounts.todo} />
                  <CountRow label="Total" value={progressDenominator(selected.subtreeCounts)} />
                </div>
                {selected.subtreeCounts.total !== selected.counts.total && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Includes sub-goals; {progressDenominator(selected.counts)} directly on this goal.
                  </p>
                )}
              </InspectorSection>

              {(inboundGates.length > 0 || outboundGates.length > 0) && (
                <InspectorSection title="Gates">
                  <div className="space-y-1">
                    {inboundGates.map((edge) => {
                      const from = layout.placedById.get(edge.fromGoalId);
                      if (!from || edge.kind !== "gates") return null;
                      return (
                        <GateRow
                          key={`in-${edge.fromGoalId}`}
                          direction="Waits on"
                          title={from.node.goal.title}
                          openCount={edge.openIssueCount}
                          totalCount={edge.totalIssueCount}
                          onSelect={() => setSelectedGoalId(edge.fromGoalId)}
                        />
                      );
                    })}
                    {outboundGates.map((edge) => {
                      const to = layout.placedById.get(edge.toGoalId);
                      if (!to || edge.kind !== "gates") return null;
                      return (
                        <GateRow
                          key={`out-${edge.toGoalId}`}
                          direction="Unlocks"
                          title={to.node.goal.title}
                          openCount={edge.openIssueCount}
                          totalCount={edge.totalIssueCount}
                          onSelect={() => setSelectedGoalId(edge.toGoalId)}
                        />
                      );
                    })}
                  </div>
                </InspectorSection>
              )}

              {selected.decompositions.length > 0 && (
                <InspectorSection title="Plans decomposed here">
                  <div className="space-y-2">
                    {selected.decompositions.map((decomposition) => (
                      <div key={`${decomposition.sourceIssueId}-${decomposition.createdAt}`} className="min-w-0">
                        <Link
                          to={`/issues/${decomposition.sourceIssueId}`}
                          className="flex items-baseline gap-1.5 text-sm hover:underline"
                        >
                          {decomposition.sourceIssueIdentifier && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {decomposition.sourceIssueIdentifier}
                            </span>
                          )}
                          <span className="truncate">{decomposition.sourceIssueTitle}</span>
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {decomposition.childCount} task{decomposition.childCount === 1 ? "" : "s"}
                          {agentName(decomposition.ownerAgentId) ? ` · by ${agentName(decomposition.ownerAgentId)}` : ""}
                          {decomposition.status === "in_flight" ? " · in flight" : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </InspectorSection>
              )}

              {selected.rootIssues.length > 0 && (
                <InspectorSection title="Tasks">
                  <div className="space-y-0.5">
                    {selected.rootIssues.map((issue) => (
                      <Link
                        key={issue.id}
                        to={`/issues/${issue.id}`}
                        className="-mx-1 flex items-start gap-2 rounded px-1 py-1 hover:bg-accent/50"
                      >
                        <span className="mt-0.5 shrink-0">
                          <StatusGlyph status={issue.status} size="sm" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-1.5">
                            {issue.identifier && (
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                            )}
                            <span className="truncate text-sm">{issue.title}</span>
                          </span>
                          {issue.rationale && (
                            <span className="line-clamp-2 text-xs text-muted-foreground">{issue.rationale}</span>
                          )}
                        </span>
                      </Link>
                    ))}
                  </div>
                  {selected.rootIssuesTruncated && (
                    <p className="mt-1 text-xs text-muted-foreground">Showing the most recent — open the goal for all tasks.</p>
                  )}
                </InspectorSection>
              )}

              <div className="mt-auto pt-2">
                <Link to={`/goals/${selected.goal.id}`}>
                  <Button variant="outline" size="sm">Open goal</Button>
                </Link>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function CountRow({ label, value }: { label: string; value: number }) {
  if (value === 0 && label !== "Total" && label !== "Done") return null;
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}

function GateRow({
  direction,
  title,
  openCount,
  totalCount,
  onSelect,
}: {
  direction: "Waits on" | "Unlocks";
  title: string;
  openCount: number;
  totalCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      className="-mx-1 flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
      onClick={onSelect}
    >
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{direction}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      <span
        className={cn(
          "shrink-0 font-mono text-xs tabular-nums",
          openCount > 0 ? "text-(--hex-facc15)" : "text-muted-foreground",
        )}
      >
        {openCount > 0 ? `${openCount} open` : `${totalCount} done`}
      </span>
    </button>
  );
}
