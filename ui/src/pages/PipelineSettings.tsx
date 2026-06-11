import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { syncRoutineVariablesWithTemplate, type Agent, type RoutineVariable } from "@paperclipai/shared";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Archive,
  Check,
  Circle,
  GitBranch,
  History as HistoryIcon,
  Hexagon,
  KeyRound,
  LayoutGrid,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import { ApiError } from "../api/client";
import type { PipelineCompanyCaseEvent, PipelineDetail, PipelineStage, PipelineTransitionEdge } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { PipelineStageHistoryPanel } from "../components/PipelineStageHistoryPanel";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { formatPipelineItemEvent } from "../lib/pipeline-item-detail";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Link, useNavigate, useParams } from "@/lib/router";

type SettingsTab = "stages" | "guidance";
type StageSectionKey = "overview" | "variables" | "secrets" | "runs" | "activity" | "history";
type ApproverKind = "any_human" | "user" | "agent";

type StageConfig = {
  // Stage instruction variables are stored in the routine variable shape
  // (`{ name, label, type, defaultValue, required, options }`) and kept in sync
  // with the instructions body. Legacy entries used `{ key, ... }`; both are
  // read through `toRoutineVariables`.
  variables?: unknown[];
  disabled?: boolean;
  disabledReason?: string | null;
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
  [key: string]: unknown;
};

const TAB_LABELS: Array<{ id: SettingsTab; label: string }> = [
  { id: "stages", label: "Stages" },
  { id: "guidance", label: "Guidance" },
];

const STAGE_NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: StageSectionKey; label: string; icon: typeof Circle }>;
}> = [
  {
    label: "Stage",
    items: [
      { id: "overview", label: "Overview", icon: Circle },
      { id: "variables", label: "Variables", icon: LayoutGrid },
      { id: "secrets", label: "Secrets", icon: KeyRound },
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
  variables: "Variables",
  secrets: "Secrets",
  runs: "Runs",
  activity: "Activity",
  history: "History",
};

const PIPELINE_GUIDANCE_KEY = "guidance";

/** Per-stage instructions document key — keyed by stage id so it survives renames. */
function stageInstructionsKey(stageId: string) {
  return `stage-instructions:${stageId}`;
}

/** Raised when the instructions document upsert is rejected for a stale base revision. */
class StageInstructionsConflictError extends Error {
  constructor() {
    super("Stage instructions were updated by someone else.");
    this.name = "StageInstructionsConflictError";
  }
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
  approvalRequired: boolean;
  approval: string;
  approveTarget: string;
  rejectTarget: string;
  requestChangesTarget: string;
  requireRejectReason: boolean;
  transitionTargetIds: string[];
};

type PipelineTransitionRecord = { fromStageId: string; toStageId: string; label?: string | null };

function computeStageForm(
  stage: PipelineStage,
  transitions: PipelineTransitionRecord[],
): StageFormValues {
  const config = stageConfig(stage);
  return {
    name: stage.name,
    kind: stage.kind,
    newEntriesDisabled: stageNewEntriesDisabled(stage),
    disableReason: config.disabledReason ?? "",
    approvalRequired: Boolean(config.requireApproval),
    approval: approvalValue(config),
    approveTarget: config.approveToStageKey ?? "",
    rejectTarget: config.rejectToStageKey ?? "",
    requestChangesTarget: config.requestChangesToStageKey ?? "",
    requireRejectReason: config.requireRejectReason ?? true,
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

function humanLabel(entry: CompanyUserDirectoryEntry) {
  return entry.user?.name || entry.user?.email || entry.principalId;
}

function agentLabel(agent: Agent) {
  return agent.name || agent.role || agent.id;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function StageSubSidebar({
  activeSection,
  onSectionChange,
}: {
  activeSection: StageSectionKey;
  onSectionChange: (section: StageSectionKey) => void;
}) {
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
          {STAGE_NAV_GROUPS.map((group) => (
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
        {STAGE_NAV_GROUPS.map((group) => (
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
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stages");
  const [activeStageSection, setActiveStageSection] = useState<StageSectionKey>("overview");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageKind, setStageKind] = useState("open");
  const [newEntriesDisabled, setNewEntriesDisabled] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState("any_human");
  const [instructionsBody, setInstructionsBody] = useState("");
  const [instructionsVariables, setInstructionsVariables] = useState<RoutineVariable[]>([]);
  const [instructionsConflict, setInstructionsConflict] = useState(false);
  const [approveTarget, setApproveTarget] = useState("");
  const [rejectTarget, setRejectTarget] = useState("");
  const [requestChangesTarget, setRequestChangesTarget] = useState("");
  const [requireRejectReason, setRequireRejectReason] = useState(true);
  const [transitionTargets, setTransitionTargets] = useState<Set<string>>(() => new Set());
  const [guidanceBody, setGuidanceBody] = useState("");
  const [pipelineName, setPipelineName] = useState("");
  const [pipelineDescription, setPipelineDescription] = useState("");
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const guidanceQuery = useQuery({
    queryKey: pipelineId
      ? queryKeys.pipelines.document(pipelineId, PIPELINE_GUIDANCE_KEY)
      : ["pipelines", "document", "none"],
    queryFn: async () => {
      try {
        return await pipelinesApi.getDocument(pipelineId!, PIPELINE_GUIDANCE_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const usersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.companyUserDirectory(selectedCompanyId) : ["access", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(() => sortedStages(pipeline), [pipeline]);
  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0] ?? null;
  const guidanceDocument = guidanceQuery.data ?? null;
  const savedGuidanceBody = guidanceDocument
    ? guidanceDocument.revision?.body ?? guidanceDocument.document?.latestBody ?? ""
    : "";

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
  // Read-through back-compat: when no per-stage document exists yet, seed the
  // editor from the legacy `config.whatHappensHere`; the first save writes the
  // document and the document becomes the source of truth thereafter.
  const savedInstructionsBody = instructionsDocument
    ? instructionsDocument.revision?.body ?? instructionsDocument.document?.latestBody ?? ""
    : stageConfig(selectedStage).whatHappensHere ?? "";
  const instructionsBaseRevisionId =
    (instructionsDocument?.document?.latestRevisionId as string | null | undefined) ?? null;
  const savedInstructionsVariables = useMemo(
    () => savedStageVariables(selectedStage, savedInstructionsBody),
    [selectedStage, savedInstructionsBody],
  );

  const mentionOptions = useMemo(
    () => buildMarkdownMentionOptions({ agents: agentsQuery.data, members: usersQuery.data?.users }),
    [agentsQuery.data, usersQuery.data?.users],
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
    setApprovalRequired(form.approvalRequired);
    setSelectedApproval(form.approval);
    setApproveTarget(form.approveTarget);
    setRejectTarget(form.rejectTarget);
    setRequestChangesTarget(form.requestChangesTarget);
    setRequireRejectReason(form.requireRejectReason);
    setTransitionTargets(new Set(form.transitionTargetIds));
  }, [pipeline?.transitions, selectedStage]);

  // Instructions body + variables hydrate from the per-stage document (or the
  // legacy field). Resetting on the saved value clears dirty after save/reload.
  useEffect(() => {
    setInstructionsBody(savedInstructionsBody);
    setInstructionsVariables(savedInstructionsVariables);
    setInstructionsConflict(false);
  }, [selectedStage?.id, savedInstructionsBody, savedInstructionsVariables]);

  useEffect(() => {
    setGuidanceBody(savedGuidanceBody);
  }, [savedGuidanceBody]);

  useEffect(() => {
    if (!pipeline) return;
    setPipelineName(pipeline.name);
    setPipelineDescription(pipeline.description ?? "");
  }, [pipeline]);

  const refreshPipeline = async () => {
    if (!pipelineId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId) });
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage || !pipeline) return null;
      const parsedApproval = parseApprovalValue(selectedApproval);
      const config: StageConfig = {
        ...stageConfig(selectedStage),
        variables: instructionsVariables,
        disabled: newEntriesDisabled,
        disabledReason: newEntriesDisabled ? disableReason.trim() || null : null,
        requireApproval: approvalRequired,
        approver: approvalRequired && parsedApproval.kind !== "any_human"
          ? { kind: parsedApproval.kind, id: parsedApproval.id }
          : { kind: "any_human" },
        // Mirror the body into the legacy field so read-through stays consistent
        // for any caller still reading `config.whatHappensHere`.
        whatHappensHere: instructionsBody.trim(),
      };
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

      // Persist the instructions body first so a stale-revision conflict aborts
      // before we mutate the rest of the stage config (no half-applied save).
      const bodyChanged = instructionsBody !== savedInstructionsBody;
      const needsFirstWrite = !instructionsDocument && instructionsBody.trim().length > 0;
      if (bodyChanged || needsFirstWrite) {
        try {
          await pipelinesApi.upsertDocument(pipelineId, stageInstructionsKey(selectedStage.id), {
            title: `${stageName.trim() || selectedStage.name} instructions`,
            body: instructionsBody,
            baseRevisionId: instructionsBaseRevisionId,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            throw new StageInstructionsConflictError();
          }
          throw error;
        }
      }

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
      setInstructionsConflict(false);
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
      if (error instanceof StageInstructionsConflictError) {
        setInstructionsConflict(true);
        if (pipelineId && instructionsKey) {
          await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.document(pipelineId, instructionsKey) });
        }
        pushToast({
          title: "Instructions changed",
          body: "Someone else updated these instructions. Reload to see the latest version.",
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: "Failed to save stage",
        body: error instanceof Error ? error.message : "Paperclip could not save the stage.",
        tone: "error",
      });
    },
  });

  const reloadInstructions = async () => {
    if (!pipelineId || !instructionsKey) return;
    setInstructionsConflict(false);
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.document(pipelineId, instructionsKey) });
  };

  const addStage = useMutation({
    mutationFn: async (afterStage: PipelineStage | null) => {
      if (!pipelineId || !pipeline) return null;
      const lastStage = stages[stages.length - 1] ?? null;
      const insertPosition = afterStage ? afterStage.position + 1 : (lastStage ? lastStage.position + 100 : 100);
      const nextStage = afterStage
        ? stages.find((stage) => stage.position > afterStage.position) ?? null
        : null;
      const existingKeys = new Set(stages.map((stage) => stage.key));
      const created = await pipelinesApi.createStage(pipelineId, {
        key: nextStageKey("New stage", existingKeys),
        name: "New stage",
        kind: "working",
        position: insertPosition,
        config: { variables: [] },
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

  const saveGuidance = useMutation({
    mutationFn: () =>
      pipelinesApi.upsertDocument(pipelineId!, PIPELINE_GUIDANCE_KEY, {
        title: "Pipeline guidance",
        body: guidanceBody.trim(),
      }),
    onSuccess: async () => {
      if (pipelineId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.pipelines.document(pipelineId, PIPELINE_GUIDANCE_KEY),
        });
      }
      await refreshPipeline();
      pushToast({ title: "Guidance saved", tone: "success" });
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

  const savedStageForm = selectedStage
    ? computeStageForm(selectedStage, pipeline.transitions ?? [])
    : null;
  const currentStageForm: StageFormValues | null = selectedStage
    ? {
        name: stageName,
        kind: stageKind,
        newEntriesDisabled,
        disableReason,
        approvalRequired,
        approval: selectedApproval,
        approveTarget,
        rejectTarget,
        requestChangesTarget,
        requireRejectReason,
        transitionTargetIds: [...transitionTargets].sort(),
      }
    : null;
  const instructionsBodyDirty = selectedStage != null && instructionsBody !== savedInstructionsBody;
  const variablesDirty =
    selectedStage != null &&
    JSON.stringify(instructionsVariables) !== JSON.stringify(savedInstructionsVariables);
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

      <div className="flex border-b border-border" role="tablist" aria-label="Pipeline settings tabs">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-value={tab.id}
            aria-selected={activeTab === tab.id}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-semibold",
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "stages" ? (
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
                {stages.map((stage, index) => (
                  <div key={stage.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "min-h-20 w-48 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selectedStage?.id === stage.id
                          ? "border-foreground bg-accent/50"
                          : "border-border hover:bg-accent/40",
                      )}
                      onClick={() => setSelectedStageId(stage.id)}
                    >
                      <span className="block font-semibold text-foreground">{stage.name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Step {index + 1}</span>
                      {stageNewEntriesDisabled(stage) ? (
                        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3" />
                          New entries paused
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Insert stage after ${stage.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                      onClick={() => addStage.mutate(stage)}
                      disabled={addStage.isPending}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {index === stages.length - 1 ? null : (
                      <span className="h-px w-8 bg-border" aria-hidden="true" />
                    )}
                  </div>
                ))}
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
                <StageSubSidebar activeSection={activeStageSection} onSectionChange={setActiveStageSection} />
                <div className="min-w-0 flex-1 md:px-8">
                  <h2 className="mb-4 text-lg font-semibold text-foreground">
                    {STAGE_SECTION_TITLES[activeStageSection]}
                  </h2>

                  {activeStageSection === "overview" ? (
                    <div className="mx-auto w-full max-w-3xl space-y-5">
                      <Section title="Basics">
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                          <label className="block space-y-1.5 text-sm font-medium">
                            <span>Name</span>
                            <Input value={stageName} onChange={(event) => setStageName(event.target.value)} required />
                          </label>
                          <label className="block space-y-1.5 text-sm font-medium">
                            <span>Kind</span>
                            <select
                              value={stageKind}
                              onChange={(event) => setStageKindWithDefaults(event.target.value)}
                              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            >
                              <option value="open">Open</option>
                              <option value="working">Working</option>
                              <option value="review">Review</option>
                              <option value="done">Done</option>
                              <option value="cancelled">Cancelled</option>
                            </select>
                          </label>
                        </div>
                      </Section>

                      <Section title="Approval">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-medium">Require approval</div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              Items need a sign-off before they can leave this stage.
                            </p>
                          </div>
                          <ToggleSwitch checked={approvalRequired} onCheckedChange={setApprovalRequired} />
                        </div>
                        {approvalRequired ? (
                          <label className="block max-w-md space-y-1.5 text-sm font-medium">
                            <span>Approver</span>
                            <select
                              aria-label="Approval picker"
                              value={selectedApproval}
                              onChange={(event) => setSelectedApproval(event.target.value)}
                              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            >
                              <option value="any_human">Any human</option>
                              <optgroup label="People">
                                {(usersQuery.data?.users ?? []).map((user) => (
                                  <option key={user.principalId} value={`user:${user.principalId}`}>
                                    {humanLabel(user)}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Agents">
                                {(agentsQuery.data ?? []).map((agent) => (
                                  <option key={agent.id} value={`agent:${agent.id}`}>
                                    {agentLabel(agent)}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </label>
                        ) : null}
                      </Section>

                      {stageKind === "review" ? (
                        <Section title="Review outcomes">
                          <p className="text-sm text-muted-foreground">
                            These are this stage&apos;s allowed next steps. Each outcome sends the item to the stage you pick.
                          </p>
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
                            <p className="text-sm text-muted-foreground">
                              Pick where approved and declined items should go before saving.
                            </p>
                          ) : null}
                        </Section>
                      ) : null}

                      {isReviewStage ? null : (
                        <Section title="Allowed next steps">
                          <p className="text-sm text-muted-foreground">
                            Where items in {selectedStage.name} are allowed to move next.
                          </p>
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
                        </Section>
                      )}

                      <Section title="New entries">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-sm font-medium">
                              {newEntriesDisabled ? "New entries are paused" : "New entries are open"}
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              When paused, nothing new can move into this stage. Existing items stay on the board.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant={newEntriesDisabled ? "default" : "outline"}
                            onClick={() => setNewEntriesDisabled((value) => !value)}
                          >
                            {newEntriesDisabled ? (
                              <>
                                <Play className="h-4 w-4" />
                                Resume
                              </>
                            ) : (
                              <>
                                <Pause className="h-4 w-4" />
                                Pause new entries
                              </>
                            )}
                          </Button>
                        </div>
                      </Section>
                    </div>
                  ) : null}

                  {activeStageSection === "variables" ? (
                    <div className="mx-auto w-full max-w-3xl space-y-5">
                      <Section title="Instructions">
                        <p className="text-sm text-muted-foreground">
                          The plain-language routine this stage runs. Type <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{name}}"}</code> to add a
                          variable; it appears below and the first stage&apos;s variables become the Add-item form fields.
                        </p>
                        <div data-testid="stage-instructions-editor" className="rounded-md border border-input">
                          <MarkdownEditor
                            value={instructionsBody}
                            onChange={setInstructionsBody}
                            placeholder="Describe the work that should happen in this stage."
                            bordered={false}
                            contentClassName="min-h-[120px] px-3 py-2 text-[15px] leading-7"
                            mentions={mentionOptions}
                            onSubmit={() => {
                              if (!saveStage.isPending && stageName.trim() && !reviewTargetsMissing) {
                                saveStage.mutate();
                              }
                            }}
                          />
                        </div>
                        {instructionsConflict ? (
                          <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                            <span>Someone else updated these instructions. Reload to get their version, then re-apply your edits.</span>
                            <Button type="button" variant="outline" size="sm" onClick={reloadInstructions}>
                              <RefreshCw className="h-3.5 w-3.5" />
                              Reload latest
                            </Button>
                          </div>
                        ) : null}
                        <div className="space-y-3">
                          <RoutineVariablesHint />
                          <RoutineVariablesEditor
                            title=""
                            description={instructionsBody}
                            value={instructionsVariables}
                            onChange={setInstructionsVariables}
                          />
                        </div>
                      </Section>
                    </div>
                  ) : null}

                  {activeStageSection === "secrets" ? (
                    <div className="mx-auto w-full max-w-3xl">
                      <EmptyState icon={KeyRound} message="No stage secrets configured." />
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
                    <div className="mx-auto w-full max-w-3xl">
                      {instructionsKey ? (
                        <PipelineStageHistoryPanel
                          pipelineId={pipelineId}
                          documentKey={instructionsKey}
                          currentRevisionId={instructionsBaseRevisionId}
                          hasDocument={Boolean(instructionsDocument)}
                          onRestored={(body, baseRevisionId) => {
                            setInstructionsBody(body);
                            setInstructionsConflict(false);
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
      ) : null}

      {activeTab === "guidance" ? (
        <form
          className="max-w-3xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveGuidance.mutate();
          }}
        >
          <div>
            <h2 className="text-lg font-semibold text-foreground">Pipeline guidance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Plain-language instructions agents and operators can use when handling this pipeline.
            </p>
          </div>
          <Textarea
            value={guidanceBody}
            onChange={(event) => setGuidanceBody(event.target.value)}
            rows={12}
            placeholder="Write guidance for how work should enter, move through, and leave this pipeline."
          />
          {saveGuidance.error ? <p className="text-sm text-destructive">{saveGuidance.error.message}</p> : null}
          <Button type="submit" disabled={saveGuidance.isPending || !guidanceBody.trim()}>
            <Save className="h-4 w-4" />
            {saveGuidance.isPending ? "Saving..." : "Save guidance"}
          </Button>
        </form>
      ) : null}
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
              Archiving hides this pipeline from everyday views. Its stages, guidance, and items are kept and can be restored later.
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
