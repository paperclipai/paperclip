import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  GitBranch,
  LoaderCircle,
  Play,
  Repeat,
  Save,
  ScrollText,
  ShieldCheck,
  PersonStanding,
  TerminalSquare,
  UserRound,
  Workflow as WorkflowIcon,
  Wrench,
  X,
} from "lucide-react";
import type {
  ActivityEvent,
  WorkflowDetail as WorkflowDetailType,
  WorkflowHandoff,
  WorkflowPhase,
  WorkflowRunConsoleChunk,
  WorkflowRunDetail,
  Resource,
  ResourceAttachmentMode,
  ResourceOutputAction,
  ResourceOutputResult,
  WorkflowResourceManifest,
  ResourceVersionReference,
} from "@paperclipai/shared";
import { workflowsApi } from "../api/workflows";
import { resourcesApi } from "../api/resources";
import { buildTranscript, getUIAdapter } from "../adapters";
import {
  RunTranscriptView,
  type TranscriptMode,
} from "../components/transcript/RunTranscriptView";
import {
  WorkflowPromptTemplatesEditor,
  type WorkflowPromptTemplateDraft,
  createWorkflowPromptTemplateDraft,
} from "../components/WorkflowPromptTemplatesEditor";
import { WorkflowSchedulesEditor } from "../components/WorkflowSchedulesEditor";
import { WorkflowRunPromptSuggestions } from "../components/WorkflowRunPromptSuggestions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, formatFileSize, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildWorkflowRunnerConfig,
  hasIncompleteWorkflowPromptTemplates,
  readWorkflowPromptTemplates,
} from "../config/workflow-run-prompts";
import type { WorkflowScheduleMutationInput } from "../api/workflows";
import {
  buildWorkflowBehaviorAgents,
  buildWorkflowTelemetryPhases,
  type WorkflowBehaviorAgent,
} from "../lib/workflow-behavior";

type WorkflowEditDraft = {
  title: string;
  description: string;
  status: string;
  agentPath: string;
  cwd: string;
  command: string;
  model: string;
  promptTemplates: WorkflowPromptTemplateDraft[];
};

const workflowPanelClassName =
  "overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-sm gap-4 py-5";
const workflowPillClassName =
  "rounded-full border border-border/60 bg-background/40 px-3 py-1 text-xs text-muted-foreground";

function toDraft(detail: WorkflowDetailType): WorkflowEditDraft {
  return {
    title: detail.title,
    description: detail.description ?? "",
    status: detail.status,
    agentPath:
      typeof detail.runnerConfig.agentPath === "string"
        ? detail.runnerConfig.agentPath
        : "",
    cwd:
      typeof detail.runnerConfig.cwd === "string"
        ? detail.runnerConfig.cwd
        : "",
    command:
      typeof detail.runnerConfig.command === "string"
        ? detail.runnerConfig.command
        : "",
    model:
      typeof detail.runnerConfig.model === "string"
        ? detail.runnerConfig.model
        : "",
    promptTemplates: readWorkflowPromptTemplates(detail.runnerConfig).map(
      (template) => createWorkflowPromptTemplateDraft(template),
    ),
  };
}

function readPhaseMetaString(phase: WorkflowPhase, key: string) {
  const value = phase.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPhaseMetaNumber(phase: WorkflowPhase, key: string) {
  const value = phase.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type GraphNodeKind = "start" | "phase" | "human" | "terminal" | "deliverable";

type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  level: number;
  phase?: WorkflowPhase;
  handoff?: WorkflowHandoff;
  deliverable?: WorkflowRunDetail["deliverables"][number];
  status?: string;
  width: number;
  height: number;
  x: number;
  y: number;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
};

type WorkflowGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  isRunLive: boolean;
};

export function shouldAnimatePipelineNode(
  kind: GraphNodeKind,
  status: string | null | undefined,
  isRunLive: boolean,
) {
  if (!isRunLive) return false;
  if (kind === "deliverable") return true;
  if (kind === "human") return status === "waiting_for_human";
  return (kind === "start" || kind === "phase") && status === "running";
}

const GRAPH_NODE_WIDTH = 260;
const GRAPH_TOOL_WIDTH = 220;
const GRAPH_HUMAN_WIDTH = 320;
const GRAPH_DELIVERABLE_WIDTH = 220;
const GRAPH_ROW_GAP = 72;
const GRAPH_BRANCH_GAP = 44;
const GRAPH_PADDING_X = 28;
const GRAPH_PADDING_Y = 24;

function estimateGraphNodeHeight(
  kind: GraphNodeKind,
  handoff?: WorkflowHandoff | undefined,
  phaseKind?: WorkflowPhase["kind"],
) {
  if (kind === "start") return 76;
  if (kind === "terminal") return 92;
  if (kind === "deliverable") return 92;
  if (kind === "human") {
    const promptLength = handoff?.promptMarkdown.length ?? 0;
    const settledLength = handoff?.responseMarkdown?.length ?? 0;
    return Math.min(
      320,
      180 +
        Math.ceil(promptLength / 80) * 18 +
        Math.ceil(settledLength / 120) * 14,
    );
  }
  if (phaseKind === "tool") return 116;
  if (phaseKind === "validator") return 128;
  if (phaseKind === "loop") return 136;
  const descriptionLength = handoff ? 0 : 0;
  return 132 + descriptionLength;
}

function getGraphNodeWidth(
  kind: GraphNodeKind,
  phaseKind?: WorkflowPhase["kind"],
) {
  if (kind === "start") return 160;
  if (kind === "terminal") return 180;
  if (kind === "deliverable") return GRAPH_DELIVERABLE_WIDTH;
  if (kind === "human") return GRAPH_HUMAN_WIDTH;
  if (phaseKind === "tool") return GRAPH_TOOL_WIDTH;
  return GRAPH_NODE_WIDTH;
}

type PhaseLayout = {
  handoffs: WorkflowHandoff[];
  children: WorkflowPhase[];
  chainWidth: number;
  subtreeWidth: number;
};

const PIPELINE_AGENT_KINDS = new Set<WorkflowPhase["kind"]>([
  "agent",
  "loop",
  "validator",
]);

export function workflowPipelineAgentPhases(
  phases: WorkflowPhase[],
): WorkflowPhase[] {
  const phasesByKey = new Map(phases.map((phase) => [phase.phaseKey, phase]));
  const visibleKeys = new Set(
    phases
      .filter((phase) => PIPELINE_AGENT_KINDS.has(phase.kind))
      .map((phase) => phase.phaseKey),
  );

  const visibleParent = (phase: WorkflowPhase): string | null => {
    let parentKey = readPhaseMetaString(phase, "parentKey");
    const visited = new Set<string>();
    while (parentKey && !visibleKeys.has(parentKey)) {
      if (visited.has(parentKey)) return null;
      visited.add(parentKey);
      const parent = phasesByKey.get(parentKey);
      parentKey = parent ? readPhaseMetaString(parent, "parentKey") : null;
    }
    return parentKey;
  };

  return phases
    .filter((phase) => visibleKeys.has(phase.phaseKey))
    .map((phase) => {
      const parentKey = visibleParent(phase);
      return {
        ...phase,
        metadata: {
          ...phase.metadata,
          parentKey,
        },
      };
    });
}

export function buildWorkflowGraph(
  phases: WorkflowPhase[],
  handoffsByPhase: Map<string, WorkflowHandoff[]>,
  runDetail: WorkflowRunDetail | null,
): WorkflowGraph {
  const isRunLive = Boolean(
    runDetail && ["queued", "running", "awaiting_human"].includes(runDetail.status),
  );
  const pipelinePhases = workflowPipelineAgentPhases(phases);
  const phaseKeys = new Set(pipelinePhases.map((phase) => phase.phaseKey));
  const childrenByParent = new Map<string | null, WorkflowPhase[]>();
  for (const phase of pipelinePhases) {
    const parentKey = readPhaseMetaString(phase, "parentKey");
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(phase);
    childrenByParent.set(parentKey, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => {
      const depthA = readPhaseMetaNumber(a, "depth") ?? a.ordinal;
      const depthB = readPhaseMetaNumber(b, "depth") ?? b.ordinal;
      return depthA - depthB || a.ordinal - b.ordinal || a.id.localeCompare(b.id);
    });
  }

  const roots = childrenByParent.get(null) ?? [];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addNode = (node: Omit<GraphNode, "x" | "y">) => {
    nodes.set(node.id, { ...node, x: 0, y: 0 });
  };
  const addEdge = (from: string, to: string) => {
    edges.push({ id: `${from}->${to}`, from, to });
  };

  addNode({
    id: "graph:start",
    kind: "start",
    label: "Start",
    level: 0,
    width: getGraphNodeWidth("start"),
    height: estimateGraphNodeHeight("start"),
    status: runDetail?.status === "running" ? "running" : "idle",
  });

  const appendPhase = (
    phase: WorkflowPhase,
    incomingIds: string[],
  ): string[] => {
    const phaseId = `phase:${phase.phaseKey}`;
    addNode({
      id: phaseId,
      kind: "phase",
      label: phase.label,
      level: 1,
      phase,
      width: getGraphNodeWidth("phase", phase.kind),
      height: estimateGraphNodeHeight("phase", undefined, phase.kind),
      status: phase.status,
    });
    for (const incomingId of incomingIds) addEdge(incomingId, phaseId);

    let outputs = [phaseId];
    const handoffs = [...(handoffsByPhase.get(phase.phaseKey) ?? [])].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    if (handoffs.length > 0) {
      let previousId = phaseId;
      for (const handoff of handoffs) {
        const handoffId = `handoff:${handoff.id}`;
        addNode({
          id: handoffId,
          kind: "human",
          label:
            handoff.kind === "approval" ? "Human approval" : "Human response",
          level: 1,
          handoff,
          width: getGraphNodeWidth("human"),
          height: estimateGraphNodeHeight("human", handoff),
          status: handoff.status,
        });
        addEdge(previousId, handoffId);
        previousId = handoffId;
      }
      outputs = [previousId];
    }

    const children = childrenByParent.get(phase.phaseKey) ?? [];
    if (children.length === 0) return outputs;

    const childOutputs: string[] = [];
    for (const child of children) {
      childOutputs.push(...appendPhase(child, outputs));
    }
    return childOutputs;
  };

  if (roots.length > 0) {
    for (const phase of roots) {
      appendPhase(phase, ["graph:start"]);
    }
  }

  const phaseLayoutCache = new Map<string, PhaseLayout>();
  const measurePhase = (phase: WorkflowPhase): PhaseLayout => {
    const cached = phaseLayoutCache.get(phase.phaseKey);
    if (cached) return cached;

    const handoffs = [...(handoffsByPhase.get(phase.phaseKey) ?? [])].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const children = childrenByParent.get(phase.phaseKey) ?? [];
    const chainWidth = Math.max(
      getGraphNodeWidth("phase", phase.kind),
      ...handoffs.map(() => getGraphNodeWidth("human")),
    );

    const childLayouts = children.map((child) => measurePhase(child));
    const childrenWidth =
      childLayouts.length > 0
        ? childLayouts.reduce((sum, child) => sum + child.subtreeWidth, 0) +
          Math.max(0, childLayouts.length - 1) * GRAPH_BRANCH_GAP
        : 0;
    const subtreeWidth = Math.max(chainWidth, childrenWidth);

    const layout = {
      handoffs,
      children,
      chainWidth,
      subtreeWidth,
    };
    phaseLayoutCache.set(phase.phaseKey, layout);
    return layout;
  };

  const positionPhase = (
    phase: WorkflowPhase,
    level: number,
    startX: number,
  ): { leafIds: string[]; maxLevel: number } => {
    const layout = measurePhase(phase);
    const phaseId = `phase:${phase.phaseKey}`;
    const phaseNode = nodes.get(phaseId);
    if (!phaseNode) {
      throw new Error(`Missing graph node for phase ${phase.phaseKey}`);
    }

    const chainLeft = startX + Math.max(0, (layout.subtreeWidth - layout.chainWidth) / 2);
    const chainCenter = chainLeft + layout.chainWidth / 2;
    phaseNode.level = level;
    phaseNode.x = chainCenter - phaseNode.width / 2;

    let currentLevel = level;
    let lastId = phaseId;
    for (const handoff of layout.handoffs) {
      const handoffId = `handoff:${handoff.id}`;
      const handoffNode = nodes.get(handoffId);
      if (!handoffNode) {
        throw new Error(`Missing graph node for handoff ${handoff.id}`);
      }
      currentLevel += 1;
      handoffNode.level = currentLevel;
      handoffNode.x = chainCenter - handoffNode.width / 2;
      lastId = handoffId;
    }

    const childLayoutWidth = layout.children.reduce(
      (sum, child) => sum + measurePhase(child).subtreeWidth,
      0,
    );
    const childGapWidth =
      Math.max(0, layout.children.length - 1) * GRAPH_BRANCH_GAP;
    const childBlockWidth = childLayoutWidth + childGapWidth;
    let childCursorX =
      startX + Math.max(0, (layout.subtreeWidth - childBlockWidth) / 2);
    const childLevel = level + layout.handoffs.length + 1;
    const leafIdsFromChildren: string[] = [];
    let maxLevel = currentLevel;

    for (const child of layout.children) {
      const childResult = positionPhase(child, childLevel, childCursorX);
      leafIdsFromChildren.push(...childResult.leafIds);
      maxLevel = Math.max(maxLevel, childResult.maxLevel);
      childCursorX += measurePhase(child).subtreeWidth + GRAPH_BRANCH_GAP;
    }

    if (layout.children.length === 0) {
      return { leafIds: [lastId], maxLevel: currentLevel };
    }

    return { leafIds: leafIdsFromChildren, maxLevel };
  };

  const rootLayouts = roots.map((phase) => measurePhase(phase));
  const rootBlockWidth =
    rootLayouts.reduce((sum, layout) => sum + layout.subtreeWidth, 0) +
    Math.max(0, rootLayouts.length - 1) * GRAPH_BRANCH_GAP;
  const startWidth = nodes.get("graph:start")?.width ?? 0;
  const graphBlockWidth = Math.max(startWidth, rootBlockWidth);
  const startNode = nodes.get("graph:start");
  if (!startNode) {
    throw new Error("Missing start graph node");
  }
  startNode.x = GRAPH_PADDING_X + Math.max(0, (graphBlockWidth - startWidth) / 2);

  let rootCursorX =
    GRAPH_PADDING_X + Math.max(0, (graphBlockWidth - rootBlockWidth) / 2);
  let maxLevel = 0;
  const allLeafIds: string[] = roots.length > 0 ? [] : ["graph:start"];
  for (const root of roots) {
    const result = positionPhase(root, 1, rootCursorX);
    allLeafIds.push(...result.leafIds);
    maxLevel = Math.max(maxLevel, result.maxLevel);
    rootCursorX += measurePhase(root).subtreeWidth + GRAPH_BRANCH_GAP;
  }

  const terminalLevel = maxLevel + 1;
  addNode({
    id: "graph:terminal",
    kind: "terminal",
    label: runDetail ? "Terminal" : "Awaiting run",
    level: terminalLevel,
    width: getGraphNodeWidth("terminal"),
    height: estimateGraphNodeHeight("terminal"),
    status: runDetail?.status ?? "idle",
  });
  const terminalNode = nodes.get("graph:terminal");
  if (!terminalNode) {
    throw new Error("Missing terminal graph node");
  }
  const leafCenters = allLeafIds
    .map((nodeId) => nodes.get(nodeId))
    .filter((node): node is GraphNode => Boolean(node))
    .map((node) => node.x + node.width / 2);
  const terminalCenterX =
    leafCenters.length > 0
      ? leafCenters.reduce((sum, value) => sum + value, 0) / leafCenters.length
      : GRAPH_PADDING_X + graphBlockWidth / 2;
  terminalNode.x = Math.max(
    GRAPH_PADDING_X,
    terminalCenterX - terminalNode.width / 2,
  );
  for (const leafId of allLeafIds) addEdge(leafId, "graph:terminal");

  const orphanHandoffs = [...handoffsByPhase.entries()]
    .filter(([phaseKey]) => !phaseKeys.has(phaseKey))
    .flatMap(([, handoffs]) =>
      [...handoffs].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    );
  let handoffTailLevel = terminalLevel;
  const handoffTailCenterX = terminalNode.x + terminalNode.width / 2;
  if (orphanHandoffs.length > 0) {
    let previousId = "graph:terminal";
    for (const handoff of orphanHandoffs) {
      const handoffId = `handoff:${handoff.id}`;
      addNode({
        id: handoffId,
        kind: "human",
        label:
          handoff.kind === "approval" ? "Human approval" : "Human response",
        level: ++handoffTailLevel,
        handoff,
        width: getGraphNodeWidth("human"),
        height: estimateGraphNodeHeight("human", handoff),
        status: handoff.status,
      });
      addEdge(previousId, handoffId);
      const handoffNode = nodes.get(handoffId);
      if (!handoffNode) {
        throw new Error(`Missing graph node for orphan handoff ${handoff.id}`);
      }
      handoffNode.x = Math.max(
        GRAPH_PADDING_X,
        handoffTailCenterX - handoffNode.width / 2,
      );
      previousId = handoffId;
    }
  }

  const deliverables = runDetail?.deliverables ?? [];
  const deliverableLevel = handoffTailLevel + 1;
  const deliverableGroupWidth =
    deliverables.length > 0
      ? deliverables.length * getGraphNodeWidth("deliverable") +
        Math.max(0, deliverables.length - 1) * GRAPH_BRANCH_GAP
      : 0;
  let deliverableCursorX =
    Math.max(
      GRAPH_PADDING_X,
      terminalNode.x + terminalNode.width / 2 - deliverableGroupWidth / 2,
    );
  const deliverableGap = GRAPH_BRANCH_GAP;
  for (const deliverable of deliverables) {
    const deliverableId = `deliverable:${deliverable.id}`;
    addNode({
      id: deliverableId,
      kind: "deliverable",
      label: deliverable.title,
      level: deliverableLevel,
      deliverable,
      width: getGraphNodeWidth("deliverable"),
      height: estimateGraphNodeHeight("deliverable"),
      status: "ready",
    });
    addEdge("graph:terminal", deliverableId);
    const deliverableNode = nodes.get(deliverableId);
    if (!deliverableNode) {
      throw new Error(`Missing deliverable graph node for ${deliverable.id}`);
    }
    deliverableNode.x = deliverableCursorX;
    deliverableCursorX += deliverableNode.width + deliverableGap;
  }

  const nodesByLevel = new Map<number, GraphNode[]>();
  for (const node of nodes.values()) {
    const levelNodes = nodesByLevel.get(node.level) ?? [];
    levelNodes.push(node);
    nodesByLevel.set(node.level, levelNodes);
  }
  let levelTop = GRAPH_PADDING_Y;
  const lastLevel = Math.max(...nodesByLevel.keys());
  for (let level = 0; level <= lastLevel; level += 1) {
    const levelNodes = nodesByLevel.get(level) ?? [];
    const levelHeight = Math.max(0, ...levelNodes.map((node) => node.height));
    for (const node of levelNodes) node.y = levelTop;
    levelTop += levelHeight + GRAPH_ROW_GAP;
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    return a.id.localeCompare(b.id);
  });

  const graphWidth = Math.max(
    420,
    ...orderedNodes.map((node) => node.x + node.width + GRAPH_PADDING_X),
  );
  const graphHeight = Math.max(
    420,
    ...orderedNodes.map((node) => node.y + node.height + GRAPH_PADDING_Y),
  );

  return {
    nodes: orderedNodes,
    edges,
    width: graphWidth,
    height: graphHeight,
    isRunLive,
  };
}

function nodeCenterBottom(node: GraphNode) {
  return { x: node.x + node.width / 2, y: node.y + node.height };
}

function nodeCenterTop(node: GraphNode) {
  return { x: node.x + node.width / 2, y: node.y };
}

function buildEdgePath(from: GraphNode, to: GraphNode) {
  const start = nodeCenterBottom(from);
  const end = nodeCenterTop(to);
  const curve = Math.max(28, Math.abs(end.y - start.y) * 0.42);
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + curve}, ${end.x} ${end.y - curve}, ${end.x} ${end.y}`;
}

function WorkflowTopologyGraph({
  graph,
  handoffResponses,
  setHandoffResponses,
  onApprove,
  onReject,
  onRespond,
  pendingHandoffId,
}: {
  graph: WorkflowGraph;
  handoffResponses: Record<string, string>;
  setHandoffResponses: Dispatch<SetStateAction<Record<string, string>>>;
  onApprove: (handoffId: string) => void;
  onReject: (handoffId: string) => void;
  onRespond: (handoffId: string) => void;
  pendingHandoffId: string | null;
}) {
  const nodeMap = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  return (
    <div className="overflow-auto rounded-3xl border border-border/70 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent)] p-3">
      <div
        className="relative mx-auto"
        style={{
          width: `${graph.width}px`,
          height: `${graph.height}px`,
        }}
      >
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {graph.edges.map((edge) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={edge.id}
                d={buildEdgePath(from, to)}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                className="text-border/90"
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className="absolute"
            style={{
              left: `${node.x}px`,
              top: `${node.y}px`,
              width: `${node.width}px`,
            }}
          >
            <GraphNodeCard
              node={node}
              isRunLive={graph.isRunLive}
              response={
                node.handoff ? (handoffResponses[node.handoff.id] ?? "") : ""
              }
              onChangeResponse={(value) => {
                if (!node.handoff) return;
                setHandoffResponses((current) => ({
                  ...current,
                  [node.handoff!.id]: value,
                }));
              }}
              onApprove={() => node.handoff && onApprove(node.handoff.id)}
              onReject={() => node.handoff && onReject(node.handoff.id)}
              onRespond={() => node.handoff && onRespond(node.handoff.id)}
              pending={
                node.handoff ? pendingHandoffId === node.handoff.id : false
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphNodeCard({
  node,
  isRunLive,
  response,
  onChangeResponse,
  onApprove,
  onReject,
  onRespond,
  pending,
}: {
  node: GraphNode;
  isRunLive: boolean;
  response: string;
  onChangeResponse: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRespond: () => void;
  pending: boolean;
}) {
  const animationStatus = node.kind === "human"
    ? node.handoff?.bridgeStatus
    : node.kind === "phase"
      ? node.phase?.status
      : node.status;
  const animate = shouldAnimatePipelineNode(node.kind, animationStatus, isRunLive);
  if (node.kind === "human" && node.handoff) {
    return (
      <GraphHumanNode
        handoff={node.handoff}
        animate={animate}
        response={response}
        onChange={onChangeResponse}
        onApprove={onApprove}
        onReject={onReject}
        onRespond={onRespond}
        pending={pending}
      />
    );
  }
  if (node.kind === "start")
    return <GraphStartNode status={node.status ?? "idle"} animate={animate} />;
  if (node.kind === "terminal")
    return <GraphTerminalNode status={node.status ?? "idle"} />;
  if (node.kind === "deliverable" && node.deliverable)
    return <GraphDeliverableNode node={node} animate={animate} />;
  return <GraphPhaseNode node={node} animate={animate} />;
}

function GraphStartNode({ status, animate }: { status: string; animate: boolean }) {
  return (
    <div
      className={cn(
        "rounded-full border px-5 py-4 shadow-sm",
        animate
          ? "border-amber-500/60 bg-amber-500/10 animate-pulse"
          : "border-border bg-background/90",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="rounded-full border border-border/70 bg-background/80 p-2">
          <Play className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Start</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {status.replaceAll("_", " ")}
          </div>
        </div>
      </div>
    </div>
  );
}

function GraphTerminalNode({ status }: { status: string }) {
  const settled = status === "succeeded";
  const failed = status === "failed";
  return (
    <div
      className={cn(
        "rounded-3xl border p-4 shadow-sm",
        settled
          ? "border-emerald-500/45 bg-emerald-500/10"
          : failed
            ? "border-red-500/45 bg-red-500/10"
            : "border-border bg-background/90",
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "rounded-2xl border p-2",
            settled
              ? "border-emerald-500/50 bg-emerald-500/10"
              : failed
                ? "border-red-500/50 bg-red-500/10"
                : "border-border/70 bg-background/80",
          )}
        >
          <Check className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Terminal</div>
          <div className="text-xs text-muted-foreground">
            Run outcome and downstream artifacts
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {status.replaceAll("_", " ")}
      </div>
    </div>
  );
}

function GraphDeliverableNode({ node, animate }: { node: GraphNode; animate: boolean }) {
  return (
    <div className={cn(
      "rounded-3xl border border-emerald-500/55 bg-emerald-500/[0.08] p-4 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_0_28px_rgba(16,185,129,0.18)]",
      animate && "animate-pulse",
    )}>
      <div className="flex items-start gap-3">
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-2 text-emerald-500">
          <Download className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            Deliverable
          </div>
          <div className="mt-1 truncate text-sm text-foreground/90">
            {node.deliverable?.title}
          </div>
          <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-300">
            Artifact ready
          </div>
        </div>
      </div>
    </div>
  );
}

function GraphPhaseNode({ node, animate }: { node: GraphNode; animate: boolean }) {
  const phase = node.phase;
  if (!phase) return null;
  const description = readPhaseMetaString(phase, "description");
  const filePath = readPhaseMetaString(phase, "filePath");
  const functionName = readPhaseMetaString(phase, "functionName");
  const kindLabel =
    phase.kind === "loop"
      ? "Loop agent"
      : phase.kind === "validator"
        ? "Validator"
        : phase.kind === "tool"
          ? "Tool"
          : phase.kind === "agent"
            ? "Agent"
            : "Phase";
  const tone =
    phase.status === "running"
      ? cn(
          "border-amber-500/60 bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.2)]",
          animate && "animate-pulse",
        )
      : phase.status === "succeeded"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : phase.status === "failed"
          ? "border-red-500/40 bg-red-500/10"
          : phase.status === "awaiting_human"
            ? "border-sky-500/40 bg-sky-500/10"
            : "border-border bg-background/90";
  const Icon =
    phase.kind === "loop"
      ? Repeat
      : phase.kind === "tool"
        ? Wrench
        : phase.kind === "validator"
          ? ShieldCheck
          : Bot;
  const compact = phase.kind === "tool";

  return (
    <div
      className={cn(
        "rounded-3xl border shadow-sm",
        compact ? "p-3 opacity-90" : "p-4",
        tone,
      )}
    >
      <div className={cn("flex items-start justify-between gap-3", compact && "gap-2")}>
        <div className={cn("flex items-start gap-3", compact && "gap-2")}>
          <div
            className={cn(
              "rounded-2xl border border-border/70 bg-background/80 text-muted-foreground",
              compact ? "p-1.5" : "p-2",
            )}
          >
            <Icon className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          </div>
          <div className={cn("space-y-1", compact && "space-y-0.5")}>
            <div className={cn("font-semibold", compact ? "text-xs" : "text-sm")}>
              {phase.label}
            </div>
            <div className="inline-flex rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {kindLabel}
            </div>
            {description ? (
              <p className={cn("pt-1 text-xs text-muted-foreground", compact && "max-w-[170px]")}>
                {description}
              </p>
            ) : null}
          </div>
        </div>
        <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {phase.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className={cn("mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground", compact && "mt-2")}>
        <span>Step {phase.ordinal + 1}</span>
        {filePath ? <span>{filePath}</span> : null}
        {functionName ? <span>{functionName}</span> : null}
      </div>
    </div>
  );
}

function GraphHumanNode({
  handoff,
  animate,
  response,
  onChange,
  onApprove,
  onReject,
  onRespond,
  pending,
}: {
  handoff: WorkflowHandoff;
  animate: boolean;
  response: string;
  onChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRespond: () => void;
  pending: boolean;
}) {
  const isPending = handoff.status === "pending";

  return (
    <div
      className={cn(
        "rounded-3xl border p-4 shadow-sm",
        isPending
          ? "border-sky-500/55 bg-sky-500/10"
          : "border-border bg-background/90",
      )}
    >
      <div className="mb-3 flex items-center gap-3">
        <PersonStanding className="h-10 w-10 text-foreground" aria-hidden />
        <div>
          <div className="text-sm font-semibold text-foreground">
            {handoff.kind === "approval" ? "Human approval" : "Human response"}
          </div>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground">
              {handoff.status.replaceAll("_", " ")}
            </div>
            {handoff.bridgeStatus === "waiting_for_human" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-400">
                <span className={cn("h-1.5 w-1.5 rounded-full bg-sky-500", animate && "animate-pulse")} />
                Waiting on ClickUp reply
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-background/70 p-3 text-sm">
        <MarkdownBody className="prose prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {handoff.promptMarkdown}
        </MarkdownBody>
      </div>

      {isPending ? (
        <div className="mt-3 space-y-3">
          <Textarea
            value={response}
            onChange={(event) => onChange(event.target.value)}
            placeholder={
              handoff.kind === "approval"
                ? "Optional decision note"
                : "Write the human response"
            }
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            {handoff.kind === "approval" ? (
              <>
                <Button size="sm" onClick={onApprove} disabled={pending}>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onReject}
                  disabled={pending}
                >
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Reject
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={onRespond}
                disabled={pending || response.trim().length === 0}
              >
                <UserRound className="mr-1.5 h-3.5 w-3.5" />
                Respond
              </Button>
            )}
          </div>
        </div>
      ) : handoff.responseMarkdown ? (
        <div className="mt-3 rounded-2xl border border-border/70 bg-background/80 p-3 text-sm text-muted-foreground">
          {handoff.responseMarkdown}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowResourceManifestEditor({
  manifest,
  resources,
  onChange,
}: {
  manifest: WorkflowResourceManifest;
  resources: Resource[];
  onChange: (manifest: WorkflowResourceManifest) => void;
}) {
  const selectedIds = new Set(manifest.resources.map((attachment) => attachment.resourceId));
  const availableResources = resources.filter((resource) => resource.status === "active");
  const addResource = () => {
    const next = availableResources.find((resource) => !selectedIds.has(resource.id));
    if (!next) return;
    onChange({
      ...manifest,
      resources: [
        ...manifest.resources,
        { resourceId: next.id, mode: "input" },
      ],
    });
  };

  const updateResource = (resourceId: string, patch: Partial<WorkflowResourceManifest["resources"][number]>) => {
    onChange({
      ...manifest,
      resources: manifest.resources.map((attachment) =>
        attachment.resourceId === resourceId ? { ...attachment, ...patch } : attachment,
      ),
    });
  };

  const removeResource = (resourceId: string) => {
    onChange({
      ...manifest,
      resources: manifest.resources.filter((attachment) => attachment.resourceId !== resourceId),
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-background/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-sm font-semibold">Resources</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose the Resources to materialize for this run.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addResource}
          disabled={availableResources.length === selectedIds.size}
        >
          Add Resource
        </Button>
      </div>

      {manifest.resources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            No Resources selected. This run will start without Resource workspace preparation.
        </div>
      ) : (
        <div className="space-y-3">
          {manifest.resources.map((attachment) => {
            const resource = resources.find((candidate) => candidate.id === attachment.resourceId);
            return (
              <div key={attachment.resourceId} className="space-y-3 rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Workflow Resource"
                    value={attachment.resourceId}
                    onChange={(event) => updateResource(attachment.resourceId, { resourceId: event.target.value, version: undefined, output: undefined })}
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {availableResources
                      .filter((candidate) => candidate.id === attachment.resourceId || !selectedIds.has(candidate.id))
                      .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.key} · {candidate.type}</option>)}
                  </select>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${resource?.key ?? "Resource"}`} onClick={() => removeResource(attachment.resourceId)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Mode</Label>
                    <select
                      aria-label="Resource mode"
                      value={attachment.mode}
                      onChange={(event) => updateResource(attachment.resourceId, { mode: event.target.value as ResourceAttachmentMode })}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="input">Input only</option>
                      <option value="output">Output only</option>
                      <option value="input_output">Input + output</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Input ref</Label>
                    <Input
                      value={attachment.version ?? ""}
                      onChange={(event) => updateResource(attachment.resourceId, { version: event.target.value.trim() || undefined })}
                      placeholder={resource?.defaultRef ?? "latest"}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Output action</Label>
                    <select
                      aria-label="Resource output action"
                      value={attachment.output?.action ?? "none"}
                      onChange={(event) => updateResource(attachment.resourceId, { output: { ...attachment.output, action: event.target.value as ResourceOutputAction } })}
                      disabled={attachment.mode === "input"}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="none">Discard changes</option>
                      <option value="push">Commit + push</option>
                      <option value="pull_request">Create pull request</option>
                    </select>
                  </div>
                </div>
                {attachment.output?.action === "push" || attachment.output?.action === "pull_request" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Target ref</Label>
                    <Input
                      value={attachment.output.targetRef ?? ""}
                      onChange={(event) => updateResource(attachment.resourceId, { output: { ...attachment.output, action: attachment.output?.action ?? "none", targetRef: event.target.value.trim() || undefined } })}
                      placeholder={resource?.defaultRef ?? "main"}
                    />
                  </div>
                ) : null}
                {attachment.output?.action === "pull_request" ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Branch (optional)</Label>
                      <Input value={attachment.output.branch ?? ""} onChange={(event) => updateResource(attachment.resourceId, { output: { ...attachment.output, action: "pull_request", branch: event.target.value.trim() || undefined } })} placeholder="Generated by BizBox" />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label className="text-xs text-muted-foreground">PR title</Label>
                      <Input value={attachment.output.title ?? ""} onChange={(event) => updateResource(attachment.resourceId, { output: { ...attachment.output, action: "pull_request", title: event.target.value || undefined } })} placeholder={`Update ${resource?.key ?? "Resource"}`} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-3">
                      <Label className="text-xs text-muted-foreground">PR body</Label>
                      <Textarea value={attachment.output.body ?? ""} onChange={(event) => updateResource(attachment.resourceId, { output: { ...attachment.output, action: "pull_request", body: event.target.value || undefined } })} placeholder="Describe the workflow output." rows={3} />
                    </div>
                  </div>
                ) : null}
                {resource ? (
                  <p className="text-[11px] text-muted-foreground">
                    Mounts at <span className="font-mono">{resource.mountPath}</span>
                  </p>
                ) : (
                  <p className="text-xs text-destructive">This Resource is no longer available in the selected company.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function WorkflowDetail() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [editDraft, setEditDraft] = useState<WorkflowEditDraft | null>(null);
  const [runResourceManifest, setRunResourceManifest] = useState<WorkflowResourceManifest | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [inputMarkdown, setInputMarkdown] = useState("");
  const [handoffResponses, setHandoffResponses] = useState<
    Record<string, string>
  >({});

  const workflowQuery = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId ?? ""),
    queryFn: () => workflowsApi.get(workflowId!),
    enabled: !!workflowId,
    refetchInterval: 5000,
  });
  const schedulesQuery = useQuery({
    queryKey: queryKeys.workflows.schedules(workflowId ?? ""),
    queryFn: () => workflowsApi.listSchedules(workflowId!),
    enabled: !!workflowId,
    refetchInterval: 5000,
  });
  const resourcesQuery = useQuery({
    queryKey: queryKeys.resources.list(selectedCompanyId ?? ""),
    queryFn: () => resourcesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const latestRunId = workflowQuery.data?.latestRun?.id ?? null;
  const activeRunId = selectedRunId ?? latestRunId;
  const runQuery = useQuery({
    queryKey: queryKeys.workflows.run(activeRunId ?? ""),
    queryFn: () => workflowsApi.getRun(activeRunId!),
    enabled: !!activeRunId,
    refetchInterval: (query) => {
      const run = query.state.data as WorkflowRunDetail | undefined;
      return run && ["queued", "running", "awaiting_human"].includes(run.status)
        ? 3000
        : false;
    },
  });
  const activityRunIds = workflowQuery.data?.runs.map((run) => run.id) ?? [];
  const activeRunHandoffIds = runQuery.data?.handoffs.map((handoff) => handoff.id) ?? [];

  const activityQuery = useQuery({
    queryKey: [
      ...queryKeys.workflows.activity(
        selectedCompanyId ?? "",
        workflowId ?? "",
      ),
      activityRunIds.join(","),
      activeRunHandoffIds.join(","),
    ],
    queryFn: () =>
      workflowsApi.activity(selectedCompanyId!, workflowId!, {
        runIds: activityRunIds,
        handoffIds: activeRunHandoffIds,
      }),
    enabled: !!selectedCompanyId && !!workflowId,
    refetchInterval:
      workflowQuery.data?.latestRun &&
      ["queued", "running", "awaiting_human"].includes(
        workflowQuery.data.latestRun.status,
      )
        ? 4000
        : false,
  });

  useEffect(() => {
    if (workflowQuery.data) {
      setBreadcrumbs([
        { label: "Workflows", href: "/workflows" },
        { label: workflowQuery.data.title },
      ]);
      setEditDraft((current) => current ?? toDraft(workflowQuery.data));
    } else {
      setBreadcrumbs([{ label: "Workflows", href: "/workflows" }]);
    }
  }, [setBreadcrumbs, workflowQuery.data]);

  useEffect(() => {
    setSelectedRunId(null);
    setRunResourceManifest(null);
  }, [workflowId]);

  useEffect(() => {
    if (runResourceManifest === null && editDraft) {
      setRunResourceManifest({ version: 1, resources: [] });
    }
  }, [editDraft, runResourceManifest]);

  const refreshWorkflowData = async () => {
    if (!workflowId || !selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.workflows.detail(workflowId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.workflows.list(selectedCompanyId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.workflows.activity(selectedCompanyId, workflowId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.workflows.schedules(workflowId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.deliverables.list(selectedCompanyId),
      }),
    ]);
  };

  const refreshSelectedRun = async () => {
    if (!activeRunId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.workflows.run(activeRunId),
    });
  };

  const refreshAll = async () => {
    await Promise.all([refreshWorkflowData(), refreshSelectedRun()]);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      if (hasIncompletePromptTemplates) {
        throw new Error("Fill in every prompt template before saving.");
      }
      return workflowsApi.update(workflowId!, {
        title: editDraft!.title.trim(),
        description: editDraft!.description.trim() || null,
        status: editDraft!.status,
        runnerConfig: buildWorkflowRunnerConfig(workflowQuery.data?.runnerConfig ?? {}, {
          agentPath: editDraft!.agentPath,
          cwd: editDraft!.cwd,
          command: editDraft!.command,
          model: editDraft!.model,
          promptTemplates: editDraft!.promptTemplates,
        }),
      });
    },
    onSuccess: async () => {
      await refreshAll();
      pushToast({ title: "Workflow updated" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update workflow",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const runMutation = useMutation({
    mutationFn: () =>
      workflowsApi.run(workflowId!, {
        inputMarkdown: inputMarkdown.trim(),
        resourceManifest: runResourceManifest ?? { version: 1, resources: [] },
      }),
    onSuccess: async () => {
      setInputMarkdown("");
      setSelectedRunId(null);
      await refreshWorkflowData();
      pushToast({ title: "Workflow run queued" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to start workflow",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const createScheduleMutation = useMutation({
    mutationFn: (input: WorkflowScheduleMutationInput) =>
      workflowsApi.createSchedule(workflowId!, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.schedules(workflowId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.detail(workflowId!),
        }),
      ]);
      pushToast({ title: "Workflow schedule created" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create schedule",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const updateScheduleMutation = useMutation({
    mutationFn: ({ scheduleId, input }: { scheduleId: string; input: Partial<WorkflowScheduleMutationInput> }) =>
      workflowsApi.updateSchedule(scheduleId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.schedules(workflowId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.detail(workflowId!),
        }),
      ]);
      pushToast({ title: "Workflow schedule updated" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update schedule",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: (scheduleId: string) => workflowsApi.deleteSchedule(scheduleId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.schedules(workflowId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.detail(workflowId!),
        }),
      ]);
      pushToast({ title: "Workflow schedule deleted" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete schedule",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: async (runId: string) => workflowsApi.cancelRun(runId),
    onSuccess: async () => {
      await refreshAll();
      pushToast({ title: "Workflow run cancelled" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to cancel workflow run",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (handoffId: string) =>
      workflowsApi.approveHandoff(handoffId, {
        responseMarkdown: handoffResponses[handoffId]?.trim() || null,
      }),
    onSuccess: refreshAll,
  });
  const rejectMutation = useMutation({
    mutationFn: (handoffId: string) =>
      workflowsApi.rejectHandoff(handoffId, {
        responseMarkdown: handoffResponses[handoffId]?.trim() || null,
      }),
    onSuccess: refreshAll,
  });
  const respondMutation = useMutation({
    mutationFn: (handoffId: string) =>
      workflowsApi.respondHandoff(handoffId, {
        responseMarkdown: handoffResponses[handoffId]?.trim() || "",
      }),
    onSuccess: refreshAll,
  });

  if (workflowQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (workflowQuery.error || !workflowQuery.data || !editDraft) {
    return (
      <EmptyState
        icon={WorkflowIcon}
        message={
          workflowQuery.error
            ? `Failed to load workflow: ${(workflowQuery.error as Error).message}`
            : "Workflow not found."
        }
      />
    );
  }

  const workflow = workflowQuery.data;
  const workflowSchedules = schedulesQuery.data ?? [];
  const runDetail = runQuery.data ?? null;
  const workflowPromptTemplates = readWorkflowPromptTemplates(
    workflow.runnerConfig,
  );
  const hasIncompletePromptTemplates = hasIncompleteWorkflowPromptTemplates(
    editDraft.promptTemplates,
  );
  const definitionPhases = workflow.pipelineDefinition.phases.map(
        (phase) =>
          ({
            id: phase.key,
            companyId: workflow.companyId,
            workflowRunId: activeRunId ?? "definition",
            phaseKey: phase.key,
            label: phase.label,
            kind: phase.kind,
            ordinal: phase.ordinal,
            status: "idle",
            metadata: {
              filePath: phase.filePath,
              functionName: phase.functionName,
              parentKey: phase.parentKey ?? null,
              depth: phase.depth ?? 0,
              agentName: phase.agentName ?? null,
              description: phase.description ?? null,
              systemPrompt: phase.systemPrompt ?? null,
              configuredSkills: phase.configuredSkills ?? [],
            },
            startedAt: null,
            finishedAt: null,
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt,
          }) satisfies WorkflowPhase,
      );
  const telemetryPhases = buildWorkflowTelemetryPhases(runDetail?.telemetryEvents);
  const pipelinePhases = runDetail
    ? telemetryPhases.length > 0
      ? telemetryPhases
      : runDetail.phases.filter((phase) =>
        phase.metadata?.runtimeCalled === true ||
        phase.metadata?.runtimeAgent === true ||
        phase.metadata?.runtimePhase === true)
    : definitionPhases;
  const activeRunStatus = runDetail?.status ?? workflow.latestRun?.status ?? null;

  return (
    <div className="relative isolate space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm">
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={workflow.status} />
              {activeRunStatus ? <StatusBadge status={activeRunStatus} /> : null}
              <span className="text-xs text-muted-foreground">
                {workflow.runnerType.replaceAll("_", " ")}
              </span>
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-bold leading-tight">{workflow.title}</h1>
              <p className="max-w-3xl text-sm text-muted-foreground">
                {workflow.description?.trim() ||
                  "Google ADK workflow with an inferred read-only pipeline and workflow-backed deliverables."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className={workflowPillClassName}>
                Runs {workflow.runs.length}
              </span>
              {workflow.latestRun ? (
                <span className={workflowPillClassName}>
                  Latest {relativeTime(workflow.latestRun.createdAt)}
                </span>
              ) : null}
              <span className={workflowPillClassName}>
                Updated {relativeTime(workflow.updatedAt)}
              </span>
            </div>
          </div>
          {workflow.latestDeliverable ? (
            <Button asChild variant="outline" className="shrink-0">
              <Link to={`/deliverables/${workflow.latestDeliverable.id}`}>
                <Download className="mr-1.5 h-4 w-4" />
                Latest deliverable
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-6">
        <PipelineCard
          workflow={workflow}
          runDetail={runDetail}
          phases={pipelinePhases}
          onCancelRun={(runId) => cancelRunMutation.mutate(runId)}
          cancellingRunId={cancelRunMutation.variables ?? null}
          handoffResponses={handoffResponses}
          setHandoffResponses={setHandoffResponses}
          onApprove={(handoffId) => approveMutation.mutate(handoffId)}
          onReject={(handoffId) => rejectMutation.mutate(handoffId)}
          onRespond={(handoffId) => respondMutation.mutate(handoffId)}
          pendingHandoffId={
            approveMutation.variables ??
            rejectMutation.variables ??
            respondMutation.variables ??
            null
          }
        />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="space-y-6">
            <Card className={workflowPanelClassName}>
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Run workflow</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <WorkflowRunPromptSuggestions
                  promptTemplates={workflowPromptTemplates}
                  onSelectPrompt={setInputMarkdown}
                />
                <Textarea
                  value={inputMarkdown}
                  onChange={(event) => setInputMarkdown(event.target.value)}
                  placeholder="Provide the markdown input that should seed this workflow run."
                  rows={8}
                />
                <WorkflowResourceManifestEditor
                  manifest={runResourceManifest ?? { version: 1, resources: [] }}
                  resources={resourcesQuery.data ?? []}
                  onChange={setRunResourceManifest}
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => runMutation.mutate()}
                    disabled={
                      workflow.status === "archived" || runMutation.isPending || inputMarkdown.trim().length === 0
                    }
                  >
                    {runMutation.isPending ? (
                      <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-1.5 h-4 w-4" />
                    )}
                    Run workflow
                  </Button>
                </div>
                {workflow.status === "archived" ? (
                  <p className="text-xs text-muted-foreground">
                    Workflow archived. Restore it before starting new runs. Existing runs and history remain available.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {runDetail?.invocation ? (
              <WorkflowInvocationCard runDetail={runDetail} />
            ) : null}
            <WorkflowRunInputCard runDetail={runDetail} />
            <WorkflowRunConsoleCard runDetail={runDetail} />

            <RunHistoryCard
              workflow={workflow}
              activeRunId={activeRunId}
              onSelectRun={setSelectedRunId}
            />
            <WorkflowRunResourcesCard runDetail={runDetail} />

            <ActivityCard
              events={activityQuery.data ?? []}
              loading={activityQuery.isLoading}
            />
          </div>

          <div className="space-y-6">
            <Card className={workflowPanelClassName}>
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Workflow settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    value={editDraft.title}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, title: event.target.value }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={editDraft.description}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, description: event.target.value }
                          : current,
                      )
                    }
                    rows={4}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <select
                    value={editDraft.status}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, status: event.target.value }
                          : current,
                      )
                    }
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="active">Active</option>
                    {editDraft.status !== "archived" ? <option value="paused">Paused</option> : null}
                    <option value="archived">Archived</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>ADK path</Label>
                  <Input
                    value={editDraft.agentPath}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, agentPath: event.target.value }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Working directory</Label>
                  <Input
                    value={editDraft.cwd}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, cwd: event.target.value }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Command override</Label>
                  <Input
                    value={editDraft.command}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, command: event.target.value }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Input
                    value={editDraft.model}
                    onChange={(event) =>
                      setEditDraft((current) =>
                        current
                          ? { ...current, model: event.target.value }
                      : current,
                      )
                    }
                  />
                </div>
                <WorkflowPromptTemplatesEditor
                  value={editDraft.promptTemplates}
                  onChange={(next) =>
                    setEditDraft((current) =>
                      current
                        ? { ...current, promptTemplates: next }
                        : current,
                    )
                  }
                />
                {hasIncompletePromptTemplates ? (
                  <p className="text-xs text-muted-foreground">
                    Fill in every prompt template before saving.
                  </p>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    onClick={() => saveMutation.mutate()}
                    disabled={
                      saveMutation.isPending ||
                      !editDraft.title.trim() ||
                      !editDraft.agentPath.trim() ||
                      hasIncompletePromptTemplates
                    }
                  >
                    <Save className="mr-1.5 h-4 w-4" />
                    Save workflow
                  </Button>
                </div>
              </CardContent>
            </Card>

            <WorkflowSchedulesEditor
              schedules={workflowSchedules}
              onCreate={(input) =>
                createScheduleMutation.mutateAsync(input).then(() => undefined)
              }
              onUpdate={(scheduleId, input) =>
                updateScheduleMutation.mutateAsync({ scheduleId, input }).then(() => undefined)
              }
              onDelete={(scheduleId) => deleteScheduleMutation.mutate(scheduleId)}
              pendingScheduleId={
                updateScheduleMutation.variables?.scheduleId ??
                deleteScheduleMutation.variables ??
                null
              }
              createPending={createScheduleMutation.isPending}
            />

            <Card className={workflowPanelClassName}>
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Active run deliverables</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {runDetail?.deliverables.length ? (
                  runDetail.deliverables.map((deliverable) => (
                    <Link
                      key={deliverable.id}
                      to={`/deliverables/${deliverable.id}`}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm no-underline transition-colors hover:bg-background/60"
                    >
                      <span className="truncate">{deliverable.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatFileSize(deliverable.byteSize)}
                      </span>
                    </Link>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No deliverables yet.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function PipelineCard({
  workflow,
  runDetail,
  phases,
  onCancelRun,
  cancellingRunId,
  handoffResponses,
  setHandoffResponses,
  onApprove,
  onReject,
  onRespond,
  pendingHandoffId,
}: {
  workflow: WorkflowDetailType;
  runDetail: WorkflowRunDetail | null;
  phases: WorkflowPhase[];
  onCancelRun: (runId: string) => void;
  cancellingRunId: string | null;
  handoffResponses: Record<string, string>;
  setHandoffResponses: Dispatch<SetStateAction<Record<string, string>>>;
  onApprove: (handoffId: string) => void;
  onReject: (handoffId: string) => void;
  onRespond: (handoffId: string) => void;
  pendingHandoffId: string | null;
}) {
  const [activeView, setActiveView] = useState("pipeline");
  const handoffsByPhase = useMemo(() => {
    const map = new Map<string, WorkflowHandoff[]>();
    for (const handoff of runDetail?.handoffs ?? []) {
      const list = map.get(handoff.phaseKey) ?? [];
      list.push(handoff);
      map.set(handoff.phaseKey, list);
    }
    return map;
  }, [runDetail?.handoffs]);
  const graph = useMemo(
    () => buildWorkflowGraph(phases, handoffsByPhase, runDetail),
    [handoffsByPhase, phases, runDetail],
  );
  const pipelineAgents = useMemo(
    () => workflowPipelineAgentPhases(phases),
    [phases],
  );
  const canCancelRun = Boolean(
    runDetail && ["queued", "running", "awaiting_human"].includes(runDetail.status),
  );
  const cancelIsPending = cancellingRunId === runDetail?.id;
  const pipelineSummary = runDetail
    ? `Run ${runDetail.status.replaceAll("_", " ")} · ${pipelineAgents.length} called agent${pipelineAgents.length === 1 ? "" : "s"}`
    : `${pipelineAgents.length} inferred agent${pipelineAgents.length === 1 ? "" : "s"}`;
  const behaviorAgents = useMemo(
    () => buildWorkflowBehaviorAgents(runDetail, phases).filter((agent) => !runDetail || agent.called),
    [phases, runDetail],
  );

  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm font-semibold">Pipeline</CardTitle>
            <div className="text-xs text-muted-foreground">
              {pipelineSummary}
            </div>
          </div>
          {canCancelRun && runDetail ? (
            <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={cancelIsPending}
                onClick={() => {
                  if (!window.confirm("Cancel this workflow run? Pending human handoffs will be closed.")) {
                    return;
                  }
                  onCancelRun(runDetail.id);
                }}
              >
                {cancelIsPending ? (
                  <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <X className="mr-1.5 h-4 w-4" />
                )}
                Cancel run
              </Button>
              <div className="text-right text-[11px] text-muted-foreground">
                Stops execution and closes pending handoffs.
              </div>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeView} onValueChange={setActiveView}>
          <TabsList variant="line" className="mb-4 justify-start">
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="behavior">Agent behavior</TabsTrigger>
          </TabsList>
          <TabsContent value="pipeline">
            {pipelineAgents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                No agent calls were captured for this workflow.
              </div>
            ) : (
              <WorkflowTopologyGraph
                graph={graph}
                handoffResponses={handoffResponses}
                setHandoffResponses={setHandoffResponses}
                onApprove={onApprove}
                onReject={onReject}
                onRespond={onRespond}
                pendingHandoffId={pendingHandoffId}
              />
            )}
          </TabsContent>
          <TabsContent value="behavior">
            <WorkflowBehaviorChart agents={behaviorAgents} hasRun={Boolean(runDetail)} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function formatBehaviorValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function BehaviorPromptBlock({
  label,
  value,
  tone,
  empty,
  collapsible = false,
  testId,
}: {
  label: string;
  value: string | null;
  tone: "operator" | "system";
  empty: string;
  collapsible?: boolean;
  testId?: string;
}) {
  const panelClassName = cn(
    "rounded-xl border",
    tone === "system"
      ? "border-violet-500/25 bg-violet-500/5"
      : "border-cyan-500/25 bg-cyan-500/5",
  );
  const labelClassName = cn(
    "text-[10px] font-semibold uppercase tracking-[0.16em]",
    tone === "system" ? "text-violet-400" : "text-cyan-400",
  );
  if (collapsible && value) {
    return (
      <details className={panelClassName} data-testid={testId}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3">
          <span className={labelClassName}>{label}</span>
          <span className="text-[10px] text-muted-foreground">Click to expand</span>
        </summary>
        <div className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-violet-500/20 p-3 text-xs leading-relaxed">
          {value}
        </div>
      </details>
    );
  }
  return (
    <div className={cn(panelClassName, "p-3")}>
      <div className={cn(labelClassName, "mb-1.5")}>
        {label}
      </div>
      <div className={cn("whitespace-pre-wrap text-xs leading-relaxed", !value && "text-muted-foreground")}>
        {value || empty}
      </div>
    </div>
  );
}

function WorkflowBehaviorAgentNode({ agent, index }: { agent: WorkflowBehaviorAgent; index: number }) {
  const isTool = agent.actorKind === "tool";
  const skillCount = new Set([
    ...agent.skills.map((skill) => skill.name),
    ...agent.configuredTools,
    ...agent.tools.map((tool) => tool.name),
  ]).size;
  return (
    <div
      className="relative pl-10"
      data-behavior-actor-kind={isTool ? "tool" : "agent"}
    >
      {index > 0 ? <div className="absolute -top-6 left-[15px] h-6 w-px bg-border" /> : null}
      <div
        className={cn(
          "absolute left-0 top-4 flex h-8 w-8 items-center justify-center rounded-full border bg-background",
          agent.called ? "border-emerald-500/50 text-emerald-400" : "border-border text-muted-foreground",
        )}
      >
        {isTool ? <Wrench className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="rounded-2xl border border-border/70 bg-background/45 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{agent.name}</h3>
              <StatusBadge status={agent.status} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {isTool
                ? agent.called
                  ? "Queried during this run"
                  : "Not queried in this run"
                : agent.called
                  ? "Called during this run"
                  : "Not called in this run"}
              {agent.description ? ` · ${agent.description}` : ""}
            </div>
          </div>
          <span className={workflowPillClassName}>
            {isTool
              ? "Data query tool"
              : `${skillCount} skill${skillCount === 1 ? "" : "s"} / tool${skillCount === 1 ? "" : "s"}`}
          </span>
          {agent.model ? (
            <span className={workflowPillClassName}>Model {agent.model}</span>
          ) : null}
          {agent.service ? (
            <span className={workflowPillClassName}>Service {agent.service}</span>
          ) : null}
        </div>

        {!isTool && agent.tools.length > 0 ? (
          <div
            className="mt-3 ml-1 border-l-2 border-emerald-500/30 pl-4"
            data-testid="behavior-child-tools"
          >
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
              <Wrench className="h-3.5 w-3.5" />
              Child tools called by this agent
            </div>
            <div className="flex flex-wrap gap-2">
              {[...new Set(agent.tools.map((tool) => tool.name))].map((toolName) => (
                <span key={toolName} className={workflowPillClassName}>
                  {toolName}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {!isTool ? <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <BehaviorPromptBlock
            label={
              agent.promptSource === "runtime_service"
                ? "Prompt sent to service"
                : agent.promptSource === "workflow_handoff"
                  ? "Workflow handoff"
                  : agent.promptSource === "telemetry_handoff"
                    ? "Prompt from telemetry handoff"
                : agent.promptSource === "adk_event"
                  ? "Prompt from ADK event"
                  : "Operator / run prompt"
            }
            value={agent.prompt}
            tone="operator"
            collapsible={
              agent.promptSource === "adk_event"
              || agent.promptSource === "telemetry_handoff"
              || agent.promptSource === "workflow_handoff"
            }
            testId="behavior-agent-prompt"
            empty={
              agent.promptSource === "unavailable"
                ? "ADK did not expose this downstream handoff prompt."
                : "No prompt was stored for this run."
            }
          />
          <BehaviorPromptBlock
            label="System instruction"
            value={agent.systemPrompt}
            tone="system"
            collapsible
            testId="behavior-system-instruction"
            empty={
              agent.promptSource === "runtime_service"
                ? "Direct service calls do not have an ADK system instruction."
                : "No literal ADK instruction was available from static analysis."
            }
          />
        </div> : null}

        <details
          className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5"
          data-testid="behavior-agent-output"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
              {isTool ? "Tool output" : agent.service ? "Service output" : "Agent / LLM output"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {agent.output === null ? "No output captured" : "Click to expand"}
            </span>
          </summary>
          {agent.output !== null ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-emerald-500/20 bg-neutral-950 p-3 text-[11px] text-neutral-200">
              {formatBehaviorValue(agent.output)}
            </pre>
          ) : null}
        </details>

        <details className="mt-3 rounded-xl border border-border/60 bg-card/60">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-medium hover:bg-accent/30">
            <span className="flex items-center gap-2">
              <Wrench className="h-3.5 w-3.5" />
              Skills & tools used
            </span>
            <span className="text-muted-foreground">Click to expand</span>
          </summary>
          <div className="space-y-2 border-t border-border/60 p-3">
            {agent.skills.map((skill) => (
              <details key={skill.name} className="rounded-lg border border-violet-500/25 bg-violet-500/5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold">
                  <span>{skill.name}</span>
                  <span className="text-[10px] font-normal uppercase tracking-wide text-violet-400">Skill · expand</span>
                </summary>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-violet-500/20 bg-neutral-950 p-3 text-[11px] text-neutral-200">
                  {skill.content}
                </pre>
              </details>
            ))}
            {agent.tools.length > 0 ? (
              agent.tools.map((tool, toolIndex) => (
                <div key={`${tool.id}-${toolIndex}`} className="rounded-lg border border-border/60 bg-background/60 p-3">
                  <div className="text-xs font-semibold">{tool.name}</div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-400">
                        Request sent
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-neutral-950 p-2 text-[11px] text-neutral-200">
                        {formatBehaviorValue(tool.input)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                        Response received
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-neutral-950 p-2 text-[11px] text-neutral-200">
                        {tool.output === null ? "Response not captured" : formatBehaviorValue(tool.output)}
                      </pre>
                    </div>
                  </div>
                </div>
              ))
            ) : agent.configuredTools.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                Configured but not observed in this run: {agent.configuredTools.join(", ")}.
              </div>
            ) : agent.skills.length === 0 ? (
              <div className="text-xs text-muted-foreground">No skill or tool calls were observed.</div>
            ) : null}
          </div>
        </details>

        <details
          className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5"
          data-testid="behavior-data-sources"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-medium hover:bg-accent/30">
            <span className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5" />
              Data sources & query outcomes
            </span>
            <span className="text-muted-foreground">
              {agent.dataSources.length} source{agent.dataSources.length === 1 ? "" : "s"} · expand
            </span>
          </summary>
          <div className="space-y-2 border-t border-cyan-500/20 p-3">
            {agent.dataSources.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No configured data source or observed query was captured for this agent.
              </div>
            ) : agent.dataSources.map((source, sourceIndex) => (
              <div key={`${source.id}-${sourceIndex}`} className="rounded-lg border border-border/60 bg-background/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold">{source.name}</div>
                  <span className={workflowPillClassName}>
                    {source.kind === "resource" ? "Workflow resource" : source.status === "queried" ? "Queried" : "Configured"}
                  </span>
                </div>
                {source.status === "configured" ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Available to the agent, but no query was observed in this run.
                  </div>
                ) : (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-400">
                        {source.kind === "resource" ? "Mounted source" : "Query / request"}
                      </div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-950 p-2 text-[11px] text-neutral-200">
                        {source.query === null ? "Query not captured" : formatBehaviorValue(source.query)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                        Query outcome
                      </div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-950 p-2 text-[11px] text-neutral-200">
                        {source.outcome === null ? "Outcome not captured" : formatBehaviorValue(source.outcome)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function WorkflowBehaviorChart({ agents, hasRun }: { agents: WorkflowBehaviorAgent[]; hasRun: boolean }) {
  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        No ADK agents were found in this workflow definition.
      </div>
    );
  }
  return (
    <div className="rounded-3xl border border-border/70 bg-[radial-gradient(circle_at_top,_rgba(139,92,246,0.08),_transparent_40%)] p-4">
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-border/60 bg-background/50 p-3">
        <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          {hasRun
            ? "This trace separates stored run input, statically discovered ADK system instructions, and observed function calls. Expand any agent to inspect its skills and tool payloads."
            : "Run the workflow to populate call status and tool usage. Static system instructions are shown when the analyzer can read a literal instruction value."}
        </div>
      </div>
      <div className="space-y-6">
        {agents.map((agent, index) => (
          <WorkflowBehaviorAgentNode key={agent.phaseKey} agent={agent} index={index} />
        ))}
      </div>
    </div>
  );
}

function WorkflowRunConsoleCard({
  runDetail,
}: {
  runDetail: WorkflowRunDetail | null;
}) {
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const [stderrOpen, setStderrOpen] = useState(true);

  useEffect(() => {
    setTranscriptMode("nice");
  }, [runDetail?.id]);

  useEffect(() => {
    setStderrOpen(true);
  }, [runDetail?.id]);

  const consoleEntries = runDetail?.consoleEntries ?? [];
  const transcript = useMemo(
    () =>
      buildTranscript(
        consoleEntries as WorkflowRunConsoleChunk[],
        getUIAdapter("google_adk"),
      ),
    [consoleEntries],
  );

  if (!runDetail) {
    return (
      <Card className={workflowPanelClassName}>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Operator console</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Run a workflow to inspect stdout and stderr here.
          </div>
        </CardContent>
      </Card>
    );
  }

  const isLive = ["queued", "running", "awaiting_human"].includes(
    runDetail.status,
  );

  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <TerminalSquare className="h-4 w-4" />
            Operator console
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5">
              {(["nice", "raw"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                    transcriptMode === mode
                      ? "bg-accent text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setTranscriptMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            {isLive ? (
              <span className="flex items-center gap-1 text-xs text-cyan-500">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-cyan-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-500" />
                </span>
                Live
              </span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-80 overflow-y-auto rounded-lg border border-border/70 bg-neutral-950 p-3 font-mono text-xs">
          <RunTranscriptView
            entries={transcript}
            mode={transcriptMode}
            streaming={isLive}
            emptyMessage="No workflow console output yet."
          />
        </div>

        {runDetail.error || runDetail.stderrExcerpt || runDetail.resultJson ? (
          <div className="rounded-lg border border-border/70 bg-neutral-950 p-3 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {runDetail.error || runDetail.stderrExcerpt ? "stderr" : "result"}
              </span>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setStderrOpen((value) => !value)}
                aria-label={stderrOpen ? "Collapse stderr details" : "Expand stderr details"}
              >
                {stderrOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
            </div>
            {stderrOpen ? (
              <div className="mt-2 max-h-80 space-y-3 overflow-y-auto">
                {runDetail.error ? (
                  <div className="whitespace-pre-wrap break-words text-red-400">
                    {runDetail.error}
                  </div>
                ) : null}
                {runDetail.stderrExcerpt ? (
                  <pre className="whitespace-pre-wrap break-words text-foreground/90">
                    {runDetail.stderrExcerpt}
                  </pre>
                ) : null}
                {runDetail.resultJson ? (
                  <pre className="whitespace-pre-wrap break-words text-foreground/90">
                    {JSON.stringify(runDetail.resultJson, null, 2)}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WorkflowInvocationCard({
  runDetail,
}: {
  runDetail: WorkflowRunDetail | null;
}) {
  const invocation = runDetail?.invocation ?? null;
  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Repeat className="h-4 w-4" />
          Invocation bridge
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!runDetail ? (
          <div className="text-muted-foreground">
            Run a workflow to inspect the originating routine and contract.
          </div>
        ) : invocation ? (
          <>
            <div className="grid gap-2 md:grid-cols-2">
              <InvocationField
                label="Source routine"
                value={invocation.sourceRoutineTitle ?? invocation.sourceRoutineId}
              />
              <InvocationField
                label="Routine run"
                value={invocation.sourceRoutineRunId}
              />
              <InvocationField
                label="Contract"
                value={invocation.contractVersion}
              />
              <InvocationField
                label="Payload kind"
                value={invocation.inputKind === "json" ? "JSON" : "Markdown"}
              />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <InvocationField
                label="Target workflow key"
                value={invocation.targetWorkflowKey ?? "Explicit workflow id"}
              />
              <InvocationField
                label="Target capability"
                value={invocation.targetCapability ?? "None"}
              />
            </div>
            {invocation.sourceRoutineRunSource ? (
              <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                Routed from routine run source: {invocation.sourceRoutineRunSource}
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-muted-foreground">
            This run was started manually or from a schedule. No routine bridge record is attached.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InvocationField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 break-words text-sm text-foreground">{value}</div>
    </div>
  );
}

function WorkflowRunInputCard({
  runDetail,
}: {
  runDetail: WorkflowRunDetail | null;
}) {
  if (!runDetail || !runDetail.inputMarkdown.trim()) {
    return (
      <Card className={workflowPanelClassName}>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Operator input</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Run a workflow to inspect the stored operator input here.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Operator input</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="max-h-80 overflow-y-auto rounded-lg border border-border/70 bg-background/60 p-3 text-sm whitespace-pre-wrap break-words">
          {runDetail.inputMarkdown}
        </pre>
      </CardContent>
    </Card>
  );
}

function readRunResourceVersions(run: { contextSnapshot: Record<string, unknown> | null }): ResourceVersionReference[] {
  const raw = run.contextSnapshot?.resourceVersions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is ResourceVersionReference => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<ResourceVersionReference>;
    return typeof candidate.resourceId === "string" &&
      typeof candidate.resourceKey === "string" &&
      typeof candidate.commit === "string" &&
      typeof candidate.mountPath === "string";
  });
}

function readRunResourceOutputs(run: { contextSnapshot: Record<string, unknown> | null }): ResourceOutputResult[] {
  const raw = run.contextSnapshot?.resourceOutputs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is ResourceOutputResult => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<ResourceOutputResult>;
    return typeof candidate.resourceId === "string" &&
      typeof candidate.inputCommit === "string" &&
      typeof candidate.action === "string" &&
      typeof candidate.status === "string";
  });
}

function isSafePullRequestUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

function WorkflowRunResourcesCard({ runDetail }: { runDetail: WorkflowRunDetail | null }) {
  const versions = runDetail ? readRunResourceVersions(runDetail) : [];
  const outputs = runDetail ? readRunResourceOutputs(runDetail) : [];
  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="h-4 w-4" />
          Run Resources
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!runDetail ? (
          <div className="text-sm text-muted-foreground">Select a run to inspect its Resource mounts.</div>
        ) : versions.length === 0 && outputs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No Resources were attached to this run.</div>
        ) : (
          <div className="space-y-2">
            {versions.map((version) => (
              <div key={version.resourceId} className="rounded-xl border border-border/60 bg-background/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm font-medium">{version.resourceKey}</span>
                  <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {version.published ? "Published" : "Materialized"}
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <span>Mount: <code>{version.mountPath}</code></span>
                  <span>Commit: <code>{version.commit.slice(0, 12)}</code></span>
                  <span>Requested: <code>{version.requestedRef}</code></span>
                  <span>Resolved: <code>{version.resolvedRef}</code></span>
                </div>
              </div>
            ))}
            {outputs.map((output) => (
              <div key={`output-${output.resourceId}`} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono font-medium">Output · {output.action}</span>
                  <span className="text-muted-foreground">{output.status.replaceAll("_", " ")}</span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  {output.outputCommit ? <span>Commit: <code>{output.outputCommit.slice(0, 12)}</code></span> : null}
                  {output.branch ? <span>Branch: <code>{output.branch}</code></span> : null}
                  {output.targetRef ? <span>Target: <code>{output.targetRef}</code></span> : null}
                  {output.pullRequestUrl && isSafePullRequestUrl(output.pullRequestUrl) ? <a className="text-cyan-700 underline dark:text-cyan-300" href={output.pullRequestUrl} target="_blank" rel="noreferrer">Pull request</a> : null}
                  {output.changedFiles ? <span>Files: {output.changedFiles.length}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunHistoryCard({
  workflow,
  activeRunId,
  onSelectRun,
}: {
  workflow: WorkflowDetailType;
  activeRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}) {
  const latestRunId = workflow.latestRun?.id ?? null;

  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Run history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {workflow.runs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No runs yet.</div>
        ) : (
          workflow.runs.map((run) => {
            const isSelected = activeRunId === run.id;
            const isLatest = latestRunId === run.id;
            const resourceCount = readRunResourceVersions(run).length;
            return (
              <button
                key={run.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectRun(isLatest ? null : run.id)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-colors",
                  isSelected
                    ? "border-cyan-500/40 bg-cyan-500/10"
                    : isLatest
                      ? "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15"
                      : "border-border/60 bg-background/40 hover:bg-background/60",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span>{run.status.replaceAll("_", " ")}</span>
                    {isLatest ? (
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        Latest
                      </span>
                    ) : null}
                    {resourceCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:text-cyan-300">
                        <GitBranch className="h-3 w-3" />
                        {resourceCount} Resource{resourceCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="text-xs text-muted-foreground"
                    title={formatDateTime(run.createdAt)}
                  >
                    {relativeTime(run.createdAt)}
                  </div>
                </div>
                {run.summary ? (
                  <p className="mt-2 text-sm text-muted-foreground line-clamp-3">
                    {run.summary}
                  </p>
                ) : null}
                <div className="mt-2 text-xs text-muted-foreground">
                  {run.startedAt
                    ? `Started ${formatDateTime(run.startedAt)}`
                    : "Queued"}
                  {run.finishedAt
                    ? ` · Finished ${formatDateTime(run.finishedAt)}`
                    : ""}
                </div>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ActivityCard({
  events,
  loading,
}: {
  events: ActivityEvent[];
  loading: boolean;
}) {
  return (
    <Card className={workflowPanelClassName}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading activity…</div>
        ) : events.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No workflow activity yet.
          </div>
        ) : (
          events.slice(0, 12).map((event) => (
            <div key={event.id} className="rounded-xl border border-border/60 bg-background/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  {event.action.replaceAll(".", " ")}
                </div>
                <div
                  className="text-xs text-muted-foreground"
                  title={formatDateTime(event.createdAt)}
                >
                  {relativeTime(event.createdAt)}
                </div>
              </div>
              {event.entityType ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {event.entityType}
                </div>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
