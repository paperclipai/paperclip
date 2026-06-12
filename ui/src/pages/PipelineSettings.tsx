import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupWarningsByStage,
  isPipelineTerminalStageKind,
  syncRoutineVariablesWithTemplate,
  type RoutineVariable,
} from "@paperclipai/shared";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Archive,
  BadgeCheck,
  Ban,
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  GitBranch,
  Hammer,
  History as HistoryIcon,
  Hexagon,
  KeyRound,
  LayoutGrid,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import type { PipelineCompanyCaseEvent, PipelineDetail, PipelineStage, PipelineTransitionEdge } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { PipelineStageHistoryPanel } from "../components/PipelineStageHistoryPanel";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { buildCompanyUserInlineOptions, buildMarkdownMentionOptions, isAgentTaskTarget } from "../lib/company-members";
import { formatPipelineItemEvent } from "../lib/pipeline-item-detail";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency } from "../lib/recent-assignees";
import { cn, relativeTime } from "../lib/utils";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { StageHealthWarnings } from "../components/PipelineHealthWarnings";

type StageSectionKey = "overview" | "instructions" | "advanced" | "secrets" | "runs" | "activity" | "history";
type ApproverKind = "any_human" | "user" | "agent";
type EditableStageKind = "working" | "review" | "done" | "cancelled";

type StageConfig = {
  // Stage instruction variables are stored in the routine variable shape
  // (`{ name, label, type, defaultValue, required, options }`) and kept in sync
  // with the instructions body. Legacy entries used `{ key, ... }`; both are
  // read through `toRoutineVariables`.
  variables?: unknown[];
  disabled?: boolean;
  disabledReason?: string | null;
  automation?: {
    assigneeAgentId?: string | null;
    instructionsBody?: string | null;
  };
  requireApproval?: boolean;
  approver?: {
    kind?: ApproverKind;
    id?: string | null;
  };
  reviewerKind?: string;
  whatHappensHere?: string;
  approveToStageKey?: string;
  rejectToStageKey?: string;
  requestChangesToStageKey?: string;
  requireRejectReason?: boolean;
  requireChildrenTerminal?: boolean;
  autoAdvanceOnChildrenTerminal?: string;
  [key: string]: unknown;
};

const STAGE_NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: StageSectionKey; label: string; icon: typeof Circle }>;
}> = [
  {
    label: "Stage",
    items: [
      { id: "overview", label: "Overview", icon: Circle },
      { id: "instructions", label: "Automation", icon: LayoutGrid },
      { id: "secrets", label: "Secrets", icon: KeyRound },
      { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Operate",
    items: [
      { id: "runs", label: "Runs", icon: Play },
      { id: "activity", label: "Activity", icon: ActivityIcon },
      { id: "history", label: "History", icon: HistoryIcon },
    ],
  },
];

const STAGE_SECTION_TITLES: Record<StageSectionKey, string> = {
  overview: "Overview",
  instructions: "Automation",
  secrets: "Secrets",
  runs: "Runs",
  activity: "Activity",
  history: "History",
  advanced: "Advanced",
};

const STAGE_KIND_OPTIONS: Array<{
  value: EditableStageKind;
  label: string;
  description: string;
  icon: typeof Circle;
}> = [
  {
    value: "working",
    label: "Working",
    description: "Items wait here while work happens. An agent or a person moves them forward.",
    icon: Hammer,
  },
  {
    value: "review",
    label: "Review",
    description: "Someone has to approve before items leave. Use this when a person or an agent has to say yes or no.",
    icon: BadgeCheck,
  },
  {
    value: "done",
    label: "Done",
    description: "The final step. Items that reach here are finished.",
    icon: CircleCheck,
  },
  {
    value: "cancelled",
    label: "Cancelled",
    description: "The dead end. Items that reach here are dropped or rejected.",
    icon: Ban,
  },
];

/** Per-stage instructions document key — keyed by stage id so it survives renames. */
function stageInstructionsKey(stageId: string) {
  return `stage-instructions:${stageId}`;
}

const ROUTINE_VARIABLE_TYPES: ReadonlySet<RoutineVariable["type"]> = new Set([
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
]);

/**
 * Read stage `config.variables` into the routine variable shape, tolerating
 * both the current shape (`{ name, ... }`) and the legacy pipeline shape
 * (`{ key, type: text|multiline|select, showInAddForm }`).
 */
function toRoutineVariables(raw: unknown): RoutineVariable[] {
  if (!Array.isArray(raw)) return [];
  const result: RoutineVariable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : typeof record.key === "string" && record.key.trim()
        ? record.key.trim()
        : null;
    if (!name) continue;
    const rawType = typeof record.type === "string" ? record.type : "text";
    const type: RoutineVariable["type"] = ROUTINE_VARIABLE_TYPES.has(rawType as RoutineVariable["type"])
      ? (rawType as RoutineVariable["type"])
      : rawType === "multiline"
        ? "textarea"
        : "text";
    const options = Array.isArray(record.options)
      ? record.options.filter((option): option is string => typeof option === "string")
      : [];
    const defaultValue = record.defaultValue as RoutineVariable["defaultValue"];
    result.push({
      name,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : null,
      type,
      defaultValue:
        defaultValue === undefined ||
        (typeof defaultValue !== "string" && typeof defaultValue !== "number" && typeof defaultValue !== "boolean")
          ? null
          : defaultValue,
      required: record.required === true,
      options,
    });
  }
  return result;
}

function stageConfig(stage: PipelineStage | null | undefined): StageConfig {
  const config = stage?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { variables: [] };
  }
  return config as StageConfig;
}

function stageAutomation(stage: PipelineStage | null | undefined) {
  const automation = stageConfig(stage).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) {
    return { assigneeAgentId: "", instructionsBody: null as string | null };
  }
  return {
    assigneeAgentId: typeof automation.assigneeAgentId === "string" ? automation.assigneeAgentId : "",
    instructionsBody: typeof automation.instructionsBody === "string" ? automation.instructionsBody : null,
  };
}

function stageNewEntriesDisabled(stage: PipelineStage | null | undefined) {
  return stageConfig(stage).disabled === true;
}

/**
 * The saved variable baseline. Variables are body-driven, so the saved value is
 * the synced result of the saved instructions body against the saved config
 * variables — matching what `RoutineVariablesEditor` produces on first load.
 */
function savedStageVariables(stage: PipelineStage | null | undefined, savedBody: string): RoutineVariable[] {
  return syncRoutineVariablesWithTemplate(["", savedBody], toRoutineVariables(stageConfig(stage).variables));
}

type StageFormValues = {
  name: string;
  kind: string;
  newEntriesDisabled: boolean;
  disableReason: string;
  assigneeAgentId: string;
  approvalRequired: boolean;
  approval: string;
  approveTarget: string;
  rejectTarget: string;
  requestChangesTarget: string;
  requireRejectReason: boolean;
  requireChildrenTerminal: boolean;
  autoAdvanceOnChildrenTerminal: string;
  transitionTargetIds: string[];
};

type PipelineTransitionRecord = { fromStageId: string; toStageId: string; label?: string | null };

function computeStageForm(
  stage: PipelineStage,
  transitions: PipelineTransitionRecord[],
): StageFormValues {
  const config = stageConfig(stage);
  const automation = stageAutomation(stage);
  return {
    name: stage.name,
    kind: canonicalStageKind(stage.kind),
    newEntriesDisabled: stageNewEntriesDisabled(stage),
    disableReason: config.disabledReason ?? "",
    assigneeAgentId: automation.assigneeAgentId,
    approvalRequired: Boolean(config.requireApproval),
    approval: approvalValue(config),
    approveTarget: config.approveToStageKey ?? "",
    rejectTarget: config.rejectToStageKey ?? "",
    requestChangesTarget: config.requestChangesToStageKey ?? "",
    requireRejectReason: config.requireRejectReason ?? true,
    requireChildrenTerminal: config.requireChildrenTerminal === true,
    autoAdvanceOnChildrenTerminal:
      typeof config.autoAdvanceOnChildrenTerminal === "string" ? config.autoAdvanceOnChildrenTerminal : "",
    transitionTargetIds: transitions
      .filter((transition) => transition.fromStageId === stage.id)
      .map((transition) => transition.toStageId)
      .sort(),
  };
}

function approvalValue(config: StageConfig) {
  const approver = config.approver;
  if (!approver || !approver.kind || approver.kind === "any_human") {
    return "any_human";
  }
  if ((approver.kind === "user" || approver.kind === "agent") && approver.id) {
    return `${approver.kind}:${approver.id}`;
  }
  return "any_human";
}

function parseApprovalValue(value: string): { kind: ApproverKind; id: string | null } {
  if (value === "any_human") {
    return { kind: "any_human", id: null };
  }
  const [kind, id] = value.split(":", 2);
  if ((kind === "user" || kind === "agent") && id) {
    return { kind, id };
  }
  return { kind: "any_human", id: null };
}

export function stageKeyFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug || "stage";
}

function nextStageKey(name: string, existingKeys: Set<string>) {
  const base = stageKeyFromName(name);
  if (!existingKeys.has(base)) return base;
  return `${base}_${Date.now().toString(36)}`;
}

function sortedStages(pipeline: PipelineDetail | null | undefined) {
  return [...(pipeline?.stages ?? [])].sort((left, right) => left.position - right.position);
}

function canonicalStageKind(kind: string | null | undefined): EditableStageKind {
  if (kind === "review" || kind === "done" || kind === "cancelled") return kind;
  return "working";
}

function nextStageByPosition(stages: PipelineStage[], stage: PipelineStage | null | undefined) {
  if (!stage) return null;
  return stages.find((candidate) => candidate.id !== stage.id && candidate.position > stage.position) ?? null;
}

function nextStageForInsert(stages: PipelineStage[], position: number) {
  return stages.find((stage) => stage.position >= position) ?? null;
}

function stageNavGroups(kind: string): typeof STAGE_NAV_GROUPS {
  if (!isPipelineTerminalStageKind(kind)) return STAGE_NAV_GROUPS;
  return STAGE_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== "instructions" && item.id !== "advanced"),
  })).filter((group) => group.items.length > 0);
}

function defaultReviewTarget(stages: PipelineStage[], selectedStageId: string | null, kind: string) {
  const match = stages.find((stage) => stage.kind === kind && stage.id !== selectedStageId);
  if (match) return match.key;
  const fallback = stages.find((stage) => stage.id !== selectedStageId);
  return fallback?.key ?? "";
}

function dedupeEdges(edges: PipelineTransitionEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (edge.fromStageKey === edge.toStageKey) return false;
    const key = `${edge.fromStageKey}:${edge.toStageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stageAssigneeOptionId(agentId: string | null | undefined) {
  return agentId ? `agent:${agentId}` : "";
}

function stageAssigneeIdFromOption(value: string) {
  return value.startsWith("agent:") ? value.slice("agent:".length) : "";
}

function approverValueFromOption(value: string) {
  return value || "any_human";
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
      <div className="font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StageSubSidebar({
  activeSection,
  stageKind,
  onSectionChange,
}: {
  activeSection: StageSectionKey;
  stageKind: string;
  onSectionChange: (section: StageSectionKey) => void;
}) {
  const groups = stageNavGroups(stageKind);
  return (
    <>
      <div className="md:hidden">
        <label className="sr-only" htmlFor="stage-section-picker">Stage section</label>
        <select
          id="stage-section-picker"
          value={activeSection}
          onChange={(event) => onSectionChange(event.target.value as StageSectionKey)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <nav
        aria-label="Stage sections"
        className="sticky top-14 hidden max-h-[calc(100dvh-3.5rem)] w-52 shrink-0 flex-col gap-4 self-start overflow-y-auto border-r border-border bg-sidebar/30 px-3 py-4 md:flex"
      >
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSectionChange(item.id)}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-3 text-left text-sm transition-colors motion-safe:duration-150",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}

function StageEventsList({
  events,
  stages,
  emptyMessage,
}: {
  events: PipelineCompanyCaseEvent[];
  stages: PipelineStage[];
  emptyMessage: string;
}) {
  if (events.length === 0) {
    return <EmptyState icon={ActivityIcon} message={emptyMessage} />;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {events.map((event) => (
        <div
          key={event.id}
          className="grid min-h-11 grid-cols-[6rem_1fr] items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-b-0"
        >
          <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
            {relativeTime(event.createdAt)}
          </span>
          <div className="min-w-0">
            <Link
              to={`/pipelines/${event.pipeline.id}/items/${event.caseId}`}
              className="font-medium text-foreground hover:underline"
            >
              {event.case.title}
            </Link>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatPipelineItemEvent(event, stages)}
              {event.actorAgent ? ` by ${event.actorAgent.name}` : null}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PipelineSettings() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [activeStageSection, setActiveStageSection] = useState<StageSectionKey>("overview");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageKind, setStageKind] = useState("open");
  const [newEntriesDisabled, setNewEntriesDisabled] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [stageAssigneeAgentId, setStageAssigneeAgentId] = useState("");
  const [selectedApproval, setSelectedApproval] = useState("any_human");
  const [instructionsBody, setInstructionsBody] = useState("");
  const [instructionsVariables, setInstructionsVariables] = useState<RoutineVariable[]>([]);
  const [approveTarget, setApproveTarget] = useState("");
  const [rejectTarget, setRejectTarget] = useState("");
  const [requestChangesTarget, setRequestChangesTarget] = useState("");
  const [requireRejectReason, setRequireRejectReason] = useState(true);
  const [requireChildrenTerminal, setRequireChildrenTerminal] = useState(false);
  const [autoAdvanceOnChildrenTerminal, setAutoAdvanceOnChildrenTerminal] = useState("");
  const [transitionTargets, setTransitionTargets] = useState<Set<string>>(() => new Set());
  const [deleteStageDialogOpen, setDeleteStageDialogOpen] = useState(false);
  const [deleteMoveTargetStageId, setDeleteMoveTargetStageId] = useState("");
  const [pipelineName, setPipelineName] = useState("");
  const [pipelineDescription, setPipelineDescription] = useState("");
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const healthQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.health(pipelineId) : ["pipelines", "health", "none"],
    queryFn: () => pipelinesApi.getHealth(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const usersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.companyUserDirectory(selectedCompanyId) : ["access", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(() => sortedStages(pipeline), [pipeline]);
  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0] ?? null;

  const instructionsKey = selectedStage ? stageInstructionsKey(selectedStage.id) : null;
  const instructionsQuery = useQuery({
    queryKey: pipelineId && instructionsKey
      ? queryKeys.pipelines.document(pipelineId, instructionsKey)
      : ["pipelines", "document", "none-stage"],
    queryFn: async () => {
      try {
        return await pipelinesApi.getDocument(pipelineId!, instructionsKey!);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!pipelineId && !!instructionsKey && !!selectedCompanyId,
  });
  const instructionsDocument = instructionsQuery.data ?? null;
  // Routine-backed automation is the source of truth. Per-stage documents and
  // the legacy field remain as read-through fallbacks for older stages.
  const savedInstructionsBody = instructionsDocument
    ? stageAutomation(selectedStage).instructionsBody ?? instructionsDocument.revision?.body ?? instructionsDocument.document?.latestBody ?? ""
    : stageAutomation(selectedStage).instructionsBody ?? stageConfig(selectedStage).whatHappensHere ?? "";
  const savedInstructionsVariables = useMemo(
    () => savedStageVariables(selectedStage, savedInstructionsBody),
    [selectedStage, savedInstructionsBody],
  );

  const mentionOptions = useMemo(
    () => buildMarkdownMentionOptions({ agents: agentsQuery.data, members: usersQuery.data?.users }),
    [agentsQuery.data, usersQuery.data?.users],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), []);
  const recentAssigneeOptionIds = useMemo(
    () => recentAssigneeIds.map(stageAssigneeOptionId),
    [recentAssigneeIds],
  );
  const stageAssigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agentsQuery.data ?? []).filter(isAgentTaskTarget),
        recentAssigneeIds,
      ).map((agent) => ({
        id: stageAssigneeOptionId(agent.id),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agentsQuery.data, recentAssigneeIds],
  );
  const approvalOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...buildCompanyUserInlineOptions(usersQuery.data?.users),
      ...sortAgentsByRecency(
        (agentsQuery.data ?? []).filter(isAgentTaskTarget),
        recentAssigneeIds,
      ).map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agentsQuery.data, recentAssigneeIds, usersQuery.data?.users],
  );
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
  );
  const healthWarningsByStage = useMemo(
    () => groupWarningsByStage(healthQuery.data?.warnings ?? []),
    [healthQuery.data?.warnings],
  );

  const stageEventsQuery = useQuery({
    queryKey: selectedCompanyId && pipelineId && selectedStage
      ? ["pipelines", "stage-events", selectedCompanyId, pipelineId, selectedStage.id]
      : ["pipelines", "stage-events", "none"],
    queryFn: () => pipelinesApi.listCompanyCaseEvents(selectedCompanyId!, { limit: 75 }),
    enabled:
      !!selectedCompanyId &&
      !!pipelineId &&
      !!selectedStage &&
      (activeStageSection === "runs" || activeStageSection === "activity"),
  });

  const stageEvents = useMemo(() => {
    if (!selectedStage || !pipelineId) return [];
    return (stageEventsQuery.data?.items ?? []).filter(
      (event) =>
        event.pipeline.id === pipelineId &&
        (event.fromStageId === selectedStage.id || event.toStageId === selectedStage.id),
    );
  }, [pipelineId, selectedStage, stageEventsQuery.data?.items]);

  const stageRunEvents = useMemo(
    () => stageEvents.filter((event) => Boolean(event.runId || event.actorAgent)),
    [stageEvents],
  );

  useEffect(() => {
    if (!pipeline) return;
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
      { label: "Settings" },
    ]);
  }, [pipeline, setBreadcrumbs]);

  // Deep-link from a board-header health warning: ?stage=<id> preselects the
  // flagged stage so the warning's "fix" lands on the right panel.
  const requestedStageId = searchParams.get("stage");
  useEffect(() => {
    if (requestedStageId && stages.some((stage) => stage.id === requestedStageId)) {
      setSelectedStageId(requestedStageId);
    }
  }, [requestedStageId, stages]);

  useEffect(() => {
    if (!selectedStageId && stages[0]) {
      setSelectedStageId(stages[0].id);
    }
  }, [selectedStageId, stages]);

  useEffect(() => {
    if (!selectedStage) return;
    setActiveStageSection("overview");
    const form = computeStageForm(selectedStage, pipeline?.transitions ?? []);
    setStageName(form.name);
    setStageKind(form.kind);
    setNewEntriesDisabled(form.newEntriesDisabled);
    setDisableReason(form.disableReason);
    setStageAssigneeAgentId(form.assigneeAgentId);
    setSelectedApproval(form.approval);
    setApproveTarget(form.approveTarget);
    setRejectTarget(form.rejectTarget);
    setRequestChangesTarget(form.requestChangesTarget);
    setRequireRejectReason(form.requireRejectReason);
    setRequireChildrenTerminal(form.requireChildrenTerminal);
    setAutoAdvanceOnChildrenTerminal(form.autoAdvanceOnChildrenTerminal);
    setTransitionTargets(new Set(form.transitionTargetIds));
  }, [pipeline?.transitions, selectedStage]);

  // Instructions body + variables hydrate from the per-stage document (or the
  // legacy field). Resetting on the saved value clears dirty after save/reload.
  useEffect(() => {
    setInstructionsBody(savedInstructionsBody);
    setInstructionsVariables(savedInstructionsVariables);
  }, [selectedStage?.id, savedInstructionsBody, savedInstructionsVariables]);

  useEffect(() => {
    setDeleteStageDialogOpen(false);
    setDeleteMoveTargetStageId(stages.find((stage) => stage.id !== selectedStage?.id)?.id ?? "");
  }, [selectedStage?.id, stages]);

  useEffect(() => {
    if (!pipeline) return;
    setPipelineName(pipeline.name);
    setPipelineDescription(pipeline.description ?? "");
  }, [pipeline]);

  const refreshPipeline = async () => {
    if (!pipelineId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.health(pipelineId) });
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage || !pipeline) return null;
      const parsedApproval = parseApprovalValue(selectedApproval);
      const nextRequiresApproval = stageKind === "review";
      const config: StageConfig = {
        ...stageConfig(selectedStage),
        variables: instructionsVariables,
        disabled: newEntriesDisabled,
        disabledReason: newEntriesDisabled ? disableReason.trim() || null : null,
        automation: {
          assigneeAgentId: stageAssigneeAgentId || null,
          instructionsBody,
        },
        requireApproval: nextRequiresApproval,
        approver: nextRequiresApproval && parsedApproval.kind !== "any_human"
          ? { kind: parsedApproval.kind, id: parsedApproval.id }
          : { kind: "any_human" },
        requireChildrenTerminal,
      };
      if (autoAdvanceOnChildrenTerminal) {
        config.autoAdvanceOnChildrenTerminal = autoAdvanceOnChildrenTerminal;
      } else {
        delete config.autoAdvanceOnChildrenTerminal;
      }
      // The approval model replaces the legacy reviewerKind input.
      delete config.reviewerKind;
      if (stageKind === "review") {
        config.approveToStageKey = approveTarget;
        config.rejectToStageKey = rejectTarget;
        if (requestChangesTarget) {
          config.requestChangesToStageKey = requestChangesTarget;
        } else {
          delete config.requestChangesToStageKey;
        }
        config.requireRejectReason = requireRejectReason;
      }

      const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
      const existingTransitions = pipeline.transitions ?? [];
      const retainedEdges = existingTransitions
        .filter((transition) => transition.fromStageId !== selectedStage.id)
        .flatMap((transition) => {
          const fromStageKey = keyById.get(transition.fromStageId);
          const toStageKey = keyById.get(transition.toStageId);
          if (!fromStageKey || !toStageKey) return [];
          return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
        });
      // Effective "allowed next steps". For review stages the connections are
      // kept in sync with the review outcomes (approve / decline / changes)
      // instead of a separate picker. Every stage can always move to a
      // cancelled stage by default.
      const keyToId = new Map(stages.map((stage) => [stage.key, stage.id]));
      const effectiveTargetIds = new Set<string>(
        stageKind === "review"
          ? [approveTarget, rejectTarget, requestChangesTarget]
              .map((key) => keyToId.get(key))
              .filter((id): id is string => Boolean(id))
          : transitionTargets,
      );
      for (const stage of stages) {
        if (stage.kind === "cancelled" && stage.id !== selectedStage.id) {
          effectiveTargetIds.add(stage.id);
        }
      }
      const selectedEdges = [...effectiveTargetIds].flatMap((targetId) => {
        const toStageKey = keyById.get(targetId);
        if (!toStageKey) return [];
        const prior = existingTransitions.find(
          (transition) => transition.fromStageId === selectedStage.id && transition.toStageId === targetId,
        );
        return [{ fromStageKey: selectedStage.key, toStageKey, label: prior?.label ?? null }];
      });

      await pipelinesApi.updateStage(pipelineId, selectedStage.id, {
        name: stageName.trim(),
        kind: stageKind,
        config,
      });
      await pipelinesApi.setTransitions(pipelineId, {
        transitions: dedupeEdges([...retainedEdges, ...selectedEdges]),
      });
      return null;
    },
    onSuccess: async () => {
      if (pipelineId && instructionsKey) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.document(pipelineId, instructionsKey) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.documentRevisions(pipelineId, instructionsKey) }),
        ]);
      }
      await refreshPipeline();
      pushToast({ title: "Stage saved", tone: "success" });
    },
    onError: async (error) => {
      pushToast({
        title: "Failed to save stage",
        body: error instanceof Error ? error.message : "Paperclip could not save the stage.",
        tone: "error",
      });
    },
  });

  const addStage = useMutation({
    mutationFn: async (afterStage: PipelineStage | null) => {
      if (!pipelineId || !pipeline) return null;
      const lastStage = stages[stages.length - 1] ?? null;
      const insertPosition = afterStage ? afterStage.position + 1 : (lastStage ? lastStage.position + 100 : 100);
      const nextStage = afterStage
        ? stages.find((stage) => stage.position > afterStage.position) ?? null
        : null;
      const existingKeys = new Set(stages.map((stage) => stage.key));
      const autoAdvanceTarget = nextStageForInsert(stages, insertPosition);
      const created = await pipelinesApi.createStage(pipelineId, {
        key: nextStageKey("New stage", existingKeys),
        name: "New stage",
        kind: "working",
        position: insertPosition,
        config: {
          variables: [],
          requireChildrenTerminal: true,
          ...(autoAdvanceTarget ? { autoAdvanceOnChildrenTerminal: autoAdvanceTarget.key } : {}),
        },
      });
      if (afterStage) {
        const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
        const existingTransitions = pipeline.transitions ?? [];
        const edges = existingTransitions
          .filter(
            (transition) => !(nextStage && transition.fromStageId === afterStage.id && transition.toStageId === nextStage.id),
          )
          .flatMap((transition) => {
            const fromStageKey = keyById.get(transition.fromStageId);
            const toStageKey = keyById.get(transition.toStageId);
            if (!fromStageKey || !toStageKey) return [];
            return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
          });
        edges.push({ fromStageKey: afterStage.key, toStageKey: created.key, label: null });
        if (nextStage) {
          edges.push({ fromStageKey: created.key, toStageKey: nextStage.key, label: null });
        }
        await pipelinesApi.setTransitions(pipelineId, { transitions: dedupeEdges(edges) });
      }
      return created;
    },
    onSuccess: async (created) => {
      await refreshPipeline();
      if (created) {
        setSelectedStageId(created.id);
      }
      pushToast({ title: "Stage added", tone: "success" });
    },
  });

  const deleteStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage) return null;
      return pipelinesApi.deleteStage(pipelineId, selectedStage.id, {
        moveCasesToStageId: deleteMoveTargetStageId || null,
      });
    },
    onSuccess: async () => {
      const nextStageId = deleteMoveTargetStageId || (stages.find((stage) => stage.id !== selectedStage?.id)?.id ?? null);
      setDeleteStageDialogOpen(false);
      setSelectedStageId(nextStageId);
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      pushToast({ title: "Stage deleted", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete stage",
        body: error instanceof Error ? error.message : "Paperclip could not delete the stage.",
        tone: "error",
      });
    },
  });

  const savePipelineDetails = useMutation({
    mutationFn: () =>
      pipelinesApi.update(pipelineId!, {
        name: pipelineName.trim(),
        description: pipelineDescription.trim() || null,
      }),
    onSuccess: async () => {
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      pushToast({ title: "Pipeline updated", tone: "success" });
    },
  });

  const archivePipeline = useMutation({
    mutationFn: (archived: boolean) => pipelinesApi.update(pipelineId!, { archived }),
    onSuccess: async (_result, archived) => {
      setArchiveDialogOpen(false);
      setArchiveConfirmation("");
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      if (archived) {
        navigate("/pipelines");
      } else {
        await refreshPipeline();
        pushToast({ title: "Pipeline restored", tone: "success" });
      }
    },
  });

  const setStageKindWithDefaults = (kind: string) => {
    setStageKind(kind);
    if (isPipelineTerminalStageKind(kind) && (activeStageSection === "instructions" || activeStageSection === "advanced")) {
      setActiveStageSection("overview");
    }
    if (kind === "review") {
      setApproveTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "done"));
      setRejectTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "cancelled"));
    }
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to edit pipeline settings." />;
  }

  if (!pipelineId) {
    return <EmptyState icon={Hexagon} message="No pipeline selected." />;
  }

  if (pipelineQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (pipelineQuery.error) {
    return <p className="text-sm text-destructive">{pipelineQuery.error.message}</p>;
  }

  if (!pipeline) {
    return <EmptyState icon={Hexagon} message="Pipeline not found." />;
  }

  const isArchived = Boolean(pipeline.archivedAt);
  const archiveEnabled = archiveConfirmation === pipeline.name && !archivePipeline.isPending;
  const detailsDirty = pipelineName !== pipeline.name || pipelineDescription !== (pipeline.description ?? "");
  const reviewTargetsMissing = stageKind === "review" && (!approveTarget || !rejectTarget);
  const otherStages = stages.filter((stage) => stage.id !== selectedStage?.id);
  const isReviewStage = stageKind === "review";
  const defaultAutoAdvanceStage = nextStageByPosition(stages, selectedStage) ?? otherStages[0] ?? null;

  const savedStageForm = selectedStage
    ? computeStageForm(selectedStage, pipeline.transitions ?? [])
    : null;
  const currentStageForm: StageFormValues | null = selectedStage
    ? {
        name: stageName,
        kind: stageKind,
        newEntriesDisabled,
        disableReason,
        assigneeAgentId: stageAssigneeAgentId,
        approvalRequired: stageKind === "review",
        approval: selectedApproval,
        approveTarget,
        rejectTarget,
        requestChangesTarget,
        requireRejectReason,
        requireChildrenTerminal,
        autoAdvanceOnChildrenTerminal,
        transitionTargetIds: [...transitionTargets].sort(),
      }
    : null;
  const selectedStageKindOption =
    STAGE_KIND_OPTIONS.find((option) => option.value === stageKind) ?? STAGE_KIND_OPTIONS[0]!;
  const SelectedStageKindIcon = selectedStageKindOption.icon;
  const instructionsBodyDirty = selectedStage != null && instructionsBody !== savedInstructionsBody;
  const variablesDirty =
    selectedStage != null &&
    JSON.stringify(instructionsVariables) !== JSON.stringify(savedInstructionsVariables);
  const selectedAutomationAgent = stageAssigneeAgentId ? agentById.get(stageAssigneeAgentId) ?? null : null;
  const stageDirty =
    (savedStageForm != null &&
      currentStageForm != null &&
      JSON.stringify(savedStageForm) !== JSON.stringify(currentStageForm)) ||
    instructionsBodyDirty ||
    variablesDirty;

  return (
    <div className="space-y-6">
      <form
        className="border-b border-border pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          savePipelineDetails.mutate();
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <Link to={`/pipelines/${pipeline.id}`} className="text-sm text-muted-foreground hover:text-foreground">
            Back to board
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8" title="Pipeline actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isArchived ? (
                <DropdownMenuItem onSelect={() => archivePipeline.mutate(false)}>
                  <Archive className="h-4 w-4" />
                  Restore pipeline
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => setArchiveDialogOpen(true)}>
                  <Archive className="h-4 w-4" />
                  Archive pipeline
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span className="sr-only">Pipeline name</span>
              <Input
                aria-label="Pipeline name"
                value={pipelineName}
                onChange={(event) => setPipelineName(event.target.value)}
                required
                className="h-auto border-0 bg-transparent px-0 py-0 text-2xl font-semibold tracking-normal shadow-none focus-visible:ring-0"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span className="sr-only">Pipeline description</span>
              <Textarea
                aria-label="Pipeline description"
                value={pipelineDescription}
                onChange={(event) => setPipelineDescription(event.target.value)}
                rows={2}
                placeholder="Add a description"
                className="min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0"
              />
            </label>
          </div>
          {detailsDirty || savePipelineDetails.isPending ? (
            <Button type="submit" disabled={savePipelineDetails.isPending || !pipelineName.trim()}>
              <Save className="h-4 w-4" />
              {savePipelineDetails.isPending ? "Saving..." : "Save details"}
            </Button>
          ) : null}
        </div>
        {savePipelineDetails.error ? (
          <p className="mt-3 text-sm text-destructive">{savePipelineDetails.error.message}</p>
        ) : null}
      </form>

      <div className="space-y-6">
          {stages.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              message="No stages configured."
              action="Add first stage"
              onAction={() => addStage.mutate(null)}
            />
          ) : (
            <div className="overflow-x-auto border-y border-border py-4">
              <div className="flex min-w-max items-center gap-2">
                {stages.map((stage, index) => {
                  const warningCount = healthWarningsByStage[stage.id]?.length ?? 0;
                  const canInsertAfter = !isPipelineTerminalStageKind(stage.kind);
                  return (
                    <div key={stage.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={
                          warningCount > 0
                            ? `${stage.name}, ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`
                            : stage.name
                        }
                        className={cn(
                          "min-h-20 w-48 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                          selectedStage?.id === stage.id
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/40",
                        )}
                        onClick={() => setSelectedStageId(stage.id)}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0 flex-1 font-semibold text-foreground">{stage.name}</span>
                          {warningCount > 0 ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {warningCount} {warningCount === 1 ? "warning" : "warnings"}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">Step {index + 1}</span>
                        {stageNewEntriesDisabled(stage) ? (
                          <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            New entries paused
                          </span>
                        ) : null}
                      </button>
                      {canInsertAfter ? (
                        <button
                          type="button"
                          aria-label={`Insert stage after ${stage.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                          onClick={() => addStage.mutate(stage)}
                          disabled={addStage.isPending}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      ) : null}
                      {index === stages.length - 1 ? null : (
                        <span className="h-px w-8 bg-border" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedStage ? (
            <form
              className="space-y-5"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                saveStage.mutate();
              }}
            >
              <div className="flex flex-col gap-5 md:flex-row md:gap-0">
                <StageSubSidebar
                  activeSection={activeStageSection}
                  stageKind={stageKind}
                  onSectionChange={setActiveStageSection}
                />
                <div className="min-w-0 flex-1 md:px-8">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold text-foreground">
                      {STAGE_SECTION_TITLES[activeStageSection]}
                    </h2>
                    {activeStageSection === "overview" ? (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className={cn(
                            "h-8 w-8",
                            newEntriesDisabled &&
                              "border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300",
                          )}
                          title={newEntriesDisabled ? "Resume new entries" : "Pause new entries"}
                          aria-label={newEntriesDisabled ? "Resume new entries" : "Pause new entries"}
                          onClick={() => setNewEntriesDisabled((value) => !value)}
                        >
                          {newEntriesDisabled ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title={`Delete ${selectedStage.name}`}
                          aria-label={`Delete ${selectedStage.name}`}
                          onClick={() => setDeleteStageDialogOpen(true)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <StageHealthWarnings
                    className="mb-4"
                    warnings={healthWarningsByStage[selectedStage.id] ?? []}
                  />

                  {activeStageSection === "overview" ? (
                    <div className="w-full max-w-3xl">
                      <div className="divide-y divide-border border-b border-border">
                        <FieldRow label="Name">
                          <Input value={stageName} onChange={(event) => setStageName(event.target.value)} required />
                        </FieldRow>
                        <FieldRow label="Step type">
                          <div className="max-w-xl space-y-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label="Step type"
                                  className="h-auto min-h-10 w-full justify-between whitespace-normal px-3 py-2 text-left"
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <SelectedStageKindIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{selectedStageKindOption.label}</span>
                                  </span>
                                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))]">
                                <DropdownMenuRadioGroup value={stageKind} onValueChange={setStageKindWithDefaults}>
                                  {STAGE_KIND_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    return (
                                      <DropdownMenuRadioItem
                                        key={option.value}
                                        value={option.value}
                                        className="items-start gap-3 py-2.5"
                                      >
                                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0">
                                          <span className="block font-medium text-foreground">{option.label}</span>
                                          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                            {option.description}
                                          </span>
                                        </span>
                                      </DropdownMenuRadioItem>
                                    );
                                  })}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <p className="text-sm leading-6 text-muted-foreground">
                              {selectedStageKindOption.description}
                            </p>
                          </div>
                        </FieldRow>

                        {stageKind === "review" ? (
                          <FieldRow label="Approver">
                            <InlineEntitySelector
                              value={selectedApproval === "any_human" ? "" : selectedApproval}
                              options={approvalOptions}
                              recentOptionIds={recentAssigneeOptionIds}
                              placeholder="Approver"
                              noneLabel="Any human"
                              searchPlaceholder="Search approvers..."
                              emptyMessage="No approvers found."
                              onChange={(value) => setSelectedApproval(approverValueFromOption(value))}
                              renderTriggerValue={(option) => {
                                if (!option) return <span className="text-muted-foreground">Any human</span>;
                                const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
                                return (
                                  <>
                                    {agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                                    <span className="truncate">{option.label}</span>
                                  </>
                                );
                              }}
                              renderOption={(option) => {
                                if (!option.id) return <span className="truncate">{option.label}</span>;
                                const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
                                return (
                                  <>
                                    {agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                                    <span className="truncate">{option.label}</span>
                                  </>
                                );
                              }}
                            />
                          </FieldRow>
                        ) : null}

                        {stageKind === "review" ? (
                          <FieldRow label="Review outcomes">
                            <div className="space-y-2">
                              {([
                                ["Approved items move to", approveTarget, setApproveTarget, "Choose a stage"],
                                ["Declined items move to", rejectTarget, setRejectTarget, "Choose a stage"],
                                ["Items needing changes move to", requestChangesTarget, setRequestChangesTarget, "Stay in review"],
                              ] as const).map(([label, value, setValue, emptyLabel]) => (
                                <div
                                  key={label}
                                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_240px]"
                                >
                                  <span className="text-sm font-medium">{label}</span>
                                  <select
                                    aria-label={label}
                                    value={value}
                                    onChange={(event) => setValue(event.target.value)}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                  >
                                    <option value="">{emptyLabel}</option>
                                    {otherStages.map((stage) => (
                                      <option key={stage.id} value={stage.key}>{stage.name}</option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                              <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_240px]">
                                <span className="text-sm font-medium">Ask for a note when declining</span>
                                <div className="sm:justify-self-start">
                                  <ToggleSwitch checked={requireRejectReason} onCheckedChange={setRequireRejectReason} />
                                </div>
                              </div>
                            </div>
                            {reviewTargetsMissing ? (
                              <p className="mt-2 text-sm text-muted-foreground">
                                Pick where approved and declined items should go before saving.
                              </p>
                            ) : null}
                          </FieldRow>
                        ) : null}

                        {isReviewStage || isPipelineTerminalStageKind(stageKind) ? null : (
                          <FieldRow label="Allowed next steps">
                            <div className="space-y-2">
                              {otherStages.map((stage) => {
                                const isCancelled = stage.kind === "cancelled";
                                const checked = isCancelled || transitionTargets.has(stage.id);
                                return (
                                  <label
                                    key={stage.id}
                                    className={cn(
                                      "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm",
                                      isCancelled && "text-muted-foreground",
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={isCancelled}
                                      onChange={(event) => {
                                        if (isCancelled) return;
                                        setTransitionTargets((current) => {
                                          const next = new Set(current);
                                          if (event.target.checked) next.add(stage.id);
                                          else next.delete(stage.id);
                                          return next;
                                        });
                                      }}
                                    />
                                    <span className="flex-1">{stage.name}</span>
                                    {isCancelled ? (
                                      <span className="text-xs text-muted-foreground">Always available</span>
                                    ) : null}
                                  </label>
                                );
                              })}
                            </div>
                          </FieldRow>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {activeStageSection === "instructions" ? (
                    <div className="w-full max-w-3xl space-y-6">
                      <div className="overflow-x-auto overscroll-x-contain">
                        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                          <span>When an item enters this step</span>
                          <InlineEntitySelector
                            value={stageAssigneeOptionId(stageAssigneeAgentId)}
                            options={stageAssigneeOptions}
                            recentOptionIds={recentAssigneeOptionIds}
                            placeholder="Pick agent"
                            noneLabel="No automation"
                            searchPlaceholder="Search agents..."
                            emptyMessage="No agents found."
                            onChange={(value) => setStageAssigneeAgentId(stageAssigneeIdFromOption(value))}
                            renderTriggerValue={(option) => {
                              if (!option) return <span className="text-muted-foreground">Pick agent</span>;
                              const agent = stageAssigneeIdFromOption(option.id)
                                ? agentById.get(stageAssigneeIdFromOption(option.id))
                                : null;
                              return (
                                <>
                                  {agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                                  <span className="truncate">{option.label}</span>
                                </>
                              );
                            }}
                            renderOption={(option) => {
                              if (!option.id) return <span className="truncate">{option.label}</span>;
                              const agentId = stageAssigneeIdFromOption(option.id);
                              const agent = agentId ? agentById.get(agentId) : null;
                              return (
                                <>
                                  {agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                                  <span className="truncate">{option.label}</span>
                                </>
                              );
                            }}
                          />
                          <span>runs these instructions, then moves the item to the next step.</span>
                        </div>
                      </div>

                      {selectedAutomationAgent ? (
                        <>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <AgentIcon icon={selectedAutomationAgent.icon} className="h-4 w-4 shrink-0" />
                            <span>{selectedAutomationAgent.name} runs this step automatically.</span>
                          </div>
                          <div data-testid="stage-instructions-editor">
                            <MarkdownEditor
                              value={instructionsBody}
                              onChange={setInstructionsBody}
                              placeholder="Tell the agent exactly what to do when an item enters this step..."
                              bordered={false}
                              contentClassName="min-h-[120px] text-[15px] leading-7"
                              mentions={mentionOptions}
                              onSubmit={() => {
                                if (!saveStage.isPending && stageName.trim() && !reviewTargetsMissing) {
                                  saveStage.mutate();
                                }
                              }}
                            />
                          </div>
                        </>
                      ) : (
                        <EmptyState
                          icon={Pause}
                          message="Nothing runs here automatically. Items wait until a person moves them, or you can pick an agent to run this step."
                        />
                      )}
                      {selectedAutomationAgent ? (
                        <div className="space-y-3">
                          <RoutineVariablesHint />
                          <RoutineVariablesEditor
                            title={stageName}
                            description={instructionsBody}
                            value={instructionsVariables}
                            onChange={setInstructionsVariables}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {activeStageSection === "secrets" ? (
                    <div className="w-full max-w-3xl">
                      <EmptyState icon={KeyRound} message="No stage secrets configured." />
                    </div>
                  ) : null}

                  {activeStageSection === "advanced" && !isPipelineTerminalStageKind(stageKind) ? (
                    <div className="w-full max-w-3xl">
                      <div className="divide-y divide-border border-b border-border">
                        <div className="py-3">
                          <h3 className="text-sm font-semibold text-foreground">Children</h3>
                        </div>
                        <FieldRow label="Block children">
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-3">
                              <ToggleSwitch
                                checked={requireChildrenTerminal}
                                onCheckedChange={setRequireChildrenTerminal}
                              />
                              <span className="text-sm font-medium text-foreground">
                                Block until all child items are done or cancelled
                              </span>
                            </div>
                            <p className="max-w-2xl text-sm text-muted-foreground">
                              When on, this step can't move forward while any child item is still open. When off, items can move through even with open children.
                            </p>
                          </div>
                        </FieldRow>
                        <FieldRow label="Advance children">
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <ToggleSwitch
                                checked={Boolean(autoAdvanceOnChildrenTerminal)}
                                onCheckedChange={(checked) => {
                                  setAutoAdvanceOnChildrenTerminal(checked ? autoAdvanceOnChildrenTerminal || defaultAutoAdvanceStage?.key || "" : "");
                                }}
                              />
                              <span className="text-sm font-medium text-foreground">
                                Advance when the last child is done
                              </span>
                            </div>
                            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[5rem_240px]">
                              <span className="text-sm font-medium text-muted-foreground">Move to</span>
                              <select
                                aria-label="Move to stage when children finish"
                                value={autoAdvanceOnChildrenTerminal}
                                onChange={(event) => setAutoAdvanceOnChildrenTerminal(event.target.value)}
                                disabled={!autoAdvanceOnChildrenTerminal}
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                              >
                                <option value="">Choose a stage</option>
                                {otherStages.map((stage) => (
                                  <option key={stage.id} value={stage.key}>{stage.name}</option>
                                ))}
                              </select>
                            </div>
                            <p className="max-w-2xl text-sm text-muted-foreground">
                              When on and every child is done, this step moves the item forward automatically. When off, someone has to move it.
                            </p>
                          </div>
                        </FieldRow>
                      </div>
                    </div>
                  ) : null}

                  {activeStageSection === "runs" ? (
                    <div className="w-full space-y-3">
                      {stageEventsQuery.isLoading ? (
                        <PageSkeleton variant="list" />
                      ) : (
                        <StageEventsList
                          events={stageRunEvents}
                          stages={stages}
                          emptyMessage="No stage runs yet."
                        />
                      )}
                    </div>
                  ) : null}

                  {activeStageSection === "activity" ? (
                    <div className="w-full space-y-3">
                      {stageEventsQuery.isLoading ? (
                        <PageSkeleton variant="list" />
                      ) : (
                        <StageEventsList
                          events={stageEvents}
                          stages={stages}
                          emptyMessage="No stage activity yet."
                        />
                      )}
                    </div>
                  ) : null}

                  {activeStageSection === "history" ? (
                    <div className="w-full max-w-3xl">
                      {instructionsKey ? (
                        <PipelineStageHistoryPanel
                          pipelineId={pipelineId}
                          documentKey={instructionsKey}
                          currentRevisionId={(instructionsDocument?.document?.latestRevisionId as string | null | undefined) ?? null}
                          hasDocument={Boolean(instructionsDocument)}
                          onRestored={(body, baseRevisionId) => {
                            setInstructionsBody(body);
                            void baseRevisionId;
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {saveStage.error ? <p className="text-sm text-destructive">{saveStage.error.message}</p> : null}

              {stageDirty || saveStage.isPending ? (
                <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
                  <span className="text-sm text-muted-foreground">
                    {saveStage.isPending ? "Saving changes…" : "You have unsaved changes."}
                  </span>
                  <Button type="submit" disabled={saveStage.isPending || !stageName.trim() || reviewTargetsMissing}>
                    {saveStage.isPending ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                    {saveStage.isPending ? "Saving..." : "Save stage"}
                  </Button>
                </div>
              ) : null}
            </form>
          ) : null}
      </div>
      <Dialog
        open={deleteStageDialogOpen}
        onOpenChange={setDeleteStageDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete stage</DialogTitle>
            <DialogDescription>
              Delete {selectedStage?.name ?? "this stage"} from this pipeline. Connected stage transitions are removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {stages.length > 1 ? (
              <label className="block space-y-1.5 text-sm font-medium">
                <span>Move existing items to</span>
                <select
                  aria-label="Move existing items to"
                  value={deleteMoveTargetStageId}
                  onChange={(event) => setDeleteMoveTargetStageId(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {stages
                    .filter((stage) => stage.id !== selectedStage?.id)
                    .map((stage) => (
                      <option key={stage.id} value={stage.id}>{stage.name}</option>
                    ))}
                </select>
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">
                This is the only stage. Deletion succeeds only if it has no items.
              </p>
            )}
            {deleteStage.error ? (
              <p className="text-sm text-destructive">{deleteStage.error.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteStageDialogOpen(false)}
              disabled={deleteStage.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteStage.isPending || (stages.length > 1 && !deleteMoveTargetStageId)}
              onClick={() => deleteStage.mutate()}
            >
              <Trash2 className="h-4 w-4" />
              {deleteStage.isPending ? "Deleting..." : "Delete stage"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveDialogOpen}
        onOpenChange={(open) => {
          setArchiveDialogOpen(open);
          if (!open) setArchiveConfirmation("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive pipeline</DialogTitle>
            <DialogDescription>
              Archiving hides this pipeline from everyday views. Its stages and items are kept and can be restored later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Type {pipeline.name} to confirm</span>
              <Input
                aria-label="Archive confirmation"
                value={archiveConfirmation}
                onChange={(event) => setArchiveConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            {archivePipeline.error ? (
              <p className="text-sm text-destructive">{archivePipeline.error.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setArchiveDialogOpen(false)}
              disabled={archivePipeline.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!archiveEnabled}
              onClick={() => archivePipeline.mutate(true)}
            >
              <Archive className="h-4 w-4" />
              {archivePipeline.isPending ? "Archiving..." : "Archive pipeline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
