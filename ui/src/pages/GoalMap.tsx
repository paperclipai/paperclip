import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { List, Lock, Maximize2, Minus, Plus, Target } from "lucide-react";
import type { Agent, GoalMapIssueNode, GoalMapNode, GoalMapStatusCounts } from "@paperclipai/shared";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
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
import { StatusIcon } from "../components/StatusIcon";

// Layout constants (left-to-right layered tree; task pills match the approved
// grouping preview: slim leaves, two-row parents with subtree progress).
const GOAL_W = 240;
const GOAL_H = 66;
const TASK_W = 260;
const LEAF_H = 30;
const PARENT_H = 46;
const VGAP = 8;
const GAP_X = 60;
const COL_STEP = TASK_W + 40;
const GOAL_GAP = 34;
const PADDING = 60;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const DRAG_THRESHOLD = 5;

interface PlacedGoal {
  node: GoalMapNode;
  x: number;
  y: number;
}

interface PlacedIssue {
  issue: GoalMapIssueNode;
  x: number;
  y: number;
  h: number;
}

interface IssueTreeInfo {
  /** Same-goal parent used for tree layout (differs from raw parentId when the parent sits in another goal). */
  layoutParentById: Map<string, string>;
  childrenById: Map<string, GoalMapIssueNode[]>;
  rootsByGoalId: Map<string, GoalMapIssueNode[]>;
  subtreeStatsById: Map<string, { done: number; denom: number }>;
  maxDepthByGoalId: Map<string, number>;
}

interface GoalMapLayout {
  placedGoals: PlacedGoal[];
  placedGoalById: Map<string, PlacedGoal>;
  placedIssues: PlacedIssue[];
  placedIssueById: Map<string, PlacedIssue>;
  width: number;
  height: number;
}

function buildIssueTrees(issues: GoalMapIssueNode[]): IssueTreeInfo {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const layoutParentById = new Map<string, string>();
  const childrenById = new Map<string, GoalMapIssueNode[]>();
  const rootsByGoalId = new Map<string, GoalMapIssueNode[]>();
  for (const issue of issues) {
    const parent = issue.parentId ? issueById.get(issue.parentId) : undefined;
    if (parent && parent.goalId === issue.goalId) {
      layoutParentById.set(issue.id, parent.id);
      const siblings = childrenById.get(parent.id) ?? [];
      siblings.push(issue);
      childrenById.set(parent.id, siblings);
    } else {
      const roots = rootsByGoalId.get(issue.goalId) ?? [];
      roots.push(issue);
      rootsByGoalId.set(issue.goalId, roots);
    }
  }
  // Orphan guard: a same-goal parentId cycle would leave nodes unrooted; the
  // layout only walks from roots, so promote any cycle member to a root.
  const reachable = new Set<string>();
  const walk = (issue: GoalMapIssueNode) => {
    if (reachable.has(issue.id)) return;
    reachable.add(issue.id);
    for (const child of childrenById.get(issue.id) ?? []) walk(child);
  };
  for (const roots of rootsByGoalId.values()) roots.forEach(walk);
  for (const issue of issues) {
    if (reachable.has(issue.id)) continue;
    layoutParentById.delete(issue.id);
    const roots = rootsByGoalId.get(issue.goalId) ?? [];
    roots.push(issue);
    rootsByGoalId.set(issue.goalId, roots);
    walk(issue);
  }

  const subtreeStatsById = new Map<string, { done: number; denom: number }>();
  const collectStats = (issue: GoalMapIssueNode): { done: number; denom: number } => {
    const memoized = subtreeStatsById.get(issue.id);
    if (memoized) return memoized;
    const stats = { done: 0, denom: 0 };
    for (const child of childrenById.get(issue.id) ?? []) {
      if (child.status === "done") stats.done += 1;
      if (child.status !== "cancelled") stats.denom += 1;
      const childStats = collectStats(child);
      stats.done += childStats.done;
      stats.denom += childStats.denom;
    }
    subtreeStatsById.set(issue.id, stats);
    return stats;
  };
  const maxDepthByGoalId = new Map<string, number>();
  for (const [goalId, roots] of rootsByGoalId) {
    let maxDepth = 0;
    const measure = (issue: GoalMapIssueNode, depth: number) => {
      if (depth > maxDepth) maxDepth = depth;
      collectStats(issue);
      for (const child of childrenById.get(issue.id) ?? []) measure(child, depth + 1);
    };
    roots.forEach((root) => measure(root, 1));
    maxDepthByGoalId.set(goalId, maxDepth);
  }
  return { layoutParentById, childrenById, rootsByGoalId, subtreeStatsById, maxDepthByGoalId };
}

function isLayoutAncestor(trees: IssueTreeInfo, ancestorId: string, issueId: string): boolean {
  const seen = new Set<string>();
  let current = trees.layoutParentById.get(issueId);
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = trees.layoutParentById.get(current);
  }
  return false;
}

function issueNodeHeight(trees: IssueTreeInfo, issue: GoalMapIssueNode): number {
  return (trees.childrenById.get(issue.id)?.length ?? 0) > 0 ? PARENT_H : LEAF_H;
}

function layoutGoalMap(nodes: GoalMapNode[], trees: IssueTreeInfo): GoalMapLayout {
  const nodeIds = new Set(nodes.map((n) => n.goal.id));
  const goalChildren = new Map<string, GoalMapNode[]>();
  for (const node of nodes) {
    const parentId = node.goal.parentId;
    if (!parentId || !nodeIds.has(parentId)) continue;
    const siblings = goalChildren.get(parentId) ?? [];
    siblings.push(node);
    goalChildren.set(parentId, siblings);
  }
  const goalRoots = nodes.filter((n) => !n.goal.parentId || !nodeIds.has(n.goal.parentId));

  const issueHeightMemo = new Map<string, number>();
  function issueSubH(issue: GoalMapIssueNode): number {
    const memoized = issueHeightMemo.get(issue.id);
    if (memoized !== undefined) return memoized;
    let h = issueNodeHeight(trees, issue) + VGAP;
    const children = trees.childrenById.get(issue.id) ?? [];
    if (children.length > 0) {
      let sum = 0;
      for (const child of children) sum += issueSubH(child);
      h = Math.max(h, sum);
    }
    issueHeightMemo.set(issue.id, h);
    return h;
  }
  function goalIssuesHeight(goalId: string): number {
    let h = 0;
    for (const root of trees.rootsByGoalId.get(goalId) ?? []) h += issueSubH(root);
    return h;
  }
  const goalHeightMemo = new Map<string, number>();
  function goalSubH(node: GoalMapNode, stack: Set<string>): number {
    const memoized = goalHeightMemo.get(node.goal.id);
    if (memoized !== undefined) return memoized;
    if (stack.has(node.goal.id)) return GOAL_H + VGAP;
    stack.add(node.goal.id);
    const issuesHeight = goalIssuesHeight(node.goal.id);
    const children = goalChildren.get(node.goal.id) ?? [];
    const childrenHeight = children.length > 0
      ? children.reduce((sum, child) => sum + goalSubH(child, stack), 0) + (children.length - 1) * GOAL_GAP
      : 0;
    const separator = issuesHeight > 0 && childrenHeight > 0 ? GOAL_GAP : 0;
    const height = Math.max(GOAL_H + VGAP, issuesHeight + separator + childrenHeight);
    stack.delete(node.goal.id);
    goalHeightMemo.set(node.goal.id, height);
    return height;
  }

  const placedGoalById = new Map<string, PlacedGoal>();
  const placedIssueById = new Map<string, PlacedIssue>();
  function placeIssue(issue: GoalMapIssueNode, x: number, y: number) {
    const h = issueSubH(issue);
    const nodeH = issueNodeHeight(trees, issue);
    placedIssueById.set(issue.id, { issue, x, y: y + (h - VGAP - nodeH) / 2, h: nodeH });
    let cy = y;
    for (const child of trees.childrenById.get(issue.id) ?? []) {
      placeIssue(child, x + COL_STEP, cy);
      cy += issueSubH(child);
    }
  }
  function placeGoal(node: GoalMapNode, x: number, y: number) {
    if (placedGoalById.has(node.goal.id)) return;
    const totalHeight = goalSubH(node, new Set());
    placedGoalById.set(node.goal.id, { node, x, y: y + (totalHeight - VGAP - GOAL_H) / 2 });
    const childX = x + GOAL_W + GAP_X;
    let cy = y;
    const roots = trees.rootsByGoalId.get(node.goal.id) ?? [];
    for (const root of roots) {
      placeIssue(root, childX, cy);
      cy += issueSubH(root);
    }
    const children = goalChildren.get(node.goal.id) ?? [];
    if (roots.length > 0 && children.length > 0) cy += GOAL_GAP - VGAP;
    for (const child of children) {
      placeGoal(child, childX, cy);
      cy += goalSubH(child, new Set()) + GOAL_GAP;
    }
  }

  let yCursor = PADDING;
  for (const root of goalRoots) {
    placeGoal(root, PADDING, yCursor);
    yCursor += goalSubH(root, new Set()) + GOAL_GAP;
  }
  for (const node of nodes) {
    if (placedGoalById.has(node.goal.id)) continue;
    placedGoalById.set(node.goal.id, { node, x: PADDING, y: yCursor });
    yCursor += GOAL_H + VGAP;
  }

  const placedGoals = [...placedGoalById.values()];
  const placedIssues = [...placedIssueById.values()];
  let width = 800;
  let height = 600;
  for (const p of placedGoals) {
    width = Math.max(width, p.x + GOAL_W + PADDING);
    height = Math.max(height, p.y + GOAL_H + PADDING);
  }
  for (const p of placedIssues) {
    width = Math.max(width, p.x + TASK_W + PADDING);
    height = Math.max(height, p.y + p.h + PADDING);
  }
  return { placedGoals, placedGoalById, placedIssues, placedIssueById, width, height };
}

function progressDenominator(counts: GoalMapStatusCounts): number {
  return Math.max(0, counts.total - counts.cancelled);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/** Right-side bracket for edges between cards stacked in the same column. */
function sideBracket(x1: number, y1: number, x2: number, y2: number): string {
  const bulge = Math.min(96, 36 + Math.abs(y2 - y1) * 0.08);
  return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

type Selection = { kind: "goal"; id: string } | { kind: "issue"; id: string } | null;
type DropTarget = { kind: "goal"; id: string } | { kind: "issue"; id: string } | null;

export function GoalMap() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const updateIssue = useMutation({
    mutationFn: ({ issueId, data }: { issueId: string; data: Record<string, unknown> }) =>
      issuesApi.update(issueId, data),
    onSettled: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.map(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }
    },
  });

  const trees = useMemo(() => buildIssueTrees(goalMap?.issues ?? []), [goalMap]);
  const layout = useMemo(() => layoutGoalMap(goalMap?.nodes ?? [], trees), [goalMap, trees]);
  const issueById = useMemo(
    () => new Map((goalMap?.issues ?? []).map((issue) => [issue.id, issue])),
    [goalMap],
  );
  const gateEdges = useMemo(
    () => (goalMap?.edges ?? []).filter((e) => e.kind === "gates"),
    [goalMap],
  );
  const parentEdges = useMemo(
    () => (goalMap?.edges ?? []).filter((e) => e.kind === "parent"),
    [goalMap],
  );
  // Blocks arrows: only cross-branch — a task gating its own layout ancestor
  // (blockParentUntilDone) is already expressed by containment.
  const crossBranchIssueEdges = useMemo(
    () => (goalMap?.issueEdges ?? []).filter((edge) =>
      !isLayoutAncestor(trees, edge.fromIssueId, edge.toIssueId) &&
      !isLayoutAncestor(trees, edge.toIssueId, edge.fromIssueId)),
    [goalMap, trees],
  );

  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => {
    if (selection?.kind === "goal" && layout.placedGoalById.has(selection.id)) return;
    if (selection?.kind === "issue" && layout.placedIssueById.has(selection.id)) return;
    setSelection(layout.placedGoals[0] ? { kind: "goal", id: layout.placedGoals[0].node.goal.id } : null);
  }, [layout, selection]);

  const selectedGoal = selection?.kind === "goal" ? layout.placedGoalById.get(selection.id)?.node ?? null : null;
  const selectedIssue = selection?.kind === "issue" ? layout.placedIssueById.get(selection.id)?.issue ?? null : null;

  const nodeByGoalId = useMemo(
    () => new Map((goalMap?.nodes ?? []).map((n) => [n.goal.id, n])),
    [goalMap],
  );
  const goalChainFor = useCallback((goalId: string): GoalMapNode[] => {
    const chain: GoalMapNode[] = [];
    const seen = new Set<string>();
    let current = nodeByGoalId.get(goalId);
    while (current && !seen.has(current.goal.id)) {
      seen.add(current.goal.id);
      chain.unshift(current);
      current = current.goal.parentId ? nodeByGoalId.get(current.goal.parentId) : undefined;
    }
    return chain;
  }, [nodeByGoalId]);
  const whyChain = useMemo(() => {
    if (selectedGoal) return goalChainFor(selectedGoal.goal.id);
    if (selectedIssue) return goalChainFor(selectedIssue.goalId);
    return [];
  }, [selectedGoal, selectedIssue, goalChainFor]);
  const issueAncestors = useMemo(() => {
    if (!selectedIssue) return [];
    const chain: GoalMapIssueNode[] = [];
    const seen = new Set<string>();
    let currentId = trees.layoutParentById.get(selectedIssue.id);
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const ancestor = issueById.get(currentId);
      if (!ancestor) break;
      chain.unshift(ancestor);
      currentId = trees.layoutParentById.get(currentId);
    }
    return chain;
  }, [selectedIssue, trees, issueById]);

  const inboundGates = useMemo(
    () => (selectedGoal ? gateEdges.filter((e) => e.toGoalId === selectedGoal.goal.id) : []),
    [gateEdges, selectedGoal],
  );
  const outboundGates = useMemo(
    () => (selectedGoal ? gateEdges.filter((e) => e.fromGoalId === selectedGoal.goal.id) : []),
    [gateEdges, selectedGoal],
  );
  const issueBlockedBy = useMemo(
    () => (selectedIssue ? crossBranchIssueEdges.filter((e) => e.toIssueId === selectedIssue.id) : []),
    [crossBranchIssueEdges, selectedIssue],
  );
  const issueBlocks = useMemo(
    () => (selectedIssue ? crossBranchIssueEdges.filter((e) => e.fromIssueId === selectedIssue.id) : []),
    [crossBranchIssueEdges, selectedIssue],
  );

  // Pan & zoom + drag-to-move
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dragState = useRef<{ issueId: string; startX: number; startY: number; moved: boolean } | null>(null);
  const [draggingIssueId, setDraggingIssueId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const suppressNextClick = useRef(false);

  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }, [pan, zoom]);

  const hitTest = useCallback((clientX: number, clientY: number, excludeIssueId: string): DropTarget => {
    const point = toCanvasPoint(clientX, clientY);
    for (const placed of layout.placedIssues) {
      if (placed.issue.id === excludeIssueId) continue;
      if (point.x >= placed.x && point.x <= placed.x + TASK_W &&
          point.y >= placed.y && point.y <= placed.y + placed.h) {
        return { kind: "issue", id: placed.issue.id };
      }
    }
    for (const placed of layout.placedGoals) {
      if (point.x >= placed.x && point.x <= placed.x + GOAL_W &&
          point.y >= placed.y && point.y <= placed.y + GOAL_H) {
        return { kind: "goal", id: placed.node.goal.id };
      }
    }
    return null;
  }, [layout, toCanvasPoint]);

  const isValidDropTarget = useCallback((issueId: string, target: DropTarget): boolean => {
    if (!target) return false;
    if (target.kind === "issue") {
      if (target.id === issueId) return false;
      // No dropping a task into its own subtree.
      if (isLayoutAncestor(trees, issueId, target.id)) return false;
      const current = issueById.get(issueId);
      return current?.parentId !== target.id;
    }
    const current = issueById.get(issueId);
    if (!current) return false;
    // Goal drop makes the task a root of that goal.
    return current.goalId !== target.id || trees.layoutParentById.has(issueId);
  }, [trees, issueById]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const issueCard = target.closest<HTMLElement>("[data-map-issue-id]");
    if (issueCard) {
      dragState.current = {
        issueId: issueCard.dataset.mapIssueId!,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      return;
    }
    if (target.closest("[data-goal-map-card]")) return;
    setPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragState.current;
    if (drag) {
      if (!drag.moved &&
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) {
        return;
      }
      drag.moved = true;
      setDraggingIssueId(drag.issueId);
      const target = hitTest(e.clientX, e.clientY, drag.issueId);
      setDropTarget(isValidDropTarget(drag.issueId, target) ? target : null);
      return;
    }
    if (!panning) return;
    setPan({
      x: panStart.current.panX + e.clientX - panStart.current.x,
      y: panStart.current.panY + e.clientY - panStart.current.y,
    });
  }, [panning, hitTest, isValidDropTarget]);

  const handleMouseUp = useCallback(() => {
    const drag = dragState.current;
    dragState.current = null;
    setPanning(false);
    if (drag?.moved) {
      suppressNextClick.current = true;
      window.setTimeout(() => { suppressNextClick.current = false; }, 300);
      if (dropTarget) {
        if (dropTarget.kind === "issue") {
          const targetIssue = issueById.get(dropTarget.id);
          updateIssue.mutate({
            issueId: drag.issueId,
            data: { parentId: dropTarget.id, ...(targetIssue ? { goalId: targetIssue.goalId } : {}) },
          });
        } else {
          updateIssue.mutate({ issueId: drag.issueId, data: { parentId: null, goalId: dropTarget.id } });
        }
        setSelection({ kind: "issue", id: drag.issueId });
      }
    }
    setDraggingIssueId(null);
    setDropTarget(null);
  }, [dropTarget, issueById, updateIssue]);

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

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || layout.placedGoals.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;
    fitToScreen();
  }, [layout, fitToScreen]);

  const selectIssue = useCallback((issueId: string) => {
    if (suppressNextClick.current) return;
    setSelection({ kind: "issue", id: issueId });
  }, []);

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
        {goalMap.issuesTruncated && (
          <span className="text-xs text-muted-foreground">Showing the first {goalMap.issues.length} tasks.</span>
        )}
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
          style={{
            cursor: draggingIssueId ? "grabbing" : panning ? "grabbing" : "grab",
            touchAction: "none",
            overscrollBehavior: "contain",
          }}
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
                    d={curve(from.x + GOAL_W, from.y + GOAL_H / 2, to.x, to.y + GOAL_H / 2)}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    markerEnd="url(#goal-map-arrow-parent)"
                  />
                );
              })}
              {layout.placedIssues.map((placed) => {
                const layoutParentId = trees.layoutParentById.get(placed.issue.id);
                if (layoutParentId) {
                  const parent = layout.placedIssueById.get(layoutParentId);
                  if (!parent) return null;
                  return (
                    <path
                      key={`tree-${placed.issue.id}`}
                      d={curve(parent.x + TASK_W, parent.y + parent.h / 2, placed.x, placed.y + placed.h / 2)}
                      fill="none"
                      stroke="var(--border)"
                      strokeOpacity={0.55}
                      strokeWidth={1.2}
                    />
                  );
                }
                const goal = layout.placedGoalById.get(placed.issue.goalId);
                if (!goal) return null;
                return (
                  <path
                    key={`tree-${placed.issue.id}`}
                    d={curve(goal.x + GOAL_W, goal.y + GOAL_H / 2, placed.x, placed.y + placed.h / 2)}
                    fill="none"
                    stroke="var(--border)"
                    strokeOpacity={0.7}
                    strokeWidth={1.2}
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
                    d={curve(from.x + GOAL_W, from.y + GOAL_H / 2, to.x, to.y + GOAL_H / 2)}
                    fill="none"
                    stroke={open ? "var(--hex-facc15)" : "var(--hex-4ade80)"}
                    strokeOpacity={open ? 0.9 : 0.55}
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                    markerEnd={`url(#goal-map-arrow-gate-${open ? "open" : "cleared"})`}
                  />
                );
              })}
              {crossBranchIssueEdges.map((edge) => {
                const from = layout.placedIssueById.get(edge.fromIssueId);
                const to = layout.placedIssueById.get(edge.toIssueId);
                if (!from || !to) return null;
                const sameColumn = Math.abs(from.x - to.x) < 1;
                return (
                  <path
                    key={`blocks-${edge.fromIssueId}-${edge.toIssueId}`}
                    d={sameColumn
                      ? sideBracket(from.x + TASK_W, from.y + from.h / 2, to.x + TASK_W, to.y + to.h / 2)
                      : curve(from.x + TASK_W, from.y + from.h / 2, to.x, to.y + to.h / 2)}
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
              const isDropTarget = dropTarget?.kind === "goal" && dropTarget.id === node.goal.id;
              const depth = trees.maxDepthByGoalId.get(node.goal.id) ?? 0;
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
                    isDropTarget && "border-ring ring-2 ring-ring",
                  )}
                  style={{ left: x, top: y, width: GOAL_W, height: GOAL_H }}
                  onClick={() => {
                    if (!suppressNextClick.current) setSelection({ kind: "goal", id: node.goal.id });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ kind: "goal", id: node.goal.id });
                    }
                  }}
                >
                  <div className="flex h-full flex-col justify-center gap-1 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">{node.goal.title}</span>
                      {node.gated && <Lock aria-label="Gated by open blockers" className="h-3 w-3 shrink-0 text-(--hex-facc15)" />}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {node.subtreeCounts.done}/{denom}{depth > 0 ? ` · d${depth}` : ""}
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })}
            {layout.placedIssues.map(({ issue, x, y, h }) => {
              const isSelected = selection?.kind === "issue" && selection.id === issue.id;
              const isDropTarget = dropTarget?.kind === "issue" && dropTarget.id === issue.id;
              const isDragging = draggingIssueId === issue.id;
              const stats = trees.subtreeStatsById.get(issue.id);
              const hasKids = (trees.childrenById.get(issue.id)?.length ?? 0) > 0;
              const pct = stats && stats.denom > 0 ? Math.round((stats.done / stats.denom) * 100) : 0;
              return (
                <Card
                  key={issue.id}
                  data-goal-map-card
                  data-map-issue-id={issue.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Task ${issue.title}`}
                  title={issue.title}
                  className={cn(
                    "absolute block cursor-pointer overflow-hidden rounded-lg py-0 select-none transition-(--tp-box-shadow-border-color) duration-150 hover:border-foreground/20 hover:shadow-md",
                    issue.status === "done" && "border-green-700/30 bg-green-500/10",
                    issue.status === "blocked" && "bg-yellow-500/10",
                    issue.status === "cancelled" && "opacity-60",
                    isSelected && "border-ring ring-2 ring-ring/40",
                    isDropTarget && "border-ring ring-2 ring-ring",
                    isDragging && "opacity-50",
                  )}
                  style={{ left: x, top: y, width: TASK_W, height: h }}
                  onClick={() => selectIssue(issue.id)}
                  onDoubleClick={() => navigate(`/issues/${issue.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ kind: "issue", id: issue.id });
                    }
                  }}
                >
                  <div className={cn("flex h-full flex-col justify-center gap-0.5 px-2 py-1", issue.status === "in_progress" && "border-l-2 border-(--status-task-icon-in_progress)", issue.status === "in_review" && "border-l-2 border-(--status-task-icon-in_review)")}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0"><StatusGlyph status={issue.status} size="sm" /></span>
                      {issue.identifier && (
                        <span className="shrink-0 font-mono text-(length:--text-nano) text-muted-foreground">{issue.identifier}</span>
                      )}
                      <span className={cn("truncate text-xs font-medium", issue.status === "cancelled" && "text-muted-foreground line-through")}>
                        {issue.title}
                      </span>
                    </div>
                    {hasKids && stats && (
                      <div className="flex items-center gap-1.5 pl-5">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="shrink-0 font-mono text-(length:--text-nano) tabular-nums text-muted-foreground">
                          {stats.done}/{stats.denom}
                        </span>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>

          {draggingIssueId && (
            <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
              Drop on a task to nest under it, or on a goal to move it there.
            </div>
          )}
        </div>

        {/* Inspector */}
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-background p-4 md:w-80 md:border-t-0 md:border-l">
          {!selectedGoal && !selectedIssue && (
            <p className="text-sm text-muted-foreground">Select a goal or task. Drag a task onto another task or goal to move it; double-click to open it.</p>
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
                <WhyChain chain={whyChain} onSelectGoal={(goalId) => setSelection({ kind: "goal", id: goalId })} />
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
                  {selectedIssue.identifier && (
                    <span className="font-mono text-xs text-muted-foreground">{selectedIssue.identifier}</span>
                  )}
                  <IssueStatusBadge status={selectedIssue.status} />
                </div>
                <h2 className="text-lg font-semibold leading-snug">{selectedIssue.title}</h2>
              </div>

              <InspectorSection title="Actions">
                <div className="flex items-center gap-3">
                  <StatusIcon
                    status={selectedIssue.status}
                    showLabel
                    onChange={(status) => updateIssue.mutate({ issueId: selectedIssue.id, data: { status } })}
                  />
                  <Link to={`/issues/${selectedIssue.id}`} className="ml-auto">
                    <Button variant="outline" size="sm">Open task</Button>
                  </Link>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Drag the card to move it under another task or goal. Double-click opens the full task.
                </p>
              </InspectorSection>

              <InspectorSection title="Why this exists">
                {selectedIssue.rationale ? (
                  <p className="text-sm text-muted-foreground">{selectedIssue.rationale}</p>
                ) : (
                  <p className="text-sm italic text-muted-foreground">No rationale recorded yet.</p>
                )}
                <div className="mt-2">
                  <WhyChain chain={whyChain} onSelectGoal={(goalId) => setSelection({ kind: "goal", id: goalId })} />
                </div>
                {issueAncestors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="text-xs text-muted-foreground">Inside</span>
                    {issueAncestors.map((ancestor) => (
                      <button
                        key={ancestor.id}
                        className="flex w-full items-baseline gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => setSelection({ kind: "issue", id: ancestor.id })}
                      >
                        {ancestor.identifier && <span className="font-mono text-xs">{ancestor.identifier}</span>}
                        <span className="truncate">{ancestor.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                {agentName(selectedIssue.assigneeAgentId) && (
                  <div className="mt-2 flex items-center justify-between py-1.5">
                    <span className="text-xs text-muted-foreground">Assignee</span>
                    <span className="text-sm">{agentName(selectedIssue.assigneeAgentId)}</span>
                  </div>
                )}
              </InspectorSection>

              {(trees.subtreeStatsById.get(selectedIssue.id)?.denom ?? 0) > 0 && (
                <InspectorSection title="Sub-tasks">
                  <div className="space-y-1">
                    <CountRow label="Done" value={trees.subtreeStatsById.get(selectedIssue.id)!.done} />
                    <CountRow label="Total" value={trees.subtreeStatsById.get(selectedIssue.id)!.denom} />
                  </div>
                </InspectorSection>
              )}

              {(issueBlockedBy.length > 0 || issueBlocks.length > 0) && (
                <InspectorSection title="Blocking">
                  <div className="space-y-1">
                    {issueBlockedBy.map((edge) => {
                      const from = issueById.get(edge.fromIssueId);
                      if (!from) return null;
                      return (
                        <GateRow
                          key={`in-${edge.fromIssueId}`}
                          direction="Waits on"
                          title={from.title}
                          openCount={edge.open ? 1 : 0}
                          totalCount={1}
                          onSelect={() => setSelection({ kind: "issue", id: edge.fromIssueId })}
                        />
                      );
                    })}
                    {issueBlocks.map((edge) => {
                      const to = issueById.get(edge.toIssueId);
                      if (!to) return null;
                      return (
                        <GateRow
                          key={`out-${edge.toIssueId}`}
                          direction="Unlocks"
                          title={to.title}
                          openCount={edge.open ? 1 : 0}
                          totalCount={1}
                          onSelect={() => setSelection({ kind: "issue", id: edge.toIssueId })}
                        />
                      );
                    })}
                  </div>
                </InspectorSection>
              )}
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
