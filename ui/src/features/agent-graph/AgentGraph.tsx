import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./agent-graph.css";
import type { Agent, AgentGraphLayout } from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { UiLayoutNotice } from "@/components/UiLayoutNotice";
import { useTheme } from "@/context/ThemeContext";
import { AGENT_GRAPH_NODE_TYPES } from "./AgentGraphNodes";
import { AgentGraphSidePanel } from "./AgentGraphSidePanel";
import { AgentGraphToolbar } from "./AgentGraphToolbar";
import { layoutHierarchy, type LayoutDirection } from "./lib/auto-layout";
import { commitNodePositions, syncEdges, syncNodes, type GraphFlowNode } from "./lib/graph-nodes";
import { useAgentGraphDocument } from "./useAgentGraphDocument";

const SNAP_GRID: [number, number] = [16, 16];
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1.25 };
const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set();

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export interface AgentGraphProps {
  companyId: string;
  agents: readonly Agent[];
  visibleAgentIdsKey?: string;
  className?: string;
}

export function AgentGraph(props: AgentGraphProps) {
  return (
    <ReactFlowProvider>
      <AgentGraphCanvas key={props.companyId} {...props} />
    </ReactFlowProvider>
  );
}

function AgentGraphCanvas({ companyId, agents, visibleAgentIdsKey, className }: AgentGraphProps) {
  const { theme } = useTheme();
  const flow = useReactFlow<GraphFlowNode, Edge>();
  const nodesInitialized = useNodesInitialized();
  const document = useAgentGraphDocument(companyId);
  const { layout, apply } = document;

  const [nodes, setNodes] = useState<GraphFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [keepManual, setKeepManual] = useState(true);
  const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const fittedRef = useRef(false);
  const viewportRestoreRef = useRef(-1);

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
  });
  const liveAgentIds = useMemo(() => {
    const runs = liveRunsQuery.data;
    if (!runs || runs.length === 0) return EMPTY_LIVE_IDS;
    return new Set(runs.map((run) => run.agentId));
  }, [liveRunsQuery.data]);

  const graphAgents = useMemo(() => {
    const visible = visibleAgentIdsKey === undefined ? null : new Set(visibleAgentIdsKey.split(","));
    return agents.filter((agent) => agent.status !== "terminated" && (visible === null || visible.has(agent.id)));
  }, [agents, visibleAgentIdsKey]);
  const agentsById = useMemo(() => {
    const index = new Map<string, Agent>();
    for (const agent of graphAgents) index.set(agent.id, agent);
    return index;
  }, [graphAgents]);
  const reportCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of graphAgents) {
      if (agent.reportsTo) counts.set(agent.reportsTo, (counts.get(agent.reportsTo) ?? 0) + 1);
    }
    return counts;
  }, [graphAgents]);
  const direction: LayoutDirection = layout?.direction ?? "TB";
  const autoPositions = useMemo(() => layoutHierarchy(graphAgents, { direction }), [graphAgents, direction]);
  const autoPositionsRef = useRef(autoPositions);
  autoPositionsRef.current = autoPositions;
  const companyAgentIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const companyAgentIdsRef = useRef(companyAgentIds);
  companyAgentIdsRef.current = companyAgentIds;

  useEffect(() => {
    if (!layout) return;
    const input = { agents: graphAgents, layout, autoPositions, liveAgentIds };
    setNodes((current) => syncNodes(current, input));
    setEdges((current) => syncEdges(current, input));
  }, [graphAgents, layout, autoPositions, liveAgentIds]);

  useEffect(() => {
    if (viewportRestoreRef.current === document.restoreCount || !nodesInitialized || !layout) return;
    viewportRestoreRef.current = document.restoreCount;
    fittedRef.current = true;
    if (layout.viewport) void flow.setViewport(layout.viewport);
    else void flow.fitView(FIT_VIEW_OPTIONS);
  }, [nodesInitialized, layout, flow, document.restoreCount]);

  useEffect(() => {
    if (panelAgentId && !agentsById.has(panelAgentId)) setPanelAgentId(null);
  }, [panelAgentId, agentsById]);

  const onNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setEdges((current) => applyEdgeChanges(changes.filter((change) => change.type === "select"), current));
  }, []);

  const commitPositions = useCallback(() => {
    apply((current) =>
      commitNodePositions(current, nodesRef.current, autoPositionsRef.current, companyAgentIdsRef.current));
  }, [apply]);

  const onMoveEnd = useCallback(
    (event: unknown, viewport: Viewport) => {
      if (!event || !fittedRef.current) return;
      document.setViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    },
    [document.setViewport],
  );

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setNodes((current) => current.map((node) => (node.selected ? node : { ...node, selected: true })));
    } else if (event.key === "Escape") {
      setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
      setPanelAgentId(null);
    }
  }, []);

  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key.startsWith("Arrow") && !isEditableTarget(event.target)) commitPositions();
    },
    [commitPositions],
  );

  const relayout = useCallback(
    (update: (current: AgentGraphLayout) => AgentGraphLayout) => {
      apply(update);
      window.requestAnimationFrame(() => void flow.fitView({ ...FIT_VIEW_OPTIONS, duration: 200 }));
    },
    [apply, flow],
  );
  const tidy = useCallback(() => {
    relayout((current) =>
      keepManual || Object.keys(current.positions).length === 0 ? current : { ...current, positions: {} });
  }, [relayout, keepManual]);
  const changeDirection = useCallback(
    (next: LayoutDirection) => {
      relayout((current) => ({ ...current, direction: next, positions: keepManual ? current.positions : {} }));
    },
    [relayout, keepManual],
  );

  const hideAgent = useCallback(
    (agentId: string) => {
      apply((current) =>
        current.hiddenAgentIds.includes(agentId) ? current : { ...current, hiddenAgentIds: [...current.hiddenAgentIds, agentId] });
      setPanelAgentId(null);
    },
    [apply],
  );
  const showHidden = useCallback(() => {
    apply((current) => (current.hiddenAgentIds.length === 0 ? current : { ...current, hiddenAgentIds: [] }));
  }, [apply]);

  const onNodeClick = useCallback((_event: unknown, node: GraphFlowNode) => {
    setPanelAgentId(node.type === "agent" ? node.id : null);
  }, []);
  const onPaneClick = useCallback(() => setPanelAgentId(null), []);

  const panelAgent = panelAgentId ? agentsById.get(panelAgentId) ?? null : null;

  return (
    <div
      className={cn("agent-graph relative h-full min-h-96 w-full overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring", className)}
      data-testid="agent-graph"
      role="application"
      aria-label="Agent graph. Use Tab to move between agents and the toolbar for layout tools."
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={AGENT_GRAPH_NODE_TYPES}
        colorMode={theme === "dark" ? "dark" : "light"}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={commitPositions}
        onSelectionDragStop={commitPositions}
        onMoveEnd={onMoveEnd}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesConnectable={false}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={0.05}
        maxZoom={2}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        onlyRenderVisibleElements
        elevateNodesOnSelect={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={SNAP_GRID[0]} size={1} />
        <MiniMap pannable zoomable ariaLabel="Agent graph minimap" />
        <Controls showInteractive={false} />
        <Panel position="top-left" className="flex max-w-full flex-col gap-2">
          <UiLayoutNotice
            blocked={document.blocked}
            error={document.loadError}
            subject="graph"
            onRetry={document.retryLoad}
            onOverwrite={document.allowOverwrite}
            saveError={document.saveError}
            onRetrySave={document.retrySave}
          />
          <AgentGraphToolbar
            direction={direction}
            keepManual={keepManual}
            hiddenCount={layout?.hiddenAgentIds.length ?? 0}
            saveState={document.blocked ? "idle" : document.saveState}
            onTidy={tidy}
            onDirectionChange={changeDirection}
            onKeepManualChange={setKeepManual}
            onShowHidden={showHidden}
          />
        </Panel>
        {panelAgent ? (
          <Panel position="top-right" className="max-h-full">
            <AgentGraphSidePanel
              agent={panelAgent}
              companyId={companyId}
              managerName={panelAgent.reportsTo ? agentsById.get(panelAgent.reportsTo)?.name ?? null : null}
              reportCount={reportCounts.get(panelAgent.id) ?? 0}
              onClose={() => setPanelAgentId(null)}
              onHide={() => hideAgent(panelAgent.id)}
            />
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}
