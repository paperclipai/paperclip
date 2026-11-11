import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./agent-graph.css";
import {
  AGENT_GRAPH_MAX_DRAFTS,
  AGENT_GRAPH_MAX_STICKIES,
  type Agent,
  type AgentGraphLayout,
  type AgentGraphSticky,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { UiLayoutNotice } from "@/components/UiLayoutNotice";
import { useTheme } from "@/context/ThemeContext";
import { useToastActions } from "@/context/ToastContext";
import { AgentGraphActionsContext, type AgentGraphActions } from "./AgentGraphActions";
import { HireDraftDialog, ReparentDialog, type PendingReparent } from "./AgentGraphDialogs";
import { AGENT_GRAPH_NODE_TYPES } from "./AgentGraphNodes";
import { AgentGraphSidePanel } from "./AgentGraphSidePanel";
import { AgentGraphToolbar } from "./AgentGraphToolbar";
import { layoutHierarchy, type LayoutDirection } from "./lib/auto-layout";
import {
  PASTE_OFFSET,
  buildClipboard,
  draftToHireRequest,
  resolveDraftManager,
  materializePaste,
  parseClipboard,
  serializeClipboard,
} from "./lib/clipboard";
import {
  DRAFT_NODE_PREFIX,
  HIERARCHY_EDGE_PREFIX,
  STICKY_NODE_PREFIX,
  commitNodePositions,
  syncEdges,
  syncNodes,
  type GraphFlowNode,
} from "./lib/graph-nodes";
import { REPARENT_REJECTION_MESSAGES, buildManagerIndex, checkReparent } from "./lib/hierarchy";
import { useAgentGraphDocument } from "./useAgentGraphDocument";

const SNAP_GRID: [number, number] = [16, 16];
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1.25 };
const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set();
const NO_NODES: GraphFlowNode[] = [];
const NO_EDGES: Edge[] = [];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function isAgentNodeId(id: string | null | undefined): id is string {
  return Boolean(id) && !id!.startsWith(STICKY_NODE_PREFIX) && !id!.startsWith(DRAFT_NODE_PREFIX);
}

function createLocalId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
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
  const queryClient = useQueryClient();
  const { theme } = useTheme();
  const { pushToast } = useToastActions();
  const flow = useReactFlow<GraphFlowNode, Edge>();
  const nodesInitialized = useNodesInitialized();
  const document = useAgentGraphDocument(companyId);
  const { layout, apply } = document;

  const [nodes, setNodes] = useState<GraphFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [keepManual, setKeepManual] = useState(true);
  const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
  const [pendingReparent, setPendingReparent] = useState<PendingReparent | null>(null);
  const [hireDraftId, setHireDraftId] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const clipboardRef = useRef<string | null>(null);
  const pasteCountRef = useRef(0);
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
  const reportingAgentsById = useMemo(() => {
    const index = new Map<string, Agent>();
    for (const agent of agents) if (agent.status !== "terminated") index.set(agent.id, agent);
    return index;
  }, [agents]);
  const managerIndex = useMemo(() => buildManagerIndex([...reportingAgentsById.values()]), [reportingAgentsById]);
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
  const agentsByIdRef = useRef(agentsById);
  agentsByIdRef.current = agentsById;
  const companyAgentIds = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const companyAgentIdsRef = useRef(companyAgentIds);
  companyAgentIdsRef.current = companyAgentIds;
  const managerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of agents) if (agent.status !== "terminated") names.set(agent.id, agent.name);
    return names;
  }, [agents]);
  const managerIds = useMemo(() => new Set(managerNames.keys()), [managerNames]);
  const managerIdsRef = useRef(managerIds);
  managerIdsRef.current = managerIds;

  useEffect(() => {
    if (!layout) {
      setNodes((current) => (current.length === 0 ? current : NO_NODES));
      setEdges((current) => (current.length === 0 ? current : NO_EDGES));
      return;
    }
    const input = { agents: graphAgents, layout, autoPositions, liveAgentIds, managerNames };
    setNodes((current) => syncNodes(current, input));
    setEdges((current) => syncEdges(current, input));
  }, [graphAgents, layout, autoPositions, liveAgentIds, managerNames]);

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

  const requestReparent = useCallback(
    (agentId: string, toId: string | null, origin: PendingReparent["origin"]) => {
      const check = checkReparent(managerIndex, agentId, toId);
      if (!check.ok) {
        if (origin !== "edit") document.settleReparentStep(origin, "invalid");
        pushToast({ tone: "warn", title: "Reporting line not changed", body: REPARENT_REJECTION_MESSAGES[check.reason] });
        return;
      }
      const agent = reportingAgentsById.get(agentId)!;
      setPendingReparent({
        agentId,
        agentName: agent.name,
        fromId: agent.reportsTo,
        fromName: agent.reportsTo ? reportingAgentsById.get(agent.reportsTo)?.name ?? null : null,
        toId,
        toName: toId ? reportingAgentsById.get(toId)?.name ?? null : null,
        origin,
      });
    },
    [managerIndex, reportingAgentsById, pushToast, document.settleReparentStep],
  );

  const reparentMutation = useMutation({
    mutationFn: (pending: PendingReparent) => agentsApi.update(pending.agentId, { reportsTo: pending.toId }, companyId),
    onSuccess: async (_agent, pending) => {
      if (pending.origin === "edit") document.recordReparent(pending.agentId, pending.fromId, pending.toId);
      else document.settleReparentStep(pending.origin, "applied");
      setPendingReparent(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) }),
      ]);
    },
  });

  const hireDraft = hireDraftId ? layout?.drafts.find((draft) => draft.id === hireDraftId) ?? null : null;
  const hireMutation = useMutation({
    mutationFn: (draftId: string) => {
      const draft = layout?.drafts.find((item) => item.id === draftId);
      if (!draft) throw new Error("This draft no longer exists.");
      return agentsApi.hire(companyId, draftToHireRequest(resolveDraftManager(draft, managerIdsRef.current)));
    },
    onSuccess: async (result, draftId) => {
      document.purgeDraft(draftId);
      setHireDraftId(null);
      pushToast({
        tone: "success",
        title: result.approval ? "Hire request sent for board approval" : "Agent hired",
        body: result.approval
          ? `${result.agent.name} stays pending until the board approves the hire.`
          : `${result.agent.name} was created. Review its configuration before it runs.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) }),
        queryClient.invalidateQueries({ queryKey: ["approvals", companyId] }),
      ]);
    },
  });

  const actions = useMemo<AgentGraphActions>(
    () => ({
      updateSticky: (id, patch) =>
        apply((current) => ({
          ...current,
          stickies: current.stickies.map((sticky) => (sticky.id === id ? { ...sticky, ...patch } : sticky)),
        })),
      editStickyText: (id, text) =>
        apply(
          (current) => ({
            ...current,
            stickies: current.stickies.map((sticky) => (sticky.id === id && sticky.text !== text ? { ...sticky, text } : sticky)),
          }),
          { group: `sticky-text:${id}` },
        ),
      finishStickyText: () => {
        document.closeGroup();
        document.flush();
      },
      requestHire: (draftId) => {
        hireMutation.reset();
        setHireDraftId(draftId);
      },
      removeDraft: (draftId) =>
        apply((current) => ({ ...current, drafts: current.drafts.filter((draft) => draft.id !== draftId) })),
    }),
    [apply, document.closeGroup, document.flush, hireMutation.reset],
  );

  const selectionClipboard = useCallback(() => {
    const selected = nodesRef.current.filter((node) => node.selected);
    const copiedAgents: Array<{ agent: Agent; position: { x: number; y: number } }> = [];
    const copiedStickies: AgentGraphSticky[] = [];
    for (const node of selected) {
      if (node.type === "agent") {
        const agent = agentsByIdRef.current.get(node.id);
        if (agent) copiedAgents.push({ agent, position: node.position });
      } else if (node.type === "sticky") {
        copiedStickies.push({ ...node.data.sticky, x: node.position.x, y: node.position.y });
      }
    }
    if (copiedAgents.length === 0 && copiedStickies.length === 0) return null;
    return serializeClipboard(buildClipboard({ agents: copiedAgents, stickies: copiedStickies }));
  }, []);

  const pasteText = useCallback(
    (text: string) => {
      const parsed = parseClipboard(text);
      if (!parsed.ok) {
        if (parsed.reason !== "not-graph-data") {
          pushToast({ tone: "warn", title: "Nothing pasted", body: "The clipboard does not hold valid agent graph data." });
        }
        return;
      }
      const current = layout;
      if (!current) return;
      pasteCountRef.current += 1;
      const offset = PASTE_OFFSET * pasteCountRef.current;
      const takenNames = new Set<string>();
      for (const agent of agentsByIdRef.current.values()) takenNames.add(agent.name.toLowerCase());
      for (const draft of current.drafts) takenNames.add(draft.name.toLowerCase());
      const pasted = materializePaste({
        clipboard: parsed.clipboard,
        offset: { x: offset, y: offset },
        createId: createLocalId,
        takenNames,
        knownAgentIds: companyAgentIdsRef.current,
        managerAgentIds: managerIdsRef.current,
        draftCapacity: AGENT_GRAPH_MAX_DRAFTS - current.drafts.length,
        stickyCapacity: AGENT_GRAPH_MAX_STICKIES - current.stickies.length,
      });
      if (pasted.drafts.length === 0 && pasted.stickies.length === 0) return;
      apply((value) => ({
        ...value,
        drafts: [...value.drafts, ...pasted.drafts],
        stickies: [...value.stickies, ...pasted.stickies],
      }));
      if (pasted.drafts.length > 0) {
        pushToast({
          tone: "info",
          title: `${pasted.drafts.length} hire draft${pasted.drafts.length === 1 ? "" : "s"} pasted`,
          body: "Drafts are not agents. Use Request hire on a draft to start the hiring flow.",
        });
      }
      if (pasted.clearedManagers > 0) {
        pushToast({
          tone: "warn",
          title: "Reporting line not copied",
          body: "The manager of a copied agent is terminated or is not in this organization. The draft has no manager.",
        });
      }
      if (pasted.droppedAgents > 0 || pasted.droppedStickies > 0) {
        pushToast({ tone: "warn", title: "Some items were not pasted", body: "This graph reached its limit of drafts or notes." });
      }
    },
    [layout, apply, pushToast],
  );

  const onCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      const text = selectionClipboard();
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      clipboardRef.current = text;
      pasteCountRef.current = 0;
    },
    [selectionClipboard],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      const text = event.clipboardData.getData("text/plain") || clipboardRef.current;
      if (!text) return;
      event.preventDefault();
      pasteText(text);
    },
    [pasteText],
  );

  const duplicateSelection = useCallback(() => {
    const text = selectionClipboard();
    if (!text) return;
    pasteCountRef.current = 0;
    pasteText(text);
  }, [selectionClipboard, pasteText]);

  const deleteSelection = useCallback(() => {
    const selected = nodesRef.current.filter((node) => node.selected);
    const stickyIds = new Set<string>();
    const draftIds = new Set<string>();
    let agentCount = 0;
    for (const node of selected) {
      if (node.type === "sticky") stickyIds.add(node.data.sticky.id);
      else if (node.type === "draft") draftIds.add(node.data.draft.id);
      else agentCount += 1;
    }
    if (stickyIds.size > 0 || draftIds.size > 0) {
      apply((current) => ({
        ...current,
        stickies: current.stickies.filter((sticky) => !stickyIds.has(sticky.id)),
        drafts: current.drafts.filter((draft) => !draftIds.has(draft.id)),
      }));
    }
    if (agentCount > 0) {
      pushToast({
        tone: "info",
        title: "Agents are not deleted from the graph",
        body: "Hide an agent from this view in its details panel, or open the agent to pause or terminate it.",
      });
      return;
    }
    if (stickyIds.size > 0 || draftIds.size > 0) return;
    const edge = edgesRef.current.find((item) => item.selected && item.id.startsWith(HIERARCHY_EDGE_PREFIX));
    if (edge && isAgentNodeId(edge.target)) requestReparent(edge.target, null, "edit");
  }, [apply, pushToast, requestReparent]);

  const runHistory = useCallback(
    (step: "undo" | "redo") => {
      const entry = step === "undo" ? document.undo() : document.redo();
      if (entry?.kind !== "reparent") return;
      requestReparent(entry.agentId, step === "undo" ? entry.before : entry.after, step);
    },
    [document.undo, document.redo, requestReparent],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "z") {
        event.preventDefault();
        runHistory(event.shiftKey ? "redo" : "undo");
      } else if (modifier && key === "y") {
        event.preventDefault();
        runHistory("redo");
      } else if (modifier && key === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if (modifier && key === "a") {
        event.preventDefault();
        setNodes((current) => current.map((node) => (node.selected ? node : { ...node, selected: true })));
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "Escape") {
        setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
        setPanelAgentId(null);
      }
    },
    [runHistory, duplicateSelection, deleteSelection],
  );

  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key.startsWith("Arrow") && !isEditableTarget(event.target)) commitPositions();
    },
    [commitPositions],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      isAgentNodeId(connection.source) && isAgentNodeId(connection.target) && connection.source !== connection.target,
    [],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (isAgentNodeId(connection.source) && isAgentNodeId(connection.target)) {
        requestReparent(connection.target, connection.source, "edit");
      }
    },
    [requestReparent],
  );
  const onReconnect = useCallback(
    (_edge: Edge, connection: Connection) => {
      if (isAgentNodeId(connection.source) && isAgentNodeId(connection.target)) {
        requestReparent(connection.target, connection.source, "edit");
      }
    },
    [requestReparent],
  );

  const addSticky = useCallback(() => {
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    apply((current) => {
      if (current.stickies.length >= AGENT_GRAPH_MAX_STICKIES) return current;
      const sticky: AgentGraphSticky = {
        id: createLocalId(),
        x: Math.round(center.x / SNAP_GRID[0]) * SNAP_GRID[0],
        y: Math.round(center.y / SNAP_GRID[1]) * SNAP_GRID[1],
        width: 208,
        height: 128,
        text: "",
        color: "yellow",
      };
      return { ...current, stickies: [...current.stickies, sticky] };
    });
  }, [apply, flow]);

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

  const duplicateAgent = useCallback(
    (agentId: string) => {
      const agent = agentsByIdRef.current.get(agentId);
      const node = nodesRef.current.find((item) => item.id === agentId);
      if (!agent || !node) return;
      pasteCountRef.current = 0;
      pasteText(serializeClipboard(buildClipboard({ agents: [{ agent, position: node.position }], stickies: [] })));
    },
    [pasteText],
  );

  const onNodeClick = useCallback((_event: unknown, node: GraphFlowNode) => {
    setPanelAgentId(node.type === "agent" ? node.id : null);
  }, []);
  const onPaneClick = useCallback(() => setPanelAgentId(null), []);

  const panelAgent = panelAgentId ? agentsById.get(panelAgentId) ?? null : null;
  const hireManagerName = hireDraft?.reportsTo ? managerNames.get(hireDraft.reportsTo) ?? null : null;

  return (
    <AgentGraphActionsContext.Provider value={actions}>
      <div
        className={cn("agent-graph relative h-full min-h-96 w-full overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring", className)}
        data-testid="agent-graph"
        role="application"
        aria-label="Agent graph. Use Tab to move between agents and the toolbar for layout tools."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCopy={onCopy}
        onPaste={onPaste}
      >
        <ReactFlow
          nodes={layout ? nodes : NO_NODES}
          edges={layout ? edges : NO_EDGES}
          nodeTypes={AGENT_GRAPH_NODE_TYPES}
          colorMode={theme === "dark" ? "dark" : "light"}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={commitPositions}
          onSelectionDragStop={commitPositions}
          onMoveEnd={onMoveEnd}
          onConnect={onConnect}
          onReconnect={onReconnect}
          isValidConnection={isValidConnection}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
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
              canUndo={document.canUndo}
              canRedo={document.canRedo}
              saveState={document.blocked ? "idle" : document.saveState}
              onAddSticky={addSticky}
              onTidy={tidy}
              onDirectionChange={changeDirection}
              onKeepManualChange={setKeepManual}
              onShowHidden={showHidden}
              onUndo={() => runHistory("undo")}
              onRedo={() => runHistory("redo")}
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
                onDuplicate={() => duplicateAgent(panelAgent.id)}
              />
            </Panel>
          ) : null}
        </ReactFlow>
        <ReparentDialog
          pending={pendingReparent}
          busy={reparentMutation.isPending}
          error={reparentMutation.error ? describeError(reparentMutation.error, { action: "change the reporting line" }).body : null}
          onConfirm={() => pendingReparent && reparentMutation.mutate(pendingReparent)}
          onCancel={() => {
            reparentMutation.reset();
            setPendingReparent(null);
          }}
        />
        <HireDraftDialog
          draft={hireDraft}
          managerName={hireManagerName}
          busy={hireMutation.isPending}
          error={hireMutation.error ? describeError(hireMutation.error, { action: "send the hire request" }).body : null}
          onConfirm={() => hireDraftId && hireMutation.mutate(hireDraftId)}
          onCancel={() => {
            hireMutation.reset();
            setHireDraftId(null);
          }}
        />
      </div>
    </AgentGraphActionsContext.Provider>
  );
}
