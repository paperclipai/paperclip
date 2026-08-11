import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { List, Lock, Maximize2, Minus, Plus, Target } from "lucide-react";
import type { Agent, GoalMapNode, GoalMapRootIssue, GoalMapStatusCounts } from "@paperclipai/shared";
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
import { IssueStatusBadge, StatusBadge } from "../components/StatusBadge";
import { StatusGlyph } from "../components/StatusGlyph";

// Layout constants (left-to-right layered tree, transposed from OrgChart)
const NODE_W = 248;
const NODE_H = 116;
const ISSUE_W = 224;
const ISSUE_H = 64;
const ISSUE_GAP = 12;
const GAP_X = 72;
const GAP_Y = 20;
const ROOT_GAP = 40;
const PADDING = 60;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

interface PlacedGoal {
  node: GoalMapNode;
  x: number;
  y: number;
}

interface PlacedIssue {
  issue: GoalMapRootIssue;
  goalId: string;
  x: number;
  y: number;
}

interface GoalMapLayout {
  placedGoals: PlacedGoal[];
  placedGoalById: Map<string, PlacedGoal>;
  placedIssues: PlacedIssue[];
  placedIssueById: Map<string, PlacedIssue>;
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
  function issueStackHeight(node: GoalMapNode): number {
    const count = node.rootIssues.length;
    return count > 0 ? count * (ISSUE_H + ISSUE_GAP) - ISSUE_GAP : 0;
  }
  function subtreeHeight(node: GoalMapNode, stack: Set<string>): number {
    const memoized = heightMemo.get(node.goal.id);
    if (memoized !== undefined) return memoized;
    if (stack.has(node.goal.id)) return NODE_H;
    stack.add(node.goal.id);
    const children = childrenByParentId.get(node.goal.id) ?? [];
    const issuesHeight = issueStackHeight(node);
    const childrenHeight = children.length > 0
      ? children.reduce((sum, child) => sum + subtreeHeight(child, stack), 0) + (children.length - 1) * GAP_Y
      : 0;
    const separator = issuesHeight > 0 && childrenHeight > 0 ? GAP_Y : 0;
    const height = Math.max(NODE_H, issuesHeight + separator + childrenHeight);
    stack.delete(node.goal.id);
    heightMemo.set(node.goal.id, height);
    return height;
  }

  const placedGoalById = new Map<string, PlacedGoal>();
  const placedIssueById = new Map<string, PlacedIssue>();
  function place(node: GoalMapNode, x: number, y: number) {
    if (placedGoalById.has(node.goal.id)) return;
    const totalHeight = subtreeHeight(node, new Set());
    placedGoalById.set(node.goal.id, { node, x, y: y + (totalHeight - NODE_H) / 2 });
    const childX = x + NODE_W + GAP_X;
    let childY = y;
    for (const issue of node.rootIssues) {
      if (!placedIssueById.has(issue.id)) {
        placedIssueById.set(issue.id, { issue, goalId: node.goal.id, x: childX, y: childY });
      }
      childY += ISSUE_H + ISSUE_GAP;
    }
    const children = childrenByParentId.get(node.goal.id) ?? [];
    if (node.rootIssues.length > 0 && children.length > 0) childY += GAP_Y - ISSUE_GAP;
    for (const child of children) {
      place(child, childX, childY);
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
    if (placedGoalById.has(node.goal.id)) continue;
    placedGoalById.set(node.goal.id, { node, x: PADDING, y: yCursor });
    yCursor += NODE_H + GAP_Y;
  }

  const placedGoals = [...placedGoalById.values()];
  const placedIssues = [...placedIssueById.values()];
  let width = 800;
  let height = 600;
  for (const p of placedGoals) {
    width = Math.max(width, p.x + NODE_W + PADDING);
    height = Math.max(height, p.y + NODE_H + PADDING);
  }
  for (const p of placedIssues) {
    width = Math.max(width, p.x + ISSUE_W + PADDING);
    height = Math.max(height, p.y + ISSUE_H + PADDING);
  }
  return { placedGoals, placedGoalById, placedIssues, placedIssueById, width, height };
}

function progressDenominator(counts: GoalMapStatusCounts): number {
  return Math.max(0, counts.total - counts.cancelled);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(28, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

type Selection = { kind: "goal"; id: string } | { kind: "issue"; id: string } | null;

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
  const issueEdges = useMemo(() => goalMap?.issueEdges ?? [], [goalMap]);

  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => {
    if (selection?.kind === "goal" && layout.placedGoalById.has(selection.id)) return;
    if (selection?.kind === "issue" && layout.placedIssueById.has(selection.id)) return;
    setSelection(layout.placedGoals[0] ? { kind: "goal", id: layout.placedGoals[0].node.goal.id } : null);
  }, [layout, selection]);

  const selectedGoal = selection?.kind === "goal" ? layout.placedGoalById.get(selection.id)?.node ?? null : null;
  const selectedIssue = selection?.kind === "issue" ? layout.placedIssueById.get(selection.id) ?? null : null;

  const nodeById = useMemo(
    () => new Map((goalMap?.nodes ?? []).map((n) => [n.goal.id, n])),
    [goalMap],
  );
  const goalChainFor = useCallback((goalId: string): GoalMapNode[] => {
    const chain: GoalMapNode[] = [];
    const seen = new Set<string>();
    let current = nodeById.get(goalId);
    while (current && !seen.has(current.goal.id)) {
      seen.add(current.goal.id);
      chain.unshift(current);
      current = current.goal.parentId ? nodeById.get(current.goal.parentId) : undefined;
    }
    return chain;
  }, [nodeById]);
  const whyChain = useMemo(() => {
    if (selectedGoal) return goalChainFor(selectedGoal.goal.id);
    if (selectedIssue) return goalChainFor(selectedIssue.goalId);
    return [];
  }, [selectedGoal, selectedIssue, goalChainFor]);

  const inboundGates = useMemo(
    () => (selectedGoal ? gateEdges.filter((e) => e.toGoalId === selectedGoal.goal.id) : []),
    [gateEdges, selectedGoal],
  );
  const outboundGates = useMemo(
    () => (selectedGoal ? gateEdges.filter((e) => e.fromGoalId === selectedGoal.goal.id) : []),
    [gateEdges, selectedGoal],
  );
  const issueBlockedBy = useMemo(
    () => (selectedIssue ? issueEdges.filter((e) => e.toIssueId === selectedIssue.issue.id) : []),
    [issueEdges, selectedIssue],
  );
  const issueBlocks = useMemo(
    () => (selectedIssue ? issueEdges.filter((e) => e.fromIssueId === selectedIssue.issue.id) : []),
    [issueEdges, selectedIssue],
  );

  // Pan & zoom (same interaction model as OrgChart)
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || layout.placedGoals.length === 0 || !containerRef.current) return;
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
            breakdown
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke="var(--hex-facc15)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
            blocks (open)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke="var(--hex-4ade80)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
            blocker done
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
                const from = layout.placedGoalById.get(edge.fromGoalId);
                const to = layout.placedGoalById.get(edge.toGoalId);
                if (!from || !to) return null;
                return (
                  <path
                    key={`parent-${edge.fromGoalId}-${edge.toGoalId}`}
                    d={curve(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    markerEnd="url(#goal-map-arrow-parent)"
                  />
                );
              })}
              {layout.placedIssues.map((placed) => {
                const goal = layout.placedGoalById.get(placed.goalId);
                if (!goal) return null;
                return (
                  <path
                    key={`goal-issue-${placed.issue.id}`}
                    d={curve(goal.x + NODE_W, goal.y + NODE_H / 2, placed.x, placed.y + ISSUE_H / 2)}
                    fill="none"
                    stroke="var(--border)"
                    strokeOpacity={0.7}
                    strokeWidth={1}
                  />
                );
              })}
              {gateEdges.map((edge) => {
                const from = layout.placedGoalById.get(edge.fromGoalId);
                const to = layout.placedGoalById.get(edge.toGoalId);
                if (!from || !to) return null;
                const open = edge.kind === "gates" && edge.openIssueCount > 0;
                return (
                  <path
                    key={`gates-${edge.fromGoalId}-${edge.toGoalId}`}
                    d={curve(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)}
                    fill="none"
                    stroke={open ? "var(--hex-facc15)" : "var(--hex-4ade80)"}
                    strokeOpacity={open ? 0.9 : 0.55}
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                    markerEnd={`url(#goal-map-arrow-gate-${open ? "open" : "cleared"})`}
                  />
                );
              })}
              {issueEdges.map((edge) => {
                const from = layout.placedIssueById.get(edge.fromIssueId);
                const to = layout.placedIssueById.get(edge.toIssueId);
                if (!from || !to) return null;
                return (
                  <path
                    key={`blocks-${edge.fromIssueId}-${edge.toIssueId}`}
                    d={curve(from.x + ISSUE_W, from.y + ISSUE_H / 2, to.x, to.y + ISSUE_H / 2)}
                    fill="none"
                    stroke={edge.open ? "var(--hex-facc15)" : "var(--hex-4ade80)"}
                    strokeOpacity={edge.open ? 0.9 : 0.55}
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                    markerEnd={`url(#goal-map-arrow-gate-${edge.open ? "open" : "cleared"})`}
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
            {layout.placedGoals.map(({ node, x, y }) => {
              const denom = progressDenominator(node.subtreeCounts);
              const pct = denom > 0 ? Math.round((node.subtreeCounts.done / denom) * 100) : 0;
              const isSelected = selection?.kind === "goal" && selection.id === node.goal.id;
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
                  onClick={() => setSelection({ kind: "goal", id: node.goal.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ kind: "goal", id: node.goal.id });
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
            {layout.placedIssues.map(({ issue, x, y }) => {
              const isSelected = selection?.kind === "issue" && selection.id === issue.id;
              const childPct = issue.childTotalCount > 0
                ? Math.round((issue.childDoneCount / issue.childTotalCount) * 100)
                : 0;
              return (
                <Card
                  key={issue.id}
                  data-goal-map-card
                  role="button"
                  tabIndex={0}
                  aria-label={`Task ${issue.title}`}
                  className={cn(
                    "absolute block cursor-pointer overflow-hidden py-0 select-none transition-(--tp-box-shadow-border-color) duration-150 hover:border-foreground/20 hover:shadow-md",
                    isSelected && "border-ring ring-2 ring-ring/40",
                  )}
                  style={{ left: x, top: y, width: ISSUE_W, height: ISSUE_H }}
                  onClick={() => setSelection({ kind: "issue", id: issue.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ kind: "issue", id: issue.id });
                    }
                  }}
                >
                  <div className="flex h-full flex-col justify-center gap-1 px-2.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0"><StatusGlyph status={issue.status} size="sm" /></span>
                      {issue.identifier && (
                        <span className="shrink-0 font-mono text-(length:--text-nano) text-muted-foreground">{issue.identifier}</span>
                      )}
                      <span className="truncate text-xs font-medium">{issue.title}</span>
                    </div>
                    {issue.childTotalCount > 0 && (
                      <div className="flex items-center gap-1.5 pl-5">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-green-400" style={{ width: `${childPct}%` }} />
                        </div>
                        <span className="font-mono text-(length:--text-nano) tabular-nums text-muted-foreground">
                          {issue.childDoneCount}/{issue.childTotalCount}
                        </span>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Inspector */}
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-background p-4 md:w-80 md:border-t-0 md:border-l">
          {!selectedGoal && !selectedIssue && (
            <p className="text-sm text-muted-foreground">Select a goal or task to see why it exists and what it unlocks.</p>
          )}

          {selectedGoal && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs capitalize text-muted-foreground">{selectedGoal.goal.level} goal</span>
                  <StatusBadge status={selectedGoal.goal.status} />
                  {selectedGoal.gated && (
                    <span className="flex items-center gap-1 text-xs text-(--hex-facc15)">
                      <Lock className="h-3 w-3" />
                      {selectedGoal.inboundOpenGateCount} open blocker{selectedGoal.inboundOpenGateCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-semibold leading-snug">{selectedGoal.goal.title}</h2>
              </div>

              <InspectorSection title="Why this exists">
                <WhyChain
                  chain={whyChain}
                  onSelectGoal={(goalId) => setSelection({ kind: "goal", id: goalId })}
                />
                {selectedGoal.goal.description && (
                  <p className="mt-2 text-sm text-muted-foreground">{selectedGoal.goal.description}</p>
                )}
                {agentName(selectedGoal.goal.ownerAgentId) && (
                  <div className="mt-2 flex items-center justify-between py-1.5">
                    <span className="text-xs text-muted-foreground">Owner</span>
                    <span className="text-sm">{agentName(selectedGoal.goal.ownerAgentId)}</span>
                  </div>
                )}
              </InspectorSection>

              <InspectorSection title="Progress">
                <div className="space-y-1">
                  <CountRow label="Done" value={selectedGoal.subtreeCounts.done} />
                  <CountRow label="In progress" value={selectedGoal.subtreeCounts.inProgress} />
                  <CountRow label="In review" value={selectedGoal.subtreeCounts.inReview} />
                  <CountRow label="Blocked" value={selectedGoal.subtreeCounts.blocked} />
                  <CountRow label="Backlog + todo" value={selectedGoal.subtreeCounts.backlog + selectedGoal.subtreeCounts.todo} />
                  <CountRow label="Total" value={progressDenominator(selectedGoal.subtreeCounts)} />
                </div>
                {selectedGoal.subtreeCounts.total !== selectedGoal.counts.total && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Includes sub-goals; {progressDenominator(selectedGoal.counts)} directly on this goal.
                  </p>
                )}
              </InspectorSection>

              {(inboundGates.length > 0 || outboundGates.length > 0) && (
                <InspectorSection title="Gates">
                  <div className="space-y-1">
                    {inboundGates.map((edge) => {
                      const from = layout.placedGoalById.get(edge.fromGoalId);
                      if (!from || edge.kind !== "gates") return null;
                      return (
                        <GateRow
                          key={`in-${edge.fromGoalId}`}
                          direction="Waits on"
                          title={from.node.goal.title}
                          openCount={edge.openIssueCount}
                          totalCount={edge.totalIssueCount}
                          onSelect={() => setSelection({ kind: "goal", id: edge.fromGoalId })}
                        />
                      );
                    })}
                    {outboundGates.map((edge) => {
                      const to = layout.placedGoalById.get(edge.toGoalId);
                      if (!to || edge.kind !== "gates") return null;
                      return (
                        <GateRow
                          key={`out-${edge.toGoalId}`}
                          direction="Unlocks"
                          title={to.node.goal.title}
                          openCount={edge.openIssueCount}
                          totalCount={edge.totalIssueCount}
                          onSelect={() => setSelection({ kind: "goal", id: edge.toGoalId })}
                        />
                      );
                    })}
                  </div>
                </InspectorSection>
              )}

              {selectedGoal.decompositions.length > 0 && (
                <InspectorSection title="Plans decomposed here">
                  <div className="space-y-2">
                    {selectedGoal.decompositions.map((decomposition) => (
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

              {selectedGoal.rootIssues.length > 0 && (
                <InspectorSection title="Tasks">
                  <div className="space-y-0.5">
                    {selectedGoal.rootIssues.map((issue) => (
                      <button
                        key={issue.id}
                        className="-mx-1 flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
                        onClick={() => setSelection({ kind: "issue", id: issue.id })}
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
                      </button>
                    ))}
                  </div>
                  {selectedGoal.rootIssuesTruncated && (
                    <p className="mt-1 text-xs text-muted-foreground">Showing the first {selectedGoal.rootIssues.length} — open the goal for all tasks.</p>
                  )}
                </InspectorSection>
              )}

              <div className="mt-auto pt-2">
                <Link to={`/goals/${selectedGoal.goal.id}`}>
                  <Button variant="outline" size="sm">Open goal</Button>
                </Link>
              </div>
            </>
          )}

          {selectedIssue && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  {selectedIssue.issue.identifier && (
                    <span className="font-mono text-xs text-muted-foreground">{selectedIssue.issue.identifier}</span>
                  )}
                  <IssueStatusBadge status={selectedIssue.issue.status} />
                </div>
                <h2 className="text-lg font-semibold leading-snug">{selectedIssue.issue.title}</h2>
              </div>

              <InspectorSection title="Why this exists">
                {selectedIssue.issue.rationale ? (
                  <p className="text-sm text-muted-foreground">{selectedIssue.issue.rationale}</p>
                ) : (
                  <p className="text-sm italic text-muted-foreground">No rationale recorded yet.</p>
                )}
                <div className="mt-2">
                  <WhyChain
                    chain={whyChain}
                    onSelectGoal={(goalId) => setSelection({ kind: "goal", id: goalId })}
                  />
                </div>
                {agentName(selectedIssue.issue.assigneeAgentId) && (
                  <div className="mt-2 flex items-center justify-between py-1.5">
                    <span className="text-xs text-muted-foreground">Assignee</span>
                    <span className="text-sm">{agentName(selectedIssue.issue.assigneeAgentId)}</span>
                  </div>
                )}
              </InspectorSection>

              {selectedIssue.issue.childTotalCount > 0 && (
                <InspectorSection title="Sub-tasks">
                  <div className="space-y-1">
                    <CountRow label="Done" value={selectedIssue.issue.childDoneCount} />
                    <CountRow label="Total" value={selectedIssue.issue.childTotalCount} />
                  </div>
                </InspectorSection>
              )}

              {(issueBlockedBy.length > 0 || issueBlocks.length > 0) && (
                <InspectorSection title="Blocking">
                  <div className="space-y-1">
                    {issueBlockedBy.map((edge) => {
                      const from = layout.placedIssueById.get(edge.fromIssueId);
                      if (!from) return null;
                      return (
                        <GateRow
                          key={`in-${edge.fromIssueId}`}
                          direction="Waits on"
                          title={from.issue.title}
                          openCount={edge.open ? 1 : 0}
                          totalCount={1}
                          onSelect={() => setSelection({ kind: "issue", id: edge.fromIssueId })}
                        />
                      );
                    })}
                    {issueBlocks.map((edge) => {
                      const to = layout.placedIssueById.get(edge.toIssueId);
                      if (!to) return null;
                      return (
                        <GateRow
                          key={`out-${edge.toIssueId}`}
                          direction="Unlocks"
                          title={to.issue.title}
                          openCount={edge.open ? 1 : 0}
                          totalCount={1}
                          onSelect={() => setSelection({ kind: "issue", id: edge.toIssueId })}
                        />
                      );
                    })}
                  </div>
                </InspectorSection>
              )}

              <div className="mt-auto pt-2">
                <Link to={`/issues/${selectedIssue.issue.id}`}>
                  <Button variant="outline" size="sm">Open task</Button>
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

function WhyChain({
  chain,
  onSelectGoal,
}: {
  chain: GoalMapNode[];
  onSelectGoal: (goalId: string) => void;
}) {
  if (chain.length === 0) return null;
  return (
    <div className="space-y-1">
      {chain.map((entry, index) => {
        const isLast = index === chain.length - 1;
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
                onClick={() => onSelectGoal(entry.goal.id)}
              >
                {entry.goal.title}
              </button>
            )}
          </div>
        );
      })}
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
