import { useTranslation, t } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, History, Pencil, Repeat, Sparkles, X } from "lucide-react";
import { ApiError } from "../api/client";
import {
  routinesApi,
  type RoutineTriggerResponse,
  type RotateRoutineTriggerResponse,
  type RestoreRoutineRevisionResponse,
} from "../api/routines";
import { secretsApi } from "../api/secrets";
import { type RoutineHistoryDirtyFieldDescriptor } from "../components/RoutineHistoryTab";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import { routineOverviewCopyText } from "../lib/routine-description-copy";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { describeError } from "../api/errors";
import { type InlineEntityOption } from "../components/InlineEntitySelector";
import { type MarkdownEditorRef, type MentionOption } from "../components/MarkdownEditor";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RunButton } from "../components/AgentActionButtons";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoutineOverview } from "../components/RoutineOverview";
import { RoutineSectionHeading } from "../components/RoutineSectionHeading";
import { RoutineSectionPicker, RoutineSubSidebar } from "../components/RoutineSubSidebar";
import {
  isRoutineDetailView,
  resolveRoutineDetailDestination,
  routineDetailHref,
} from "../components/RoutineContextualSidebar";
import { RoutineSaveBar } from "../components/RoutineSaveBar";
import {
  EDITABLE_SECTIONS,
  SECTION_FIELD_KEYS,
  RoutineDetailContext,
  createDefaultNewTrigger,
  type RoutineDetailContextValue,
  type RoutineEditDraft,
  type RoutineSectionKey,
  type SecretMessage,
} from "../components/routine-sections/context";
import {
  OverviewSection,
  TriggersSection,
  VariablesSection,
  SecretsSection,
  DeliverySection,
} from "../components/routine-sections/editable-sections";
import {
  ActivitySection,
  HistorySection,
  RunsSection,
} from "../components/routine-sections/operate-sections";
import type {
  RoutineDetail as RoutineDetailType,
  RoutineEnvConfig,
  RoutineVariable,
} from "@paperclipai/shared";

export function buildRoutineProjectOptions(
  projects: ReadonlyArray<{ id: string; name: string; description?: string | null; archivedAt?: Date | string | null }>,
): InlineEntityOption[] {
  return projects
    .filter((project) => !project.archivedAt)
    .map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    }));
}

const SECTION_TITLES: Record<RoutineSectionKey, string> = {
  get overview() { return t("work:copy.overview_d4b1ea"); },
  get triggers() { return t("work:copy.triggers_e62f21"); },
  get variables() { return t("work:copy.variables_02db55"); },
  get secrets() { return t("work:copy.secrets_d8707d"); },
  get delivery() { return t("work:copy.delivery_52bfe5"); },
  get runs() { return t("work:copy.runs_848f54"); },
  get activity() { return t("work:copy.activity_38da15"); },
  get history() { return t("work:copy.versionHistory_a6df11"); },
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function buildRoutineMutationPayload(input: RoutineEditDraft) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    assigneeAgentId: input.assigneeAgentId || null,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : null,
  };
}

export function RoutineDetail() {
  const { t } = useTranslation("work");
  const { routineId, section: sectionParam } = useParams<{ routineId: string; section?: string }>();
  const [searchParams] = useSearchParams();
  const triggerSetup = sectionParam === "triggers" && searchParams.has("triggerSetup");
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [runVariablesOpen, setRunVariablesOpen] = useState(false);
  const [overviewEditing, setOverviewEditing] = useState(false);
  const [newTrigger, setNewTrigger] = useState(createDefaultNewTrigger);
  const [editDraft, setEditDraft] = useState<RoutineEditDraft>({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
  });

  const legacyOperateSection = !streamlinedUiEnabled && (sectionParam === "runs" || sectionParam === "activity")
    ? sectionParam
    : null;
  const section: RoutineSectionKey = legacyOperateSection
    ?? (isRoutineDetailView(sectionParam) ? sectionParam : "overview");

  const navigateToSection = useCallback(
    (next: RoutineSectionKey, options?: { replace?: boolean }) => {
      if (!routineId) return;
      if (!streamlinedUiEnabled && (next === "runs" || next === "activity")) {
        navigate(`/routines/${routineId}/${next}`, { replace: options?.replace ?? true });
        return;
      }
      navigate(
        resolveRoutineDetailDestination({ routineId, section: next }),
        { replace: options?.replace ?? true },
      );
    },
    [navigate, routineId, streamlinedUiEnabled, t],
  );

  const routineQuery = useQuery({
    queryKey: queryKeys.routines.detail(routineId!),
    queryFn: () => routinesApi.get(routineId!),
    enabled: !!routineId,
  });
  const { data: routine, isLoading } = routineQuery;
  const routineView = useQueryView(routineQuery);
  const activeIssueId = routine?.activeIssue?.id;
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(activeIssueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(activeIssueId!),
    enabled: !!activeIssueId,
    refetchInterval: 3000,
  });
  const hasLiveRun = (liveRuns ?? []).length > 0;
  const { data: routineRuns } = useQuery({
    queryKey: queryKeys.routines.runs(routineId!),
    queryFn: () => routinesApi.listRuns(routineId!),
    enabled: !!routineId,
    refetchInterval: hasLiveRun ? 3000 : false,
  });
  const relatedActivityIds = useMemo(
    () => ({
      triggerIds: routine?.triggers.map((trigger) => trigger.id) ?? [],
      runIds: routineRuns?.map((run) => run.id) ?? [],
    }),
    [routine?.triggers, routineRuns, t],
  );
  const activityQuery = useQuery({
    queryKey: [
      ...queryKeys.routines.activity(selectedCompanyId!, routineId!),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => routinesApi.activity(selectedCompanyId!, routineId!, relatedActivityIds),
    enabled: !!selectedCompanyId && !!routineId && !!routine,
  });
  const { data: activity } = activityQuery;
  const activityView = useQueryView(activityQuery);
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error(t("work:copy.selectAnOrganizationToCreateSecrets_adf6cc"));
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const routineDefaults = useMemo<RoutineEditDraft | null>(
    () =>
      routine
        ? {
            title: routine.title,
            description: routine.description ?? "",
            projectId: routine.projectId ?? "",
            assigneeAgentId: routine.assigneeAgentId ?? "",
            priority: routine.priority,
            concurrencyPolicy: routine.concurrencyPolicy,
            catchUpPolicy: routine.catchUpPolicy,
            activityGatePolicy: routine.activityGatePolicy,
            activityGateScope: routine.activityGateScope,
            variables: routine.variables,
            env: routine.env ?? null,
          }
        : null,
    [routine, t],
  );
  const dirtyFields = useMemo<RoutineHistoryDirtyFieldDescriptor[]>(() => {
    if (!routineDefaults) return [];
    const result: RoutineHistoryDirtyFieldDescriptor[] = [];
    if (editDraft.title !== routineDefaults.title) result.push({ key: "title", label: t("work:copy.theTitle_09cb2a") });
    if (editDraft.description !== routineDefaults.description) {
      result.push({ key: "description", label: t("work:copy.theDescription_734b09") });
    }
    if (editDraft.projectId !== routineDefaults.projectId) {
      result.push({ key: "projectId", label: t("work:copy.theProject_059df4") });
    }
    if (editDraft.assigneeAgentId !== routineDefaults.assigneeAgentId) {
      result.push({ key: "assigneeAgentId", label: t("work:copy.theDefaultAgent_730b86") });
    }
    if (editDraft.priority !== routineDefaults.priority) {
      result.push({ key: "priority", label: t("work:copy.thePriority_6b75dd") });
    }
    if (editDraft.concurrencyPolicy !== routineDefaults.concurrencyPolicy) {
      result.push({ key: "concurrencyPolicy", label: t("work:copy.theConcurrencyPolicy_f6cd91") });
    }
    if (editDraft.catchUpPolicy !== routineDefaults.catchUpPolicy) {
      result.push({ key: "catchUpPolicy", label: t("work:copy.theCatchUpPolicy_d4abae") });
    }
    if (editDraft.activityGatePolicy !== routineDefaults.activityGatePolicy) {
      result.push({ key: "activityGatePolicy", label: t("work:copy.theAdvancedRunPolicy_ea1331") });
    }
    if (editDraft.activityGateScope !== routineDefaults.activityGateScope) {
      result.push({ key: "activityGateScope", label: t("work:copy.theActivityGateScope_1f0144") });
    }
    if (JSON.stringify(editDraft.variables) !== JSON.stringify(routineDefaults.variables)) {
      result.push({ key: "variables", label: t("work:copy.theVariables_ee87e5") });
    }
    if (JSON.stringify(editDraft.env ?? null) !== JSON.stringify(routineDefaults.env ?? null)) {
      result.push({ key: "env", label: t("work:copy.theSecrets_b0cf29") });
    }
    return result;
  }, [editDraft, routineDefaults, t]);
  const isEditDirty = dirtyFields.length > 0;

  const sectionDirtyFields = useCallback(
    (target: RoutineSectionKey) => {
      const keys = SECTION_FIELD_KEYS[target];
      if (!keys) return [];
      return dirtyFields.filter((field) => keys.includes(field.key));
    },
    [dirtyFields, t],
  );
  const isSectionDirty = useCallback(
    (target: RoutineSectionKey) => sectionDirtyFields(target).length > 0,
    [sectionDirtyFields, t],
  );
  const discardSection = useCallback(
    (target: RoutineSectionKey) => {
      if (!routineDefaults) return;
      const keys = SECTION_FIELD_KEYS[target];
      if (!keys) return;
      setEditDraft((current) => {
        const next = { ...current } as Record<string, unknown>;
        for (const key of keys) {
          next[key] = (routineDefaults as Record<string, unknown>)[key];
        }
        return next as RoutineEditDraft;
      });
    },
    [routineDefaults, t],
  );

  useEffect(() => {
    if (!routine) return;
    if (!triggerSetup) setBreadcrumbs([{ label: t("work:copy.routines_61b7bb"), href: "/routines" }, { label: routine.title }]);
    if (!routineDefaults) return;
    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
    }
  }, [routine, routineDefaults, isEditDirty, setBreadcrumbs, triggerSetup, t]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, routine?.id]);

  useEffect(() => {
    if (section !== "overview") setOverviewEditing(false);
  }, [routineId, section]);

  const copySecretValue = useCallback(
    async (label: string, value: string) => {
      try {
        await copyTextToClipboard(value);
        pushToast({ title: t("work:extra.message_06d791026d", { value1: label }), tone: "success" });
      } catch (copyError) {
        pushToast({
          title: t("work:copy.failedToCopy_ef67b3", { value1: label.toLowerCase() }),
          body: describeError(copyError, { action: t("work:copy.copyToTheClipboard_0c2f35") }).body,
          tone: "error",
        });
      }
    },
    [pushToast, t],
  );

  const saveRoutine = useMutation({
    mutationFn: () => {
      const payload = buildRoutineMutationPayload(editDraft);
      const baseRevisionId = routine?.latestRevisionId ?? null;
      return routinesApi.update(routineId!, {
        ...payload,
        ...(baseRevisionId ? { baseRevisionId } : {}),
      });
    },
    onSuccess: async () => {
      setSaveConflict(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routineId!) }),
      ]);
    },
    onError: (mutationError) => {
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        setSaveConflict(true);
        pushToast({
          title: t("work:copy.routineChanged_cd400e"),
          body: t("work:copy.someoneElseUpdatedThisRoutineReloadToSeeThe_be054f"),
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: t("work:copy.failedToSaveRoutine_34cf35"),
        body: describeError(mutationError, { action: t("work:copy.saveTheRoutine_0cd92f") }).body,
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: (data?: RoutineRunDialogSubmitData) =>
      routinesApi.run(routineId!, {
        ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
        ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
        ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
        ...(data?.executionWorkspacePreference !== undefined
          ? { executionWorkspacePreference: data.executionWorkspacePreference }
          : {}),
        ...(data?.executionWorkspaceSettings !== undefined
          ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
          : {}),
      }),
    onSuccess: async () => {
      pushToast({ title: t("work:copy.routineRunStarted_89f08d"), tone: "success" });
      setRunVariablesOpen(false);
      navigateToSection("runs");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine", routineId!] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (runError) => {
      pushToast({
        title: t("work:copy.routineRunFailed_296c7c"),
        body: describeError(runError, { action: t("work:copy.startTheRoutineRun_b7d489") }).body,
        tone: "error",
      });
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: (status: string) => routinesApi.update(routineId!, { status }),
    onSuccess: async (_data, status) => {
      pushToast({
        title: t("work:copy.routineSaved_e522b3"),
        body: status === "paused" ? t("work:copy.automationPaused_9ac97b") : t("work:copy.automationEnabled_bd0845"),
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
      ]);
    },
    onError: (statusError) => {
      pushToast({
        title: t("work:copy.failedToUpdateRoutine_658553"),
        body: describeError(statusError, { action: t("work:copy.updateTheRoutine_b91df2") }).body,
        tone: "error",
      });
    },
  });

  const createTrigger = useMutation({
    mutationFn: async (): Promise<RoutineTriggerResponse> => {
      const existingOfKind = (routine?.triggers ?? []).filter((t) => t.kind === newTrigger.kind).length;
      const autoLabel = existingOfKind > 0 ? `${newTrigger.kind}-${existingOfKind + 1}` : newTrigger.kind;
      return routinesApi.createTrigger(routineId!, {
        kind: newTrigger.kind,
        label: autoLabel,
        ...(newTrigger.kind === "schedule"
          ? { cronExpression: newTrigger.cronExpression.trim(), timezone: getLocalTimezone() }
          : {}),
        ...(newTrigger.kind === "webhook"
          ? { signingMode: newTrigger.signingMode, replayWindowSec: Number(newTrigger.replayWindowSec || "300") }
          : {}),
      });
    },
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: t("work:copy.webhookTriggerCreated_ef8b55"),
          entries: [{ webhookUrl: result.secretMaterial.webhookUrl, webhookSecret: result.secretMaterial.webhookSecret }],
        });
      } else {
        pushToast({ title: t("work:copy.triggerAdded_bdfe6f"), body: t("work:copy.theRoutineScheduleWasSaved_8a3c9b"), tone: "success" });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: t("work:copy.failedToAddTrigger_3c4a07"),
        body: describeError(triggerError, { action: t("work:copy.createTheTrigger_800ccc") }).body,
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      pushToast({ title: t("work:copy.triggerSaved_85c8b3"), body: t("work:copy.theRoutineCadenceUpdateWasSaved_107e7f"), tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: t("work:copy.failedToUpdateTrigger_4707ca"),
        body: describeError(triggerError, { action: t("work:copy.updateTheTrigger_4347d3") }).body,
        tone: "error",
      });
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      pushToast({ title: t("work:copy.triggerDeleted_f05261"), tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: t("work:copy.failedToDeleteTrigger_86096d"),
        body: describeError(triggerError, { action: t("work:copy.deleteTheTrigger_03274f") }).body,
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: t("work:copy.webhookSecretRotated_7eeaca"),
        entries: [{ webhookUrl: result.secretMaterial.webhookUrl, webhookSecret: result.secretMaterial.webhookSecret }],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: t("work:copy.failedToRotateWebhookSecret_1caaab"),
        body: describeError(triggerError, { action: t("work:copy.rotateTheWebhookSecret_1c6f8b") }).body,
        tone: "error",
      });
    },
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents, t]);
  const projectById = useMemo(() => new Map((projects ?? []).map((project) => [project.id, project])), [projects, t]);
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [routine?.id, t]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [routine?.id, t]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds, t],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () => buildRoutineProjectOptions(projects ?? []),
    [projects, t],
  );
  const mentionOptions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({
      agents,
      projects: (projects ?? []).filter((project) => !project.archivedAt),
      members: companyMembers?.users,
    }),
    [agents, companyMembers?.users, projects, t],
  );

  // Wrap track-recent side-effects so the section components stay declarative.
  const setEditDraftTracked: typeof setEditDraft = useCallback((updater) => {
    setEditDraft((current) => {
      const next = typeof updater === "function" ? (updater as (c: RoutineEditDraft) => RoutineEditDraft)(current) : updater;
      if (next.assigneeAgentId && next.assigneeAgentId !== current.assigneeAgentId) {
        trackRecentAssignee(next.assigneeAgentId);
      }
      if (next.projectId && next.projectId !== current.projectId) {
        trackRecentProject(next.projectId);
      }
      return next;
    });
  }, [t]);

  const currentAssignee = editDraft.assigneeAgentId ? agentById.get(editDraft.assigneeAgentId) ?? null : null;
  const currentProject = editDraft.projectId ? projectById.get(editDraft.projectId) ?? null : null;

  const reloadLatest = useCallback(() => {
    setSaveConflict(false);
    if (routineDefaults) setEditDraft(routineDefaults);
    queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) });
  }, [queryClient, routineDefaults, routineId, t]);

  const onHistoryRestoreSecretMaterials = useCallback((response: RestoreRoutineRevisionResponse) => {
    if (response.secretMaterials.length > 0) {
      navigateToSection("triggers");
      setSecretMessage({
        title:
          response.secretMaterials.length === 1
            ? t("work:copy.webhookTriggerRestored_7450a8")
            : t("work:copy.webhookTriggersRestored_c4c167", { value1: response.secretMaterials.length }),
        entries: response.secretMaterials.map((recreated) => ({
          webhookUrl: recreated.webhookUrl,
          webhookSecret: recreated.webhookSecret,
        })),
      });
    }
  }, [navigateToSection, t]);

  const onHistoryRestored = useCallback(
    (response: RestoreRoutineRevisionResponse) => {
      setSaveConflict(false);
      queryClient.setQueryData<RoutineDetailType | undefined>(
        queryKeys.routines.detail(routineId!),
        (prev) =>
          prev
            ? {
                ...prev,
                ...response.routine,
                latestRevisionId: response.revision.id,
                latestRevisionNumber: response.revision.revisionNumber,
              }
            : prev,
      );
      setEditDraft({
        title: response.routine.title,
        description: response.routine.description ?? "",
        projectId: response.routine.projectId ?? "",
        assigneeAgentId: response.routine.assigneeAgentId ?? "",
        priority: response.routine.priority,
        concurrencyPolicy: response.routine.concurrencyPolicy,
        catchUpPolicy: response.routine.catchUpPolicy,
        activityGatePolicy: response.routine.activityGatePolicy,
        activityGateScope: response.routine.activityGateScope,
        variables: response.routine.variables as RoutineVariable[],
        env: (response.routine.env ?? null) as RoutineEnvConfig | null,
      });
      hydratedRoutineIdRef.current = response.routine.id;
    },
    [queryClient, routineId, t],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message={t("work:copy.selectAnOrganizationToViewRoutines_7b360f")} />;
  }

  const legacyTab = new URLSearchParams(window.location.search).get("tab");
  const validLegacySection = !streamlinedUiEnabled && (sectionParam === "runs" || sectionParam === "activity");
  if (routineId && (legacyTab || !sectionParam || (!isRoutineDetailView(sectionParam) && !validLegacySection))) {
    return (
      <Navigate
        to={resolveRoutineDetailDestination({ routineId, section: sectionParam, legacyTab })}
        replace
      />
    );
  }

  // Keep a loaded routine on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || routineView.kind === "reconnecting") {
    return <PageSkeleton variant="issues-list" />;
  }

  if (routineView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={routineView.error}
        action={t("work:copy.loadThisRoutine_5f7eec")}
        onRetry={routineView.retry}
        retrying={routineView.isFetching}
      />
    );
  }

  if (!routine || !routineDefaults) {
    return (
      <EmptyState
        icon={AlertCircle}
        message={t("work:copy.weCouldnTLoadThisRoutine_737c95")}
      />
    );
  }

  const automationEnabled = routine.status === "active";
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel =
    routine.status === "archived"
      ? t("work:copy.archived_bdb865")
      : !routine.assigneeAgentId
        ? t("work:copy.draft_ebf12e")
        : automationEnabled
          ? t("work:copy.active_923406")
          : t("work:copy.paused_e159b0");
  const automationLabelClassName =
    routine.status === "archived"
      ? "text-muted-foreground"
      : automationEnabled
        ? "text-emerald-400"
        : "text-muted-foreground";

  const contextValue: RoutineDetailContextValue = {
    routine,
    routineId: routineId!,
    companyId: routine.companyId,
    editDraft,
    setEditDraft: setEditDraftTracked,
    routineDefaults,
    dirtyFields,
    isEditDirty,
    sectionDirtyFields,
    isSectionDirty,
    discardSection,
    saveRoutine,
    saveConflict,
    reloadLatest,
    automationEnabled,
    automationLabel,
    automationLabelClassName,
    automationToggleDisabled,
    onToggleAutomation: () => {
      if (!automationEnabled && !routine.assigneeAgentId) {
        pushToast({
          title: t("work:copy.defaultAgentRequired_2761f3"),
          body: t("work:copy.setADefaultAgentBeforeEnablingRoutineAutomation_1885fd"),
          tone: "warn",
        });
        return;
      }
      updateRoutineStatus.mutate(automationEnabled ? "paused" : "active");
    },
    onOpenRunDialog: () => setRunVariablesOpen(true),
    runRoutinePending: runRoutine.isPending,
    newTrigger,
    setNewTrigger,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    rotateTrigger,
    secretMessage,
    setSecretMessage,
    copySecretValue,
    availableSecrets,
    createSecret,
    agents: agents ?? [],
    projects: projects ?? [],
    agentById,
    projectById,
    assigneeOptions,
    projectOptions,
    recentAssigneeIds,
    recentProjectIds,
    mentionOptions,
    currentAssignee,
    currentProject,
    routineRuns,
    activity,
    hasLiveRun,
    activeIssueId,
    titleInputRef,
    descriptionEditorRef,
    assigneeSelectorRef,
    projectSelectorRef,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
    navigateToSection,
  };

  if (triggerSetup) return <RoutineDetailContext.Provider value={contextValue}><TriggersSection /></RoutineDetailContext.Provider>;

  const isEditableSection = EDITABLE_SECTIONS.includes(section);

  return (
    <RoutineDetailContext.Provider value={contextValue}>
      <a
        href="#routine-section"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm"
      >{t("work:copy.skipToSection_7da8cf")}</a>

      {/* The global shell owns routine navigation. This surface keeps one
          content scroll owner and a compact action header. */}
      <div className="-m-4 flex h-full min-h-0 overflow-hidden md:-m-6">
        {!streamlinedUiEnabled ? (
          <RoutineSubSidebar
            activeSection={section}
            hrefFor={(next) => next === "runs" || next === "activity"
              ? `/routines/${routine.id}/${next}`
              : routineDetailHref(routine.id, next)}
            isSectionDirty={isSectionDirty}
            hasLiveRun={hasLiveRun}
            onNavigate={navigateToSection}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!streamlinedUiEnabled ? (
          <RoutineSectionPicker
            activeSection={section}
            onNavigate={navigateToSection}
            isSectionDirty={isSectionDirty}
          />
        ) : null}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-2 md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {section === "overview" && overviewEditing ? (
              <textarea
                ref={titleInputRef}
                data-autosize-title
                className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-base font-semibold leading-7 outline-none placeholder:text-muted-foreground/50"
                placeholder={t("work:copy.routineTitle_26d0f8")}
                rows={1}
                value={editDraft.title}
                onChange={(event) => {
                  setEditDraft((current) => ({ ...current, title: event.target.value }));
                  autoResizeTextarea(event.target);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    descriptionEditorRef.current?.focus();
                  }
                }}
              />
            ) : (
              <h1 className="min-w-0 flex-1 truncate text-xl font-bold">{routine.title}</h1>
            )}
            {routine.managedByPlugin ? (
              <Badge variant="outline" className="hidden shrink-0 gap-1.5 text-xs text-muted-foreground sm:inline-flex">
                <Sparkles className="h-3 w-3" />
                {routine.managedByPlugin.pluginDisplayName}
                <span className="font-mono text-(length:--text-nano)">{routine.managedByPlugin.resourceKey}</span>
              </Badge>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {section === "history" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(routineDetailHref(routine.id))}
              >{t("work:copy.backToOverview_b20218")}</Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(routineDetailHref(routine.id, "history"))}
              >
                <History className="h-3.5 w-3.5" />{t("work:copy.history_0e7696")}</Button>
            )}
            {section === "overview" ? (
              overviewEditing ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    discardSection("overview");
                    setOverviewEditing(false);
                  }}
                >
                  <X className="h-3.5 w-3.5" />{t("work:copy.cancelEditing_d07a5a")}</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setOverviewEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />{t("work:copy.editRoutine_801e27")}</Button>
              )
            ) : null}
            <RunButton onClick={() => setRunVariablesOpen(true)} disabled={runRoutine.isPending} />
            <div className="flex items-center gap-2">
              <ToggleSwitch
                size="default"
                checked={automationEnabled}
                onCheckedChange={contextValue.onToggleAutomation}
                disabled={automationToggleDisabled}
                aria-label={automationEnabled ? t("work:copy.pauseAutomaticTriggers_0231db") : t("work:copy.enableAutomaticTriggers_caf197")}
              />
              <span className={`text-sm font-medium ${automationLabelClassName}`}>{automationLabel}</span>
            </div>
          </div>
        </header>

        <main
          id="routine-section"
          role="main"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 pt-8 md:px-8"
        >
          <section
            aria-labelledby="routine-section-title"
            className={
              section === "overview" && !overviewEditing
                ? "mx-auto w-full max-w-5xl"
                : isEditableSection
                  ? "mx-auto w-full max-w-3xl"
                  : "w-full"
            }
          >
            <RoutineSectionHeading
              title={SECTION_TITLES[section]}
              copyText={section === "overview"
                ? routineOverviewCopyText({
                    editing: overviewEditing,
                    draft: editDraft.description,
                    saved: routine.description,
                  })
                : null}
            />

            {section === "overview" && (overviewEditing ? <OverviewSection /> : <RoutineOverview />)}
            {section === "triggers" && <TriggersSection />}
            {section === "variables" && <VariablesSection />}
            {section === "secrets" && <SecretsSection />}
            {section === "delivery" && <DeliverySection />}
            {section === "runs" && <RunsSection />}
            {section === "activity" && (
              <ActivitySection
                isLoading={activityView.kind === "loading" || activityView.kind === "reconnecting"}
                error={activityView.kind === "error" ? activityView.error : null}
                onRetry={activityView.retry}
                retrying={activityView.isFetching}
              />
            )}
            {section === "history" && <HistorySection />}

            {isEditableSection && (section !== "overview" || overviewEditing) ? (
              <RoutineSaveBar
                dirtyFields={sectionDirtyFields(section)}
                isSaving={saveRoutine.isPending}
                saveConflict={saveConflict}
                onSave={() => {
                  if (!saveRoutine.isPending && editDraft.title.trim()) saveRoutine.mutate();
                }}
                onDiscard={() => discardSection(section)}
                onReload={reloadLatest}
              />
            ) : null}
          </section>
        </main>
        </div>
      </div>

      <RoutineRunVariablesDialog
        open={runVariablesOpen}
        onOpenChange={setRunVariablesOpen}
        companyId={routine.companyId}
        routineName={routine.title}
        agents={agents ?? []}
        projects={projects ?? []}
        defaultProjectId={routine.projectId}
        defaultAssigneeAgentId={routine.assigneeAgentId}
        variables={routine.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => runRoutine.mutate(data)}
      />
    </RoutineDetailContext.Provider>
  );
}
