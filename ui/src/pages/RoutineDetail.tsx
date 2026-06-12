import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Repeat, Sparkles } from "lucide-react";
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
import { queryKeys } from "../lib/queryKeys";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
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
import {
  RoutineSubSidebar,
  RoutineSectionPicker,
} from "../components/RoutineSubSidebar";
import { RoutineSaveBar } from "../components/RoutineSaveBar";
import {
  EDITABLE_SECTIONS,
  ROUTINE_SECTION_KEYS,
  SECTION_FIELD_KEYS,
  RoutineDetailContext,
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
  RunsSection,
  ActivitySection,
  HistorySection,
} from "../components/routine-sections/operate-sections";
import type {
  RoutineDetail as RoutineDetailType,
  RoutineEnvConfig,
  RoutineVariable,
} from "@paperclipai/shared";

const LAST_SECTION_STORAGE_KEY = "paperclip.routineLastSection";

const SECTION_TITLES: Record<RoutineSectionKey, string> = {
  overview: "Overview",
  triggers: "Triggers",
  variables: "Variables",
  secrets: "Secrets",
  delivery: "Delivery",
  runs: "Runs",
  activity: "Activity",
  history: "History",
};

function isRoutineSection(value: string | undefined | null): value is RoutineSectionKey {
  return value != null && ROUTINE_SECTION_KEYS.includes(value as RoutineSectionKey);
}

function readLastSection(routineId: string): RoutineSectionKey | null {
  try {
    const raw = localStorage.getItem(LAST_SECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const stored = parsed[routineId];
    return isRoutineSection(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeLastSection(routineId: string, section: RoutineSectionKey) {
  try {
    const raw = localStorage.getItem(LAST_SECTION_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    parsed[routineId] = section;
    localStorage.setItem(LAST_SECTION_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore storage failures */
  }
}

/** Back-compat: `?tab=x` query param maps to the new section sub-routes. */
const LEGACY_TAB_TO_SECTION: Record<string, RoutineSectionKey> = {
  triggers: "triggers",
  runs: "runs",
  activity: "activity",
  secrets: "secrets",
  history: "history",
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
  const { routineId, section: sectionParam } = useParams<{ routineId: string; section?: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [runVariablesOpen, setRunVariablesOpen] = useState(false);
  const [newTrigger, setNewTrigger] = useState({
    kind: "schedule",
    cronExpression: "0 10 * * *",
    signingMode: "bearer",
    replayWindowSec: "300",
  });
  const [editDraft, setEditDraft] = useState<RoutineEditDraft>({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    env: null,
  });

  const section: RoutineSectionKey = isRoutineSection(sectionParam) ? sectionParam : "overview";

  const navigateToSection = useCallback(
    (next: RoutineSectionKey, options?: { replace?: boolean }) => {
      if (!routineId) return;
      writeLastSection(routineId, next);
      navigate(`/routines/${routineId}/${next}`, { replace: options?.replace ?? true });
    },
    [navigate, routineId],
  );

  const { data: routine, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.detail(routineId!),
    queryFn: () => routinesApi.get(routineId!),
    enabled: !!routineId,
  });
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
    [routine?.triggers, routineRuns],
  );
  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.routines.activity(selectedCompanyId!, routineId!),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => routinesApi.activity(selectedCompanyId!, routineId!, relatedActivityIds),
    enabled: !!selectedCompanyId && !!routineId && !!routine,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
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
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
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
            variables: routine.variables,
            env: routine.env ?? null,
          }
        : null,
    [routine],
  );
  const dirtyFields = useMemo<RoutineHistoryDirtyFieldDescriptor[]>(() => {
    if (!routineDefaults) return [];
    const result: RoutineHistoryDirtyFieldDescriptor[] = [];
    if (editDraft.title !== routineDefaults.title) result.push({ key: "title", label: "the title" });
    if (editDraft.description !== routineDefaults.description) {
      result.push({ key: "description", label: "the description" });
    }
    if (editDraft.projectId !== routineDefaults.projectId) {
      result.push({ key: "projectId", label: "the project" });
    }
    if (editDraft.assigneeAgentId !== routineDefaults.assigneeAgentId) {
      result.push({ key: "assigneeAgentId", label: "the default agent" });
    }
    if (editDraft.priority !== routineDefaults.priority) {
      result.push({ key: "priority", label: "the priority" });
    }
    if (editDraft.concurrencyPolicy !== routineDefaults.concurrencyPolicy) {
      result.push({ key: "concurrencyPolicy", label: "the concurrency policy" });
    }
    if (editDraft.catchUpPolicy !== routineDefaults.catchUpPolicy) {
      result.push({ key: "catchUpPolicy", label: "the catch-up policy" });
    }
    if (JSON.stringify(editDraft.variables) !== JSON.stringify(routineDefaults.variables)) {
      result.push({ key: "variables", label: "the variables" });
    }
    if (JSON.stringify(editDraft.env ?? null) !== JSON.stringify(routineDefaults.env ?? null)) {
      result.push({ key: "env", label: "the secrets" });
    }
    return result;
  }, [editDraft, routineDefaults]);
  const isEditDirty = dirtyFields.length > 0;

  const sectionDirtyFields = useCallback(
    (target: RoutineSectionKey) => {
      const keys = SECTION_FIELD_KEYS[target];
      if (!keys) return [];
      return dirtyFields.filter((field) => keys.includes(field.key));
    },
    [dirtyFields],
  );
  const isSectionDirty = useCallback(
    (target: RoutineSectionKey) => sectionDirtyFields(target).length > 0,
    [sectionDirtyFields],
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
    [routineDefaults],
  );

  useEffect(() => {
    if (!routine) return;
    setBreadcrumbs([{ label: "Routines", href: "/routines" }, { label: routine.title }]);
    if (!routineDefaults) return;
    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
    }
  }, [routine, routineDefaults, isEditDirty, setBreadcrumbs]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, routine?.id]);

  // Persist the section the user lands on so a bare /routines/:id remembers it.
  useEffect(() => {
    if (routineId && isRoutineSection(sectionParam)) {
      writeLastSection(routineId, sectionParam);
    }
  }, [routineId, sectionParam]);

  const copySecretValue = useCallback(
    async (label: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        pushToast({ title: `${label} copied`, tone: "success" });
      } catch (copyError) {
        pushToast({
          title: `Failed to copy ${label.toLowerCase()}`,
          body: copyError instanceof Error ? copyError.message : "Clipboard access was denied.",
          tone: "error",
        });
      }
    },
    [pushToast],
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
          title: "Routine changed",
          body: "Someone else updated this routine. Reload to see the latest revision.",
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: "Failed to save routine",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not save the routine.",
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
      pushToast({ title: "Routine run started", tone: "success" });
      setRunVariablesOpen(false);
      navigateToSection("runs");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (runError) => {
      pushToast({
        title: "Routine run failed",
        body: runError instanceof Error ? runError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: (status: string) => routinesApi.update(routineId!, { status }),
    onSuccess: async (_data, status) => {
      pushToast({
        title: "Routine saved",
        body: status === "paused" ? "Automation paused." : "Automation enabled.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
      ]);
    },
    onError: (statusError) => {
      pushToast({
        title: "Failed to update routine",
        body: statusError instanceof Error ? statusError.message : "Paperclip could not update the routine.",
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
          title: "Webhook trigger created",
          entries: [{ webhookUrl: result.secretMaterial.webhookUrl, webhookSecret: result.secretMaterial.webhookSecret }],
        });
      } else {
        pushToast({ title: "Trigger added", body: "The routine schedule was saved.", tone: "success" });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: "Failed to add trigger",
        body: triggerError instanceof Error ? triggerError.message : "Paperclip could not create the trigger.",
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      pushToast({ title: "Trigger saved", body: "The routine cadence update was saved.", tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: "Failed to update trigger",
        body: triggerError instanceof Error ? triggerError.message : "Paperclip could not update the trigger.",
        tone: "error",
      });
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      pushToast({ title: "Trigger deleted", tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: "Failed to delete trigger",
        body: triggerError instanceof Error ? triggerError.message : "Paperclip could not delete the trigger.",
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        entries: [{ webhookUrl: result.secretMaterial.webhookUrl, webhookSecret: result.secretMaterial.webhookSecret }],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (triggerError) => {
      pushToast({
        title: "Failed to rotate webhook secret",
        body: triggerError instanceof Error ? triggerError.message : "Paperclip could not rotate the webhook secret.",
        tone: "error",
      });
    },
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map((projects ?? []).map((project) => [project.id, project])), [projects]);
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [routine?.id]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [routine?.id]);
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
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const mentionOptions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({ agents, projects, members: companyMembers?.users }),
    [agents, companyMembers?.users, projects],
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
  }, []);

  const currentAssignee = editDraft.assigneeAgentId ? agentById.get(editDraft.assigneeAgentId) ?? null : null;
  const currentProject = editDraft.projectId ? projectById.get(editDraft.projectId) ?? null : null;

  const reloadLatest = useCallback(() => {
    setSaveConflict(false);
    if (routineDefaults) setEditDraft(routineDefaults);
    queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) });
  }, [queryClient, routineDefaults, routineId]);

  const onHistoryRestoreSecretMaterials = useCallback((response: RestoreRoutineRevisionResponse) => {
    if (response.secretMaterials.length > 0) {
      setSecretMessage({
        title:
          response.secretMaterials.length === 1
            ? "Webhook trigger restored"
            : `${response.secretMaterials.length} webhook triggers restored`,
        entries: response.secretMaterials.map((recreated) => ({
          webhookUrl: recreated.webhookUrl,
          webhookSecret: recreated.webhookSecret,
        })),
      });
    }
  }, []);

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
        variables: response.routine.variables as RoutineVariable[],
        env: (response.routine.env ?? null) as RoutineEnvConfig | null,
      });
      hydratedRoutineIdRef.current = response.routine.id;
    },
    [queryClient, routineId],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  // Back-compat redirect: `?tab=x` → `/routines/:id/x`.
  const legacyTab = new URLSearchParams(window.location.search).get("tab");
  if (routineId && legacyTab && LEGACY_TAB_TO_SECTION[legacyTab]) {
    return <Navigate to={`/routines/${routineId}/${LEGACY_TAB_TO_SECTION[legacyTab]}`} replace />;
  }

  // Bare /routines/:id → remembered section or overview.
  if (routineId && !sectionParam) {
    const landing = readLastSection(routineId) ?? "overview";
    return <Navigate to={`/routines/${routineId}/${landing}`} replace />;
  }
  // Unknown section → overview.
  if (routineId && sectionParam && !isRoutineSection(sectionParam)) {
    return <Navigate to={`/routines/${routineId}/overview`} replace />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !routine || !routineDefaults) {
    return (
      <EmptyState
        icon={AlertCircle}
        message={error instanceof Error ? error.message : "We couldn't load this routine."}
      />
    );
  }

  const automationEnabled = routine.status === "active";
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel =
    routine.status === "archived"
      ? "Archived"
      : !routine.assigneeAgentId
        ? "Draft"
        : automationEnabled
          ? "Active"
          : "Paused";
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
          title: "Default agent required",
          body: "Set a default agent before enabling routine automation.",
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

  const isEditableSection = EDITABLE_SECTIONS.includes(section);

  return (
    <RoutineDetailContext.Provider value={contextValue}>
      <a
        href="#routine-section"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm"
      >
        Skip to section
      </a>

      <div className="-m-4 flex min-h-full flex-col md:-m-6">
        {/* Slim page header — scrolls with the page (not sticky) */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <textarea
              ref={titleInputRef}
              data-autosize-title
              className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-base font-semibold leading-7 outline-none placeholder:text-muted-foreground/50"
              placeholder="Routine title"
              rows={1}
              value={editDraft.title}
              onChange={(event) => {
                setEditDraft((current) => ({ ...current, title: event.target.value }));
                autoResizeTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (section === "overview") {
                    descriptionEditorRef.current?.focus();
                  } else {
                    navigateToSection("overview");
                  }
                }
              }}
            />
            {routine.managedByPlugin ? (
              <Badge variant="outline" className="hidden shrink-0 gap-1.5 text-xs text-muted-foreground sm:inline-flex">
                <Sparkles className="h-3 w-3" />
                {routine.managedByPlugin.pluginDisplayName}
                <span className="font-mono text-[10px]">{routine.managedByPlugin.resourceKey}</span>
              </Badge>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <RunButton onClick={() => setRunVariablesOpen(true)} disabled={runRoutine.isPending} />
            <div className="flex items-center gap-2">
              <ToggleSwitch
                size="default"
                checked={automationEnabled}
                onCheckedChange={contextValue.onToggleAutomation}
                disabled={automationToggleDisabled}
                aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
              />
              <span className={`text-sm font-medium ${automationLabelClassName}`}>{automationLabel}</span>
            </div>
          </div>
        </header>

        {/* Mobile section picker */}
        <RoutineSectionPicker
          activeSection={section}
          onNavigate={navigateToSection}
          isSectionDirty={isSectionDirty}
        />

        <div className="flex min-h-0 flex-1">
          <RoutineSubSidebar
            activeSection={section}
            hrefFor={(target) => `/routines/${routineId}/${target}`}
            isSectionDirty={isSectionDirty}
            hasLiveRun={hasLiveRun}
            onNavigate={(target) => writeLastSection(routineId!, target)}
          />

          <main
            id="routine-section"
            role="main"
            className="min-w-0 flex-1 px-4 pb-6 pt-10 md:px-8"
          >
            <section
              aria-labelledby="routine-section-title"
              className={isEditableSection ? "mx-auto w-full max-w-3xl" : "w-full"}
            >
              <h2 id="routine-section-title" className="mb-4 text-lg font-semibold">
                {SECTION_TITLES[section]}
              </h2>

              {section === "overview" && <OverviewSection />}
              {section === "triggers" && <TriggersSection />}
              {section === "variables" && <VariablesSection />}
              {section === "secrets" && <SecretsSection />}
              {section === "delivery" && <DeliverySection />}
              {section === "runs" && <RunsSection />}
              {section === "activity" && <ActivitySection />}
              {section === "history" && <HistorySection />}

              {isEditableSection ? (
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
