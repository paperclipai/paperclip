import { AdapterMark } from "@/components/AdapterMark";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { composerDefaultModel, EFFORT_LABELS, readComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { OrgChartControls, type OrgChartActions } from "@/components/OrgChartControls";
import { AgentCharacter } from "@/components/AgentCharacter";
import { StarToggle } from "@/components/StarToggle";
import { useResourceMemberships, useResourceMembershipMutation } from "@/hooks/useResourceMemberships";
import { AgentAvatar } from "@/components/AgentAvatar";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useMemo, useCallback, useId, useImperativeHandle, type Ref } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { layoutOrganization, routeReportingEdges, type LayoutNode } from "./org-chart/layout";
import { collectChartTasks } from "./org-chart/tasks";
import { createTaskPreview } from "./org-chart/task-preview";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { Download, Network, Upload, Layers, Paperclip } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";

const modelLabels = new Map([...claudeModels, ...codexModels].map(model => [model.id, model.label]));
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2;
const FIT_PADDING = 40;
const TOUCH_MOVE_THRESHOLD = 6;

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

// ── Layout algorithm ────────────────────────────────────────────────────

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

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function fitChartToViewport(
  containerWidth: number,
  containerHeight: number,
  bounds: { width: number; height: number; maxFitZoom: number },
  topInset: number,
): { zoom: number; pan: Point } | null {
  if (containerWidth <= FIT_PADDING || containerHeight - topInset <= FIT_PADDING || bounds.width <= 0 || bounds.height <= 0) return null;

  const scaleX = (containerWidth - FIT_PADDING) / bounds.width;
  const scaleY = (containerHeight - topInset - FIT_PADDING) / bounds.height;
  const zoom = clampZoom(Math.min(scaleX, scaleY, bounds.maxFitZoom));
  const chartWidth = bounds.width * zoom;
  const chartHeight = bounds.height * zoom;

  return {
    zoom,
    pan: {
      x: (containerWidth - chartWidth) / 2,
      y: topInset + (containerHeight - topInset - chartHeight) / 2,
    },
  };
}

function touchPoint(touch: React.Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

import { agentDisplayAdapterType } from "../adapters/adapter-display-registry";

// ── Main component ──────────────────────────────────────────────────────

export interface OrgChartProps {
  /** Pre-filtered tree for embedding the chart in another collection page. */
  orgTree?: OrgNode[];
  /** Agent records paired with a pre-filtered embedded tree. */
  agents?: Agent[];
  /** Nonmatching agents remain in place and navigable, with reduced opacity. */
  matchingAgentIds?: ReadonlySet<string>;
  /** Hides page-level actions and breadcrumb ownership. */
  embedded?: boolean;
  /** Toolbar slot beside New Agent when embedded in the roster. */
  controlsContainer?: HTMLElement | null;
  /** Let an external toolbar own camera controls through view transitions. */
  actionsRef?: Ref<OrgChartActions>;
  /** Task layering is hidden on product surfaces while its design is being explored. */
  enableTaskLayer?: boolean;
}

export function OrgChart({ orgTree: providedOrgTree, agents: providedAgents, matchingAgentIds, embedded = false, controlsContainer, actionsRef, enableTaskLayer = false }: OrgChartProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const simulateTasks = import.meta.env.DEV && new URLSearchParams(location.search).get("orgTasks") === "demo";
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // button is hidden rather than dead-ending. Export stays available. Both
  // buttons also respect the operator-hidden settings registry.
  const isCloud = Boolean(useCloudInstance());
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showImport = !isCloud && !hiddenSettings.has("company.import");
  const showExport = !hiddenSettings.has("company.export");

  const orgTreeQuery = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedOrgTree === undefined,
  });
  const { data: queriedOrgTree, isLoading } = orgTreeQuery;
  const orgTreeView = useQueryView(orgTreeQuery);

  const { data: queriedAgents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedAgents === undefined,
  });
  const orgTree = providedOrgTree ?? queriedOrgTree;
  const agents = providedAgents ?? queriedAgents;

  const memberships = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const starredAgents = useMemo(() => new Set(memberships.data?.starredAgentIds ?? []), [memberships.data?.starredAgentIds]);

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: "Org Chart" }]);
  }, [embedded, setBreadcrumbs]);

  const [tasksVisible, setShowTasks] = useState(simulateTasks);
  const showTasks = enableTaskLayer && tasksVisible;
  const taskRunsQuery = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "org-chart-tasks"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { limit: 100 }),
    enabled: Boolean(selectedCompanyId && showTasks && !simulateTasks), refetchInterval: showTasks && !simulateTasks ? 15000 : false,
  });
  const taskIds = useMemo(() => [...new Set((taskRunsQuery.data ?? []).filter(run => run.status === "running" && run.issueId).map(run => run.issueId!))].sort(), [taskRunsQuery.data]);
  const taskTitlesQuery = useQuery({
    queryKey: ["org-chart-task-titles", selectedCompanyId, taskIds],
    queryFn: async () => {
      const titles = [];
      for (let start = 0; start < taskIds.length; start += ISSUE_SUMMARIES_MAX_IDS) {
        titles.push(...await issuesApi.summaries(selectedCompanyId!, taskIds.slice(start, start + ISSUE_SUMMARIES_MAX_IDS)));
      }
      return titles;
    },
    enabled: Boolean(selectedCompanyId && showTasks && taskIds.length && !simulateTasks),
  });
  const taskRunsView = useQueryView(taskRunsQuery);
  const taskTitlesView = useQueryView(taskTitlesQuery);
  const tasks = useMemo(() => {
    if (!showTasks) return [];
    if (simulateTasks) return createTaskPreview(orgTree ?? []);
    return collectChartTasks(taskRunsQuery.data ?? [], taskTitlesQuery.data ?? [], new Set(agentMap.keys()));
  }, [showTasks, simulateTasks, orgTree, taskRunsQuery.data, taskTitlesQuery.data, agentMap]);
  const [geometry] = useState(() => {
    const css = getComputedStyle(document.documentElement);
    const value = (name: string) => parseFloat(css.getPropertyValue(`--org-${name}`)) || 0;
    return { leaderWidth: value("leader-width"), leaderHeight: value("leader-height"), managerWidth: value("manager-width"), managerHeight: value("manager-height"), memberWidth: value("member-width"), memberHeight: value("member-height"), gap: value("gap"), levelGap: value("level-gap"), padding: value("padding"), sparsePadding: value("sparse-padding"), fitZoomMax: value("fit-zoom-max"), sparseFitZoomMax: value("sparse-fit-zoom-max"), taskHeight: value("task-height"), taskBandHeight: value("task-band-height"), taskLabelWidth: value("task-label-width"), taskLegendHeight: value("task-legend-height"), toolbarClearance: value("toolbar-clearance") };
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const taskMaskId = useId();
  const [taskScroll, setTaskScroll] = useState(0);
  const taskTouchX = useRef<number | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(embedded ? geometry.toolbarClearance : 0);
  useEffect(() => {
    const toolbar = controlsContainer?.closest(".agents-org-toolbar") as HTMLElement | null;
    if (!toolbar) return;
    const measure = () => setToolbarHeight(toolbar.offsetHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    return () => observer?.disconnect();
  }, [controlsContainer]);
  // When enabled, reserve a stable band so toggling the overlay never refits the tree.
  const topInset = toolbarHeight + (enableTaskLayer ? geometry.taskBandHeight : 0);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setViewport(previous => {
      const width = container.clientWidth, height = container.clientHeight;
      return width === previous.width && height === previous.height ? previous : { width, height };
    });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [orgTree]);
  const arrangement = useMemo(() => layoutOrganization(orgTree ?? [], { width: viewport.width, height: Math.max(0, viewport.height - topInset) }, geometry), [orgTree, viewport, geometry, topInset]);
  const layout = arrangement.roots;
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const nodesById = useMemo(() => new Map(allNodes.map(node => [node.id, node])), [allNodes]);
  const edges = useMemo(() => routeReportingEdges(layout, geometry.gap), [layout, geometry.gap]);
  const bounds = useMemo(() => ({ width: arrangement.width, height: arrangement.height, maxFitZoom: arrangement.maxFitZoom }), [arrangement]);

  // Pan & zoom state
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

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    hasInitialized.current = false;
  }, [orgTree, viewport, topInset]);

  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    const container = containerRef.current;
    const fitted = fitChartToViewport(container.clientWidth, container.clientHeight, bounds, topInset);
    if (!fitted) return;

    hasInitialized.current = true;
    setZoom(fitted.zoom);
    setPan(fitted.pan);
  }, [allNodes, bounds, topInset]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card], button, a")) return;
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
    const newZoom = clampZoom(zoom * factor);

    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  const zoomTowardPoint = useCallback((newZoom: number, point: Point) => {
    const clampedZoom = clampZoom(newZoom);
    const scale = clampedZoom / zoom;
    setPan({
      x: point.x - scale * (point.x - pan.x),
      y: point.y - scale * (point.y - pan.y),
    });
    setZoom(clampedZoom);
  }, [zoom, pan]);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const fitted = fitChartToViewport(
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      bounds,
      topInset,
    );
    if (!fitted) return;

    setZoom(fitted.zoom);
    setPan(fitted.pan);
  }, [bounds, topInset]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length >= 2 && containerRef.current) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
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
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !touchGesture.current.mode) return;

    if (e.touches.length >= 2) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
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
    touchGesture.current.moved = touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
    setPan({
      x: touchGesture.current.startPan.x + dx,
      y: touchGesture.current.startPan.y + dy,
    });
  }, [pan, zoom]);

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

  const cameraActions = useMemo<OrgChartActions>(() => ({
    zoomIn: () => zoomTowardPoint(zoom * 1.2, { x: viewport.width / 2, y: viewport.height / 2 }),
    zoomOut: () => zoomTowardPoint(zoom * 0.8, { x: viewport.width / 2, y: viewport.height / 2 }),
    fit: fitToScreen,
  }), [zoomTowardPoint, zoom, viewport, fitToScreen]);
  useImperativeHandle(actionsRef, () => cameraActions, [cameraActions]);
  const controls = (
    <OrgChartControls {...cameraActions}>
      {enableTaskLayer && <Button variant={showTasks ? "secondary" : "outline"} size="sm" aria-pressed={showTasks} onClick={() => setShowTasks(value => !value)}><Layers className="size-4" />Tasks</Button>}
    </OrgChartControls>
  );
  const taskWidth = Math.min(geometry.taskLabelWidth, Math.max(0, viewport.width - geometry.padding * 2));
  const taskGap = geometry.gap / 2;
  const taskContentWidth = tasks.length * (taskWidth + taskGap) - taskGap;
  const taskStartX = Math.max(geometry.padding, (viewport.width - taskContentWidth) / 2);
  const taskLabelY = toolbarHeight + geometry.taskLegendHeight;
  const taskLinks = useMemo(() => {
    const links: Array<{ key: string; node: LayoutNode; x: number }> = [];
    tasks.forEach((task, index) => {
      const x = taskStartX + index * (taskWidth + taskGap) - taskScroll;
      if (x + taskWidth < 0 || x > viewport.width) return;
      task.agentIds.forEach((id, agentIndex) => {
        const node = nodesById.get(id);
        if (node) links.push({ key: `${task.id}-${id}`, node, x: x + taskWidth * (agentIndex + 1) / (task.agentIds.length + 1) });
      });
    });
    return links;
  }, [tasks, taskStartX, taskWidth, taskGap, taskScroll, viewport.width, nodesById]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select an organization to view the org chart." />;
  }

  // Keep a loaded chart on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (providedOrgTree === undefined && (isLoading || orgTreeView.kind === "reconnecting")) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (providedOrgTree === undefined && orgTreeView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={orgTreeView.error}
        action="load the org chart"
        onRetry={orgTreeView.retry}
        retrying={orgTreeView.isFetching}
      />
    );
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div
      className={embedded
        ? "org-chart-shell flex min-h-0 flex-1 flex-col"
        : "flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0"}
    >
      {actionsRef ? null : controlsContainer ? createPortal(controls, controlsContainer) : !embedded ? <div className="mb-2 flex justify-end">{controls}</div> : null}
      {!embedded && (showImport || showExport) ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-start gap-2">
        {showImport ? (
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import organization
            </Button>
          </Link>
        ) : null}
        {showExport ? (
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export organization
            </Button>
          </Link>
        ) : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="org-chart-canvas w-full flex-1 min-h-0 overflow-hidden relative"
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
        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child, path }) => {
              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={path}
                  fill="none"
                  className="org-reporting-edge"
                  data-filter-match={matchingAgentIds ? matchingAgentIds.has(parent.id) && matchingAgentIds.has(child.id) : undefined}
                />
              );
            })}
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="org-chart-cards absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const adapterType = agent ? agentDisplayAdapterType(agent) : undefined;
            const model = composerDefaultModel(agent);
            const modelLabel = (modelLabels.get(model) ?? model.split("/").pop() ?? model)
              .replace(/^(?:Claude|Codex)\s+/i, "");
            const effort = agent ? readComposerRunSettings({ adapterConfig: agent.adapterConfig }, agent.adapterType).effort : null;
            const status = (agent?.status ?? node.status).replace(/_/g, " ");
            const statusLabel = status === "active" ? "Idle" : status.charAt(0).toUpperCase() + status.slice(1);
            const starPending = membershipMutation.isPending && membershipMutation.variables?.resourceId === node.id;
            const openAgent = () => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`);

            return (
              <Card
                key={node.id}
                data-org-card
                data-leader={node.leader}
                data-tier={node.tier}
                data-depth={node.depth}
                data-filter-match={matchingAgentIds ? matchingAgentIds.has(node.id) : undefined}
                interactive
                role="link"
                tabIndex={0}
                aria-label={`Open ${node.name} overview`}
                className="org-chart-agent-card absolute gap-0 select-none"
                onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) openAgent(); }}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width, height: node.height,
                }}
                onClick={openAgent}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {node.leader && <div className="org-card-badge-slot" aria-hidden />}
                <div className="org-card-heading min-w-0 text-left">
                  {node.leader && (
                    <StarToggle
                      size="button"
                      className="org-card-star"
                      starred={starredAgents.has(node.id)}
                      resourceName={node.name}
                      pending={starPending}
                      error={
                        membershipMutation.isError && membershipMutation.variables?.resourceId === node.id // query-error-ok: mutation feedback; cached cards remain visible
                      }
                      onToggle={(starred) => membershipMutation.mutate({ resourceType: "agent", resourceId: node.id, resourceName: node.name, starred })}
                    />
                  )}
                  <div className="org-card-name truncate font-medium text-foreground" title={node.name}>{node.name}</div>
                  <div className="org-card-title line-clamp-2 text-muted-foreground" title={agent?.title || roleLabel(node.role)}>
                    {agent?.title || roleLabel(node.role)}
                  </div>
                  {node.leader && <div className="org-card-status truncate text-muted-foreground">{statusLabel}</div>}
                </div>
                <div className="org-card-character flex min-h-0 items-center justify-center">
                  {node.leader ? (
                    <AgentCharacter agent={agent ?? { id: node.id, name: node.name }} size={256} state="idle" trackingScope="page" followCursor animationGroup="org-chart" className="org-card-live-character" />
                  ) : (
                    <AgentAvatar agent={agent ?? { id: node.id, name: node.name }} size={128} pose="rest" view="portrait" className="org-card-avatar" />
                  )}
                </div>
                {adapterType && (modelLabel || effort) && (
                  <div className="org-card-model min-w-0">
                    {modelLabel && (
                      <span className="org-card-model-label" title={model}>
                        <span className="org-card-model-mark">
                          <AdapterMark type={adapterType} className="size-4 shrink-0" />
                        </span>
                        <span className="org-card-model-name">{modelLabel}</span>
                      </span>
                    )}
                    {modelLabel && effort && " "}
                    {effort && (
                      <span className="org-card-effort text-muted-foreground" title={effort}>
                        {EFFORT_LABELS[effort] ?? effort}
                      </span>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
        {showTasks && <>
          <svg className="org-task-overlay absolute inset-0 size-full pointer-events-none" aria-hidden>
            <defs>
              <mask id={taskMaskId}>
                <rect width="100%" height="100%" className="org-task-mask-open" />
                {allNodes.map(node => <rect key={node.id} className="org-task-mask-card" x={pan.x + node.x * zoom} y={pan.y + node.y * zoom} width={node.width * zoom} height={node.height * zoom} />)}
              </mask>
            </defs>
            <g mask={`url(#${taskMaskId})`}>
              {taskLinks.map((link, index) => {
                const lane = pan.x + (link.node.x - geometry.gap * (0.25 + (index + 1) / (taskLinks.length + 1) * 0.5)) * zoom;
                const track = topInset + geometry.padding * zoom * (index + 1) / (taskLinks.length + 1);
                const targetX = pan.x + link.node.x * zoom;
                const targetY = pan.y + (link.node.y + link.node.height / 2) * zoom;
                return <path key={link.key} className="org-task-edge" d={`M ${link.x} ${taskLabelY + geometry.taskHeight} V ${track} H ${lane} V ${targetY} H ${targetX}`} fill="none" />;
              })}
            </g>
          </svg>
          <div className="org-task-band absolute inset-x-0" style={{ top: toolbarHeight }}>
            <div className="org-task-legend text-xs text-muted-foreground" role="status">
              {simulateTasks ? `${tasks.length} simulated running tasks · preview only`
                : taskRunsView.kind === "error" ? <QueryErrorState size="inline" error={taskRunsView.error} action="load running tasks" onRetry={taskRunsView.retry} />
                : taskTitlesView.kind === "error" && taskIds.length ? <QueryErrorState size="inline" error={taskTitlesView.error} action="load task titles" onRetry={taskTitlesView.retry} />
                : taskRunsView.kind === "stale" ? "Task updates paused while reconnecting…"
                : taskRunsQuery.isPending || taskRunsView.kind === "reconnecting" ? "Loading running tasks…" : tasks.length ? `${tasks.length} running ${tasks.length === 1 ? "task" : "tasks"}${(taskRunsQuery.data?.length ?? 0) >= 100 ? " · showing first 100 runs" : ""}` : "No running tasks"}
            </div>
            <div className="org-task-strip" onScroll={event => setTaskScroll(event.currentTarget.scrollLeft)} onWheel={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
              onTouchStart={event => { event.stopPropagation(); taskTouchX.current = event.touches[0]?.clientX ?? null; }}
              onTouchMove={event => {
                event.stopPropagation();
                const x = event.touches[0]?.clientX;
                if (taskTouchX.current !== null && x !== undefined) event.currentTarget.scrollLeft += taskTouchX.current - x;
                taskTouchX.current = x ?? null;
              }}
              onTouchEnd={event => { event.stopPropagation(); taskTouchX.current = null; }}
              onTouchCancel={event => { event.stopPropagation(); taskTouchX.current = null; }}>
              <div className="relative h-full" style={{ width: Math.max(viewport.width, taskContentWidth + geometry.padding * 2) }}>
                {tasks.map((task, index) => {
                  const labelProps = {
                    "data-org-task": true,
                    title: `${simulateTasks ? "Simulated task" : task.identifier ?? "Task"} · ${task.title} · Working: ${task.agentIds.map(id => agentMap.get(id)?.name ?? "Agent").join(", ")}`,
                    className: "org-task-label absolute flex items-center gap-1.5 rounded px-2 text-xs text-muted-foreground no-underline hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    style: { left: taskStartX + index * (taskWidth + taskGap), width: taskWidth, height: geometry.taskHeight },
                    children: <><Paperclip className="size-3 shrink-0" /><span className="truncate">{task.title}</span></>,
                  };
                  return simulateTasks ? <span key={task.id} {...labelProps} /> : <Link key={task.id} to={`/issues/${task.identifier ?? task.id}`} {...labelProps} />;
                })}
              </div>
            </div>
          </div>
        </>}
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
