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
  Download,
  LoaderCircle,
  Play,
  Repeat,
  Save,
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
} from "@paperclipai/shared";
import { workflowsApi } from "../api/workflows";
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
import {
  buildWorkflowRunnerConfig,
  hasIncompleteWorkflowPromptTemplates,
  readWorkflowPromptTemplates,
} from "../config/workflow-run-prompts";
import type { WorkflowScheduleMutationInput } from "../api/workflows";

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

type GraphNodeKind = "start" | "phase" | "human" | "terminal" | "deliverable";

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
};

const GRAPH_NODE_WIDTH = 260;
const GRAPH_TOOL_WIDTH = 220;
const GRAPH_HUMAN_WIDTH = 320;
const GRAPH_DELIVERABLE_WIDTH = 220;
const GRAPH_COLUMN_GAP = 120;
const GRAPH_BRANCH_GAP = 44;
const GRAPH_CHAIN_GAP = 18;
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
  chainHeight: number;
  subtreeHeight: number;
};

export function buildWorkflowGraph(
  phases: WorkflowPhase[],
  handoffsByPhase: Map<string, WorkflowHandoff[]>,
  runDetail: WorkflowRunDetail | null,
): WorkflowGraph {
  const phaseKeys = new Set(phases.map((phase) => phase.phaseKey));
  const childrenByParent = new Map<string | null, WorkflowPhase[]>();
  for (const phase of phases) {
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
    const phaseHeight = estimateGraphNodeHeight("phase", undefined, phase.kind);
    const handoffHeights = handoffs.map((handoff) =>
      estimateGraphNodeHeight("human", handoff),
    );
    const chainHeight =
      phaseHeight +
      handoffHeights.reduce((sum, height) => sum + height, 0) +
      handoffs.length * GRAPH_CHAIN_GAP;

    const childLayouts = children.map((child) => measurePhase(child));
    const childrenHeight =
      childLayouts.length > 0
        ? childLayouts.reduce((sum, child) => sum + child.subtreeHeight, 0) +
          Math.max(0, childLayouts.length - 1) * GRAPH_BRANCH_GAP
        : 0;
    const subtreeHeight = Math.max(chainHeight, childrenHeight);

    const layout = {
      handoffs,
      children,
      chainHeight,
      subtreeHeight,
    };
    phaseLayoutCache.set(phase.phaseKey, layout);
    return layout;
  };

  const positionPhase = (
    phase: WorkflowPhase,
    level: number,
    startY: number,
  ): { leafIds: string[]; maxLevel: number } => {
    const layout = measurePhase(phase);
    const phaseId = `phase:${phase.phaseKey}`;
    const phaseNode = nodes.get(phaseId);
    if (!phaseNode) {
      throw new Error(`Missing graph node for phase ${phase.phaseKey}`);
    }

    const phaseHeight = phaseNode.height;
    const chainTop = startY + Math.max(0, (layout.subtreeHeight - layout.chainHeight) / 2);
    let cursorY = chainTop;
    phaseNode.level = level;
    phaseNode.x = GRAPH_PADDING_X + level * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
    if (phase.kind === "tool") {
      phaseNode.x -= 20;
    }
    phaseNode.y = cursorY;
    cursorY += phaseHeight + GRAPH_CHAIN_GAP;

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
      handoffNode.x =
        GRAPH_PADDING_X + currentLevel * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) - 16;
      handoffNode.y = cursorY;
      cursorY += handoffNode.height + GRAPH_CHAIN_GAP;
      lastId = handoffId;
    }

    const childLayoutHeight = layout.children.reduce(
      (sum, child) => sum + measurePhase(child).subtreeHeight,
      0,
    );
    const childGapHeight =
      Math.max(0, layout.children.length - 1) * GRAPH_BRANCH_GAP;
    const childBlockHeight = childLayoutHeight + childGapHeight;
    let childCursorY =
      startY + Math.max(0, (layout.subtreeHeight - childBlockHeight) / 2);
    const childLevel = level + layout.handoffs.length + 1;
    const leafIdsFromChildren: string[] = [];
    let maxLevel = currentLevel;

    for (const child of layout.children) {
      const childResult = positionPhase(child, childLevel, childCursorY);
      leafIdsFromChildren.push(...childResult.leafIds);
      maxLevel = Math.max(maxLevel, childResult.maxLevel);
      childCursorY += measurePhase(child).subtreeHeight + GRAPH_BRANCH_GAP;
    }

    if (layout.children.length === 0) {
      return { leafIds: [lastId], maxLevel: currentLevel };
    }

    return { leafIds: leafIdsFromChildren, maxLevel };
  };

  const rootLayouts = roots.map((phase) => measurePhase(phase));
  const rootBlockHeight =
    rootLayouts.reduce((sum, layout) => sum + layout.subtreeHeight, 0) +
    Math.max(0, rootLayouts.length - 1) * GRAPH_BRANCH_GAP;
  const startHeight = nodes.get("graph:start")?.height ?? 0;
  const graphBlockHeight = Math.max(startHeight, rootBlockHeight);
  const startNode = nodes.get("graph:start");
  if (!startNode) {
    throw new Error("Missing start graph node");
  }
  startNode.x = GRAPH_PADDING_X;
  startNode.y =
    GRAPH_PADDING_Y + Math.max(0, (graphBlockHeight - startHeight) / 2);

  let rootCursorY =
    GRAPH_PADDING_Y + Math.max(0, (graphBlockHeight - rootBlockHeight) / 2);
  let maxLevel = 0;
  const allLeafIds: string[] = roots.length > 0 ? [] : ["graph:start"];
  for (const root of roots) {
    const result = positionPhase(root, 1, rootCursorY);
    allLeafIds.push(...result.leafIds);
    maxLevel = Math.max(maxLevel, result.maxLevel);
    rootCursorY += measurePhase(root).subtreeHeight + GRAPH_BRANCH_GAP;
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
  terminalNode.x =
    GRAPH_PADDING_X + terminalLevel * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
  const leafCenters = allLeafIds
    .map((nodeId) => nodes.get(nodeId))
    .filter((node): node is GraphNode => Boolean(node))
    .map((node) => node.y + node.height / 2);
  const terminalCenterY =
    leafCenters.length > 0
      ? leafCenters.reduce((sum, value) => sum + value, 0) / leafCenters.length
      : GRAPH_PADDING_Y + graphBlockHeight / 2;
  terminalNode.y = Math.max(
    GRAPH_PADDING_Y,
    terminalCenterY - terminalNode.height / 2,
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
  let handoffTailY = terminalNode.y + terminalNode.height / 2;
  if (orphanHandoffs.length > 0) {
    const orphanGroupHeight =
      orphanHandoffs.reduce(
        (sum, handoff) =>
          sum + estimateGraphNodeHeight("human", handoff),
        0,
      ) +
      Math.max(0, orphanHandoffs.length - 1) * GRAPH_CHAIN_GAP;
    handoffTailY = Math.max(
      GRAPH_PADDING_Y,
      terminalNode.y + terminalNode.height / 2 - orphanGroupHeight / 2,
    );
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
      handoffNode.x =
        GRAPH_PADDING_X +
        handoffTailLevel * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) -
        16;
      handoffNode.y = handoffTailY;
      handoffTailY += handoffNode.height + GRAPH_CHAIN_GAP;
      previousId = handoffId;
    }
  }

  const deliverables = runDetail?.deliverables ?? [];
  const deliverableLevel = handoffTailLevel + 1;
  const deliverableGroupHeight =
    deliverables.length > 0
      ? deliverables.length * estimateGraphNodeHeight("deliverable") +
        Math.max(0, deliverables.length - 1) * GRAPH_BRANCH_GAP
      : 0;
  let deliverableCursorY =
    Math.max(
      GRAPH_PADDING_Y,
      terminalNode.y + terminalNode.height / 2 - deliverableGroupHeight / 2,
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
    deliverableNode.x =
      GRAPH_PADDING_X + deliverableLevel * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
    deliverableNode.y = deliverableCursorY;
    deliverableCursorY += deliverableNode.height + deliverableGap;
  }
  const orderedNodes = [...nodes.values()].sort((a, b) => {
    if (a.kind === "start") return -1;
    if (b.kind === "start") return 1;
    if (a.kind === "terminal") return 1;
    if (b.kind === "terminal") return -1;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.id.localeCompare(b.id);
  });

  const graphWidth =
    GRAPH_PADDING_X * 2 +
    (Math.max(terminalLevel, handoffTailLevel, deliverableLevel) + 1) *
      (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
  const graphHeight = Math.max(
    420,
    ...orderedNodes.map((node) => node.y + node.height + GRAPH_PADDING_Y),
  );

  return {
    nodes: orderedNodes,
    edges,
    width: graphWidth,
    height: graphHeight,
  };
}

function nodeCenterRight(node: GraphNode) {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function nodeCenterLeft(node: GraphNode) {
  return { x: node.x, y: node.y + node.height / 2 };
}

function buildEdgePath(from: GraphNode, to: GraphNode) {
  const start = nodeCenterRight(from);
  const end = nodeCenterLeft(to);
  const curve = Math.max(36, Math.abs(end.x - start.x) * 0.35);
  return `M ${start.x} ${start.y} C ${start.x + curve} ${start.y}, ${end.x - curve} ${end.y}, ${end.x} ${end.y}`;
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
    <div className="overflow-x-auto rounded-3xl border border-border/70 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent)] p-3">
      <div
        className="relative"
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
  response,
  onChangeResponse,
  onApprove,
  onReject,
  onRespond,
  pending,
}: {
  node: GraphNode;
  response: string;
  onChangeResponse: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRespond: () => void;
  pending: boolean;
}) {
  if (node.kind === "human" && node.handoff) {
    return (
      <GraphHumanNode
        handoff={node.handoff}
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
    return <GraphStartNode status={node.status ?? "idle"} />;
  if (node.kind === "terminal")
    return <GraphTerminalNode status={node.status ?? "idle"} />;
  if (node.kind === "deliverable" && node.deliverable)
    return <GraphDeliverableNode node={node} />;
  return <GraphPhaseNode node={node} />;
}

function GraphStartNode({ status }: { status: string }) {
  return (
    <div
      className={cn(
        "rounded-full border px-5 py-4 shadow-sm",
        status === "running"
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

function GraphDeliverableNode({ node }: { node: GraphNode }) {
  return (
    <div className="rounded-3xl border border-emerald-500/55 bg-emerald-500/[0.08] p-4 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_0_28px_rgba(16,185,129,0.18)] animate-pulse">
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

function GraphPhaseNode({ node }: { node: GraphNode }) {
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
      ? "border-amber-500/60 bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.2)] animate-pulse"
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
  response,
  onChange,
  onApprove,
  onReject,
  onRespond,
  pending,
}: {
  handoff: WorkflowHandoff;
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
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
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

export function WorkflowDetail() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [editDraft, setEditDraft] = useState<WorkflowEditDraft | null>(null);
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
  }, [workflowId]);

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
      workflowsApi.run(workflowId!, { inputMarkdown: inputMarkdown.trim() }),
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
  const pipelinePhases = runDetail?.phases.length
    ? runDetail.phases
    : workflow.pipelineDefinition.phases.map(
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
            },
            startedAt: null,
            finishedAt: null,
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt,
          }) satisfies WorkflowPhase,
      );
  const activeRunStatus = runDetail?.status ?? workflow.latestRun?.status ?? null;

  return (
    <div className="relative isolate space-y-6">
      <div className="pointer-events-none absolute inset-x-0 top-[-4rem] -z-10 h-72 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.08),transparent_35%),radial-gradient(circle_at_top_right,_rgba(6,182,212,0.06),transparent_28%)]" />

      <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.06),transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(6,182,212,0.05),transparent_28%)]" />
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
                <div className="flex justify-end">
                  <Button
                    onClick={() => runMutation.mutate()}
                    disabled={
                      runMutation.isPending || inputMarkdown.trim().length === 0
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
              </CardContent>
            </Card>

            {runDetail?.invocation ? (
              <WorkflowInvocationCard runDetail={runDetail} />
            ) : null}
            <WorkflowRunConsoleCard runDetail={runDetail} />

            <RunHistoryCard
              workflow={workflow}
              activeRunId={activeRunId}
              onSelectRun={setSelectedRunId}
            />

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
                    <option value="paused">Paused</option>
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
  const canCancelRun = Boolean(
    runDetail && ["queued", "running", "awaiting_human"].includes(runDetail.status),
  );
  const cancelIsPending = cancellingRunId === runDetail?.id;
  const pipelineSummary = runDetail
    ? `Active run ${runDetail.status.replaceAll("_", " ")}`
    : `${workflow.pipelineDefinition.phases.length} inferred phases`;

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
        {phases.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
            The workflow analyzer has not produced any phases yet.
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
      </CardContent>
    </Card>
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
