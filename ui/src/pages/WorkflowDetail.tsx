import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import {
  Bot,
  Check,
  Download,
  LoaderCircle,
  Play,
  Repeat,
  Save,
  ShieldCheck,
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
import { RunTranscriptView, type TranscriptMode } from "../components/transcript/RunTranscriptView";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, formatFileSize, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type WorkflowEditDraft = {
  title: string;
  description: string;
  status: string;
  agentPath: string;
  cwd: string;
  command: string;
  model: string;
};

function toDraft(detail: WorkflowDetailType): WorkflowEditDraft {
  return {
    title: detail.title,
    description: detail.description ?? "",
    status: detail.status,
    agentPath: typeof detail.runnerConfig.agentPath === "string" ? detail.runnerConfig.agentPath : "",
    cwd: typeof detail.runnerConfig.cwd === "string" ? detail.runnerConfig.cwd : "",
    command: typeof detail.runnerConfig.command === "string" ? detail.runnerConfig.command : "",
    model: typeof detail.runnerConfig.model === "string" ? detail.runnerConfig.model : "",
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
const GRAPH_HUMAN_WIDTH = 320;
const GRAPH_DELIVERABLE_WIDTH = 220;
const GRAPH_COLUMN_GAP = 120;
const GRAPH_ROW_GAP = 28;
const GRAPH_PADDING_X = 28;
const GRAPH_PADDING_Y = 24;

function estimateGraphNodeHeight(kind: GraphNodeKind, handoff?: WorkflowHandoff | undefined) {
  if (kind === "start") return 76;
  if (kind === "terminal") return 92;
  if (kind === "deliverable") return 92;
  if (kind === "human") {
    const promptLength = handoff?.promptMarkdown.length ?? 0;
    const settledLength = handoff?.responseMarkdown?.length ?? 0;
    return Math.min(320, 180 + Math.ceil(promptLength / 80) * 18 + Math.ceil(settledLength / 120) * 14);
  }
  const descriptionLength = handoff ? 0 : 0;
  return 132 + descriptionLength;
}

function buildWorkflowGraph(
  phases: WorkflowPhase[],
  handoffsByPhase: Map<string, WorkflowHandoff[]>,
  runDetail: WorkflowRunDetail | null,
): WorkflowGraph {
  const childrenByParent = new Map<string | null, WorkflowPhase[]>();
  for (const phase of phases) {
    const parentKey = readPhaseMetaString(phase, "parentKey");
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(phase);
    childrenByParent.set(parentKey, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal);
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
    width: 160,
    height: estimateGraphNodeHeight("start"),
    status: runDetail?.status === "running" ? "running" : "idle",
  });

  const appendPhase = (phase: WorkflowPhase, incomingIds: string[]): string[] => {
    const phaseId = `phase:${phase.phaseKey}`;
    addNode({
      id: phaseId,
      kind: "phase",
      label: phase.label,
      level: 1,
      phase,
      width: GRAPH_NODE_WIDTH,
      height: estimateGraphNodeHeight("phase"),
      status: phase.status,
    });
    for (const incomingId of incomingIds) addEdge(incomingId, phaseId);

    let outputs = [phaseId];
    const handoffs = [...(handoffsByPhase.get(phase.phaseKey) ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    if (handoffs.length > 0) {
      let previousId = phaseId;
      for (const handoff of handoffs) {
        const handoffId = `handoff:${handoff.id}`;
        addNode({
          id: handoffId,
          kind: "human",
          label: handoff.kind === "approval" ? "Human approval" : "Human response",
          level: 1,
          handoff,
          width: GRAPH_HUMAN_WIDTH,
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

  const leafIds = roots.length > 0
    ? roots.flatMap((phase) => appendPhase(phase, ["graph:start"]))
    : ["graph:start"];

  addNode({
    id: "graph:terminal",
    kind: "terminal",
    label: runDetail ? "Terminal" : "Awaiting run",
    level: 1,
    width: 180,
    height: estimateGraphNodeHeight("terminal"),
    status: runDetail?.status ?? "idle",
  });
  for (const leafId of leafIds) addEdge(leafId, "graph:terminal");

  for (const deliverable of runDetail?.deliverables ?? []) {
    const deliverableId = `deliverable:${deliverable.id}`;
    addNode({
      id: deliverableId,
      kind: "deliverable",
      label: deliverable.title,
      level: 1,
      deliverable,
      width: GRAPH_DELIVERABLE_WIDTH,
      height: estimateGraphNodeHeight("deliverable"),
      status: "ready",
    });
    addEdge("graph:terminal", deliverableId);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const levelMemo = new Map<string, number>();
  const resolveLevel = (nodeId: string): number => {
    const memo = levelMemo.get(nodeId);
    if (memo != null) return memo;
    if (nodeId === "graph:start") {
      levelMemo.set(nodeId, 0);
      return 0;
    }
    let maxParentLevel = 0;
    for (const edge of edges) {
      if (edge.to !== nodeId) continue;
      maxParentLevel = Math.max(maxParentLevel, resolveLevel(edge.from) + 1);
    }
    levelMemo.set(nodeId, maxParentLevel);
    return maxParentLevel;
  };

  const orderedNodes = [...nodes.values()].sort((a, b) => {
    if (a.kind === "start") return -1;
    if (b.kind === "start") return 1;
    const phaseA = a.phase?.ordinal ?? Number.MAX_SAFE_INTEGER;
    const phaseB = b.phase?.ordinal ?? Number.MAX_SAFE_INTEGER;
    return phaseA - phaseB || a.id.localeCompare(b.id);
  });

  for (const node of orderedNodes) {
    node.level = resolveLevel(node.id);
  }

  const nodesByLevel = new Map<number, GraphNode[]>();
  for (const node of orderedNodes) {
    const list = nodesByLevel.get(node.level) ?? [];
    list.push(node);
    nodesByLevel.set(node.level, list);
  }

  let graphHeight = 0;
  const sortedLevels = [...nodesByLevel.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const levelNodes = nodesByLevel.get(level) ?? [];
    let cursorY = GRAPH_PADDING_Y;
    for (const node of levelNodes) {
      node.x = GRAPH_PADDING_X + level * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);
      if (node.kind === "human") {
        node.x = GRAPH_PADDING_X + level * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) - 16;
      } else if (node.kind === "start" || node.kind === "terminal") {
        node.x = GRAPH_PADDING_X + level * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) + 32;
      } else if (node.kind === "deliverable") {
        node.x = GRAPH_PADDING_X + level * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) + 12;
      }
      node.y = cursorY;
      cursorY += node.height + GRAPH_ROW_GAP;
    }
    graphHeight = Math.max(graphHeight, cursorY);
  }

  const graphWidth = GRAPH_PADDING_X * 2 + (Math.max(...sortedLevels, 0) + 1) * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);

  return {
    nodes: orderedNodes,
    edges,
    width: graphWidth,
    height: Math.max(420, graphHeight),
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
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

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
              response={node.handoff ? (handoffResponses[node.handoff.id] ?? "") : ""}
              onChangeResponse={(value) => {
                if (!node.handoff) return;
                setHandoffResponses((current) => ({ ...current, [node.handoff!.id]: value }));
              }}
              onApprove={() => node.handoff && onApprove(node.handoff.id)}
              onReject={() => node.handoff && onReject(node.handoff.id)}
              onRespond={() => node.handoff && onRespond(node.handoff.id)}
              pending={node.handoff ? pendingHandoffId === node.handoff.id : false}
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
  if (node.kind === "start") return <GraphStartNode status={node.status ?? "idle"} />;
  if (node.kind === "terminal") return <GraphTerminalNode status={node.status ?? "idle"} />;
  if (node.kind === "deliverable" && node.deliverable) return <GraphDeliverableNode node={node} />;
  return <GraphPhaseNode node={node} />;
}

function GraphStartNode({ status }: { status: string }) {
  return (
    <div className={cn(
      "rounded-full border px-5 py-4 shadow-sm",
      status === "running"
        ? "border-amber-500/60 bg-amber-500/10 animate-pulse"
        : "border-border bg-background/90",
    )}>
      <div className="flex items-center gap-3">
        <div className="rounded-full border border-border/70 bg-background/80 p-2">
          <Play className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Start</div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{status.replaceAll("_", " ")}</div>
        </div>
      </div>
    </div>
  );
}

function GraphTerminalNode({ status }: { status: string }) {
  const settled = status === "succeeded";
  const failed = status === "failed";
  return (
    <div className={cn(
      "rounded-3xl border p-4 shadow-sm",
      settled
        ? "border-emerald-500/45 bg-emerald-500/10"
        : failed
          ? "border-red-500/45 bg-red-500/10"
          : "border-border bg-background/90",
    )}>
      <div className="flex items-center gap-3">
        <div className={cn(
          "rounded-2xl border p-2",
          settled ? "border-emerald-500/50 bg-emerald-500/10" : failed ? "border-red-500/50 bg-red-500/10" : "border-border/70 bg-background/80",
        )}>
          <Check className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold">Terminal</div>
          <div className="text-xs text-muted-foreground">Run outcome and downstream artifacts</div>
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
          <div className="text-sm font-semibold text-foreground">Deliverable</div>
          <div className="mt-1 truncate text-sm text-foreground/90">{node.deliverable?.title}</div>
          <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-300">Artifact ready</div>
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
  const kindLabel = phase.kind === "loop"
    ? "Loop agent"
    : phase.kind === "validator"
      ? "Validator"
      : phase.kind === "tool"
        ? "Tool"
        : phase.kind === "agent"
          ? "Agent"
          : "Phase";
  const tone = phase.status === "running"
    ? "border-amber-500/60 bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.2)] animate-pulse"
    : phase.status === "succeeded"
      ? "border-emerald-500/40 bg-emerald-500/10"
      : phase.status === "failed"
        ? "border-red-500/40 bg-red-500/10"
        : phase.status === "awaiting_human"
          ? "border-sky-500/40 bg-sky-500/10"
          : "border-border bg-background/90";
  const Icon = phase.kind === "loop"
    ? Repeat
    : phase.kind === "tool"
      ? Wrench
      : phase.kind === "validator"
        ? ShieldCheck
        : Bot;

  return (
    <div className={cn("rounded-3xl border p-4 shadow-sm", tone)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-border/70 bg-background/80 p-2 text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <div className="text-sm font-semibold">{phase.label}</div>
            <div className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground inline-flex">
              {kindLabel}
            </div>
            {description ? <p className="pt-1 text-xs text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {phase.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
    <div className={cn(
      "rounded-3xl border p-4 shadow-sm",
      isPending ? "border-sky-500/55 bg-sky-500/10" : "border-border bg-background/90",
    )}>
      <div className="mb-3 flex items-center gap-3">
        <StickFigure />
        <div>
          <div className="text-sm font-semibold text-foreground">
            {handoff.kind === "approval" ? "Human approval" : "Human response"}
          </div>
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground">{handoff.status.replaceAll("_", " ")}</div>
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
            placeholder={handoff.kind === "approval" ? "Optional decision note" : "Write the human response"}
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            {handoff.kind === "approval" ? (
              <>
                <Button size="sm" onClick={onApprove} disabled={pending}>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={onReject} disabled={pending}>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Reject
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={onRespond} disabled={pending || response.trim().length === 0}>
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

function StickFigure() {
  return (
    <svg viewBox="0 0 48 48" className="h-10 w-10 text-foreground" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="24" cy="10" r="5" />
      <path d="M24 15v13" />
      <path d="M14 22l10 6 10-6" />
      <path d="M18 40l6-12 6 12" />
    </svg>
  );
}

export function WorkflowDetail() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [editDraft, setEditDraft] = useState<WorkflowEditDraft | null>(null);
  const [inputMarkdown, setInputMarkdown] = useState("");
  const [handoffResponses, setHandoffResponses] = useState<Record<string, string>>({});

  const workflowQuery = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId ?? ""),
    queryFn: () => workflowsApi.get(workflowId!),
    enabled: !!workflowId,
    refetchInterval: 5000,
  });

  const latestRunId = workflowQuery.data?.latestRun?.id ?? null;
  const runQuery = useQuery({
    queryKey: queryKeys.workflows.run(latestRunId ?? ""),
    queryFn: () => workflowsApi.getRun(latestRunId!),
    enabled: !!latestRunId,
    refetchInterval: (query) => {
      const run = query.state.data as WorkflowRunDetail | undefined;
      return run && ["queued", "running", "awaiting_human"].includes(run.status) ? 3000 : false;
    },
  });

  const activityQuery = useQuery({
    queryKey: [
      ...queryKeys.workflows.activity(selectedCompanyId ?? "", workflowId ?? ""),
      workflowQuery.data?.runs.map((run) => run.id).join(",") ?? "",
      runQuery.data?.handoffs.map((handoff) => handoff.id).join(",") ?? "",
    ],
    queryFn: () => workflowsApi.activity(selectedCompanyId!, workflowId!, {
      runIds: workflowQuery.data?.runs.map((run) => run.id) ?? [],
      handoffIds: runQuery.data?.handoffs.map((handoff) => handoff.id) ?? [],
    }),
    enabled: !!selectedCompanyId && !!workflowId,
    refetchInterval: runQuery.data && ["queued", "running", "awaiting_human"].includes(runQuery.data.status) ? 4000 : false,
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

  const refreshAll = async () => {
    if (!workflowId || !selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflowId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId) }),
      latestRunId ? queryClient.invalidateQueries({ queryKey: queryKeys.workflows.run(latestRunId) }) : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.list(selectedCompanyId) }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: () => workflowsApi.update(workflowId!, {
      title: editDraft!.title.trim(),
      description: editDraft!.description.trim() || null,
      status: editDraft!.status,
      runnerConfig: {
        agentPath: editDraft!.agentPath.trim(),
        ...(editDraft!.cwd.trim() ? { cwd: editDraft!.cwd.trim() } : {}),
        ...(editDraft!.command.trim() ? { command: editDraft!.command.trim() } : {}),
        ...(editDraft!.model.trim() ? { model: editDraft!.model.trim() } : {}),
      },
    }),
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
    mutationFn: () => workflowsApi.run(workflowId!, { inputMarkdown: inputMarkdown.trim() }),
    onSuccess: async () => {
      setInputMarkdown("");
      await refreshAll();
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

  const approveMutation = useMutation({
    mutationFn: (handoffId: string) => workflowsApi.approveHandoff(handoffId, {
      responseMarkdown: handoffResponses[handoffId]?.trim() || null,
    }),
    onSuccess: refreshAll,
  });
  const rejectMutation = useMutation({
    mutationFn: (handoffId: string) => workflowsApi.rejectHandoff(handoffId, {
      responseMarkdown: handoffResponses[handoffId]?.trim() || null,
    }),
    onSuccess: refreshAll,
  });
  const respondMutation = useMutation({
    mutationFn: (handoffId: string) => workflowsApi.respondHandoff(handoffId, {
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
  const runDetail = runQuery.data ?? null;
  const pipelinePhases = runDetail?.phases.length
    ? runDetail.phases
    : workflow.pipelineDefinition.phases.map((phase) => ({
        id: phase.key,
        companyId: workflow.companyId,
        workflowRunId: workflow.latestRun?.id ?? "definition",
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
      } satisfies WorkflowPhase));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{workflow.title}</h1>
          <p className="text-sm text-muted-foreground">
            Google ADK workflow with an inferred read-only pipeline and workflow-backed deliverables.
          </p>
        </div>
        {workflow.latestDeliverable ? (
          <Button asChild variant="outline">
            <Link to={`/deliverables/${workflow.latestDeliverable.id}`}>
              <Download className="mr-1.5 h-4 w-4" />
              Latest deliverable
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="space-y-6">
        <PipelineCard
          workflow={workflow}
          runDetail={runDetail}
          phases={pipelinePhases}
          handoffResponses={handoffResponses}
          setHandoffResponses={setHandoffResponses}
          onApprove={(handoffId) => approveMutation.mutate(handoffId)}
          onReject={(handoffId) => rejectMutation.mutate(handoffId)}
          onRespond={(handoffId) => respondMutation.mutate(handoffId)}
          pendingHandoffId={
            approveMutation.variables
            ?? rejectMutation.variables
            ?? respondMutation.variables
            ?? null
          }
        />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Run workflow</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={inputMarkdown}
                  onChange={(event) => setInputMarkdown(event.target.value)}
                  placeholder="Provide the markdown input that should seed this workflow run."
                  rows={8}
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => runMutation.mutate()}
                    disabled={runMutation.isPending || inputMarkdown.trim().length === 0}
                  >
                    {runMutation.isPending ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                    Run workflow
                  </Button>
                </div>
              </CardContent>
            </Card>

            <WorkflowRunConsoleCard runDetail={runDetail} />

            <RunHistoryCard workflow={workflow} runDetail={runDetail} />

            <ActivityCard events={activityQuery.data ?? []} loading={activityQuery.isLoading} />
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workflow settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    value={editDraft.title}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, title: event.target.value } : current)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={editDraft.description}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, description: event.target.value } : current)}
                    rows={4}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <select
                    value={editDraft.status}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, status: event.target.value } : current)}
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
                    onChange={(event) => setEditDraft((current) => current ? { ...current, agentPath: event.target.value } : current)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Working directory</Label>
                  <Input
                    value={editDraft.cwd}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, cwd: event.target.value } : current)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Command override</Label>
                  <Input
                    value={editDraft.command}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, command: event.target.value } : current)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Input
                    value={editDraft.model}
                    onChange={(event) => setEditDraft((current) => current ? { ...current, model: event.target.value } : current)}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending || !editDraft.title.trim() || !editDraft.agentPath.trim()}
                  >
                    <Save className="mr-1.5 h-4 w-4" />
                    Save workflow
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Latest deliverables</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {runDetail?.deliverables.length ? runDetail.deliverables.map((deliverable) => (
                  <Link
                    key={deliverable.id}
                    to={`/deliverables/${deliverable.id}`}
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm no-underline transition-colors hover:bg-muted/40"
                  >
                    <span className="truncate">{deliverable.title}</span>
                    <span className="text-xs text-muted-foreground">{formatFileSize(deliverable.byteSize)}</span>
                  </Link>
                )) : (
                  <div className="text-sm text-muted-foreground">No deliverables yet.</div>
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

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Pipeline</CardTitle>
          <div className="text-sm text-muted-foreground">
            {runDetail
              ? `Latest run ${runDetail.status.replaceAll("_", " ")}`
              : `${workflow.pipelineDefinition.phases.length} inferred phases`}
          </div>
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

function WorkflowRunConsoleCard({ runDetail }: { runDetail: WorkflowRunDetail | null }) {
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");

  useEffect(() => {
    setTranscriptMode("nice");
  }, [runDetail?.id]);

  const consoleEntries = runDetail?.consoleEntries ?? [];
  const transcript = useMemo(
    () => buildTranscript(consoleEntries as WorkflowRunConsoleChunk[], getUIAdapter("google_adk")),
    [consoleEntries],
  );

  if (!runDetail) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operator console</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Run a workflow to inspect stdout and stderr here.</div>
        </CardContent>
      </Card>
    );
  }

  const isLive = ["queued", "running", "awaiting_human"].includes(runDetail.status);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
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
        <div className="rounded-2xl border border-border/70 bg-background/40 p-3 sm:p-4">
          <RunTranscriptView
            entries={transcript}
            mode={transcriptMode}
            streaming={isLive}
            emptyMessage="No workflow console output yet."
          />
        </div>

        {(runDetail.error || runDetail.stderrExcerpt || runDetail.resultJson) ? (
          <div className="space-y-3 rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-red-700 dark:text-red-300">
              Failure details
            </div>
            {runDetail.error ? (
              <div className="text-sm text-red-700 dark:text-red-200">{runDetail.error}</div>
            ) : null}
            {runDetail.stderrExcerpt ? (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-background/80 p-3 text-xs text-red-700 dark:text-red-200">
                {runDetail.stderrExcerpt}
              </pre>
            ) : null}
            {runDetail.resultJson ? (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-background/80 p-3 text-xs text-foreground">
                {JSON.stringify(runDetail.resultJson, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RunHistoryCard({
  workflow,
  runDetail,
}: {
  workflow: WorkflowDetailType;
  runDetail: WorkflowRunDetail | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Run history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {workflow.runs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No runs yet.</div>
        ) : (
          workflow.runs.map((run) => {
            const isLatest = runDetail?.id === run.id;
            return (
              <div key={run.id} className={`rounded-xl border p-3 ${isLatest ? "border-amber-500/40 bg-amber-500/5" : "border-border"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">{run.status.replaceAll("_", " ")}</div>
                  <div className="text-xs text-muted-foreground" title={formatDateTime(run.createdAt)}>
                    {relativeTime(run.createdAt)}
                  </div>
                </div>
                {run.summary ? (
                  <p className="mt-2 text-sm text-muted-foreground line-clamp-3">{run.summary}</p>
                ) : null}
                <div className="mt-2 text-xs text-muted-foreground">
                  {run.startedAt ? `Started ${formatDateTime(run.startedAt)}` : "Queued"}
                  {run.finishedAt ? ` · Finished ${formatDateTime(run.finishedAt)}` : ""}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ActivityCard({ events, loading }: { events: ActivityEvent[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading activity…</div>
        ) : events.length === 0 ? (
          <div className="text-sm text-muted-foreground">No workflow activity yet.</div>
        ) : (
          events.slice(0, 12).map((event) => (
            <div key={event.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{event.action.replaceAll(".", " ")}</div>
                <div className="text-xs text-muted-foreground" title={formatDateTime(event.createdAt)}>
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
