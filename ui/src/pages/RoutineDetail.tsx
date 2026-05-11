import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  History as HistoryIcon,
  Play,
  Plus,
  Repeat,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { ApiError } from "../api/client";
import { routinesApi, type RoutineTriggerResponse, type RotateRoutineTriggerResponse, type RestoreRoutineRevisionResponse } from "../api/routines";
import { TriggerListCard } from "../components/TriggerListCard";
import { TriggerDialog } from "../components/TriggerDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  RoutineHistoryTab,
  type RoutineHistoryDirtyFieldDescriptor,
} from "../components/RoutineHistoryTab";
import { heartbeatsApi } from "../api/heartbeats";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { usePanel } from "../context/PanelContext";
import { useToastActions } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "../components/MarkdownEditor";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { RunButton } from "../components/AgentActionButtons";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { RoutineDetail as RoutineDetailType, RoutineTrigger, RoutineVariable } from "@paperclipai/shared";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const routineTabs = ["triggers", "runs", "activity", "history"] as const;
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the routine is already active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the routine or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};

type RoutineTab = (typeof routineTabs)[number];

type SecretMessage = {
  title: string;
  entries: Array<{
    webhookUrl: string;
    webhookSecret: string;
  }>;
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function isRoutineTab(value: string | null): value is RoutineTab {
  return value !== null && routineTabs.includes(value as RoutineTab);
}

function getRoutineTabFromSearch(search: string): RoutineTab {
  const tab = new URLSearchParams(search).get("tab");
  return isRoutineTab(tab) ? tab : "triggers";
}

function formatActivityDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatActivityDetailValue(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function buildRoutineMutationPayload(input: {
  title: string;
  description: string;
  projectId: string;
  assigneeAgentId: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
}) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    assigneeAgentId: input.assigneeAgentId || null,
  };
}

export function RoutineDetail() {
  const { routineId } = useParams<{ routineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [runVariablesOpen, setRunVariablesOpen] = useState(false);
  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<RoutineTrigger | null>(null);
  const [triggerPendingDelete, setTriggerPendingDelete] = useState<RoutineTrigger | null>(null);
  const [togglingTriggerId, setTogglingTriggerId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    title: string;
    description: string;
    projectId: string;
    assigneeAgentId: string;
    priority: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    variables: RoutineVariable[];
  }>({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
  });
  const activeTab = useMemo(() => getRoutineTabFromSearch(location.search), [location.search]);

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

  const routineDefaults = useMemo(
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
    return result;
  }, [editDraft, routineDefaults]);
  const isEditDirty = dirtyFields.length > 0;

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

  const copySecretValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ title: `${label} copied`, tone: "success" });
    } catch (error) {
      pushToast({
        title: `Failed to copy ${label.toLowerCase()}`,
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  const setActiveTab = useCallback((value: string) => {
    if (!routineId || !isRoutineTab(value)) return;
    const params = new URLSearchParams(location.search);
    if (value === "triggers") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate, routineId]);

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
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
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
        body: error instanceof Error ? error.message : "Paperclip could not save the routine.",
        tone: "error",
      });
    },
  });
  const saveRoutineRef = useRef(saveRoutine);

  useEffect(() => {
    saveRoutineRef.current = saveRoutine;
  }, [saveRoutine]);

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
      setActiveTab("runs");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Routine run failed",
        body: error instanceof Error ? error.message : "Paperclip could not start the routine run.",
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
    onError: (error) => {
      pushToast({
        title: "Failed to update routine",
        body: error instanceof Error ? error.message : "Paperclip could not update the routine.",
        tone: "error",
      });
    },
  });

  const createTrigger = useMutation({
    mutationFn: async (body: Record<string, unknown>): Promise<RoutineTriggerResponse> => {
      // Auto-label when the caller didn't provide one (e.g. dialog left the
      // Label field blank). Keeps the existing "schedule-2"-style numbering
      // behaviour so existing routines keep unique-ish labels.
      const kind = String(body.kind ?? "schedule");
      const trimmedLabel = typeof body.label === "string" ? body.label.trim() : "";
      let finalLabel: string;
      if (trimmedLabel.length > 0 && trimmedLabel !== kind) {
        finalLabel = trimmedLabel;
      } else {
        const existingOfKind = (routine?.triggers ?? []).filter((t) => t.kind === kind).length;
        finalLabel = existingOfKind > 0 ? `${kind}-${existingOfKind + 1}` : kind;
      }
      return routinesApi.createTrigger(routineId!, { ...body, label: finalLabel });
    },
    onSuccess: async (result) => {
      setTriggerDialogOpen(false);
      if (result.secretMaterial) {
        setSecretMessage({
          title: "Webhook trigger created",
          entries: [{
            webhookUrl: result.secretMaterial.webhookUrl,
            webhookSecret: result.secretMaterial.webhookSecret,
          }],
        });
      } else {
        pushToast({
          title: "Trigger added",
          body: "The routine schedule was saved.",
          tone: "success",
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to add trigger",
        body: error instanceof Error ? error.message : "Paperclip could not create the trigger.",
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      pushToast({
        title: "Trigger saved",
        tone: "success",
      });
      setTriggerDialogOpen(false);
      setEditingTrigger(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update trigger",
        body: error instanceof Error ? error.message : "Paperclip could not update the trigger.",
        tone: "error",
      });
    },
    onSettled: () => {
      setTogglingTriggerId(null);
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      pushToast({
        title: "Trigger deleted",
        tone: "success",
      });
      setTriggerPendingDelete(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete trigger",
        body: error instanceof Error ? error.message : "Paperclip could not delete the trigger.",
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        entries: [{
          webhookUrl: result.secretMaterial.webhookUrl,
          webhookSecret: result.secretMaterial.webhookSecret,
        }],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rotate webhook secret",
        body: error instanceof Error ? error.message : "Paperclip could not rotate the webhook secret.",
        tone: "error",
      });
    },
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
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
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, projects]);
  const currentAssignee = editDraft.assigneeAgentId ? agentById.get(editDraft.assigneeAgentId) ?? null : null;
  const currentProject = editDraft.projectId ? projectById.get(editDraft.projectId) ?? null : null;

  const activityTabsPanel = useMemo(() => {
    if (!routine) return null;
    return (
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="triggers" className="gap-1.5">
            <Clock3 className="h-3.5 w-3.5" />
            Triggers
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <Play className="h-3.5 w-3.5" />
            Runs
            {hasLiveRun && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <HistoryIcon className="h-3.5 w-3.5" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="triggers" className="space-y-4">
          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setEditingTrigger(null);
              setTriggerDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add trigger
          </Button>

          {routine.triggers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center">
              <p className="text-sm font-medium">No triggers yet</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Triggers fire this routine on a schedule or via webhook.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setEditingTrigger(null);
                  setTriggerDialogOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add your first trigger
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {routine.triggers.map((trigger) => (
                <TriggerListCard
                  key={trigger.id}
                  trigger={trigger}
                  onEdit={() => {
                    setEditingTrigger(trigger);
                    setTriggerDialogOpen(true);
                  }}
                  onDelete={() => setTriggerPendingDelete(trigger)}
                  onToggleEnabled={(enabled) => {
                    setTogglingTriggerId(trigger.id);
                    updateTrigger.mutate({ id: trigger.id, patch: { enabled } });
                  }}
                  onRotateSecret={
                    trigger.kind === "webhook"
                      ? () => rotateTrigger.mutate(trigger.id)
                      : undefined
                  }
                  togglePending={togglingTriggerId === trigger.id}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="runs" className="space-y-4">
          {hasLiveRun && activeIssueId && routine && (
            <LiveRunWidget issueId={activeIssueId} companyId={routine.companyId} />
          )}
          {(routineRuns ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(routineRuns ?? []).map((run) => (
                <div key={run.id} className="flex flex-col gap-1.5 px-3 py-2 text-sm min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="text-[11px]">{run.source}</Badge>
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"} className="text-[11px]">
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  {(run.trigger || run.linkedIssue) && (
                    <div className="flex items-center gap-1.5 flex-wrap text-xs min-w-0">
                      {run.trigger && (
                        <span className="text-muted-foreground truncate">{run.trigger.label ?? run.trigger.kind}</span>
                      )}
                      {run.linkedIssue && (
                        <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="text-muted-foreground hover:underline truncate">
                          {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                        </Link>
                      )}
                    </div>
                  )}
                  <span className="text-[11px] text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {(activity ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(activity ?? []).map((event) => (
                <div key={event.id} className="flex flex-col gap-1 px-3 py-2 text-xs min-w-0">
                  <span className="font-medium text-foreground/90">{event.action.replaceAll(".", " ")}</span>
                  {event.details && Object.keys(event.details).length > 0 && (
                    <div className="text-muted-foreground break-words">
                      {Object.entries(event.details).slice(0, 3).map(([key, value], i) => (
                        <span key={key}>
                          {i > 0 && <span className="mx-1 text-border">·</span>}
                          <span className="text-muted-foreground/70">{key.replaceAll("_", " ")}:</span>{" "}
                          {formatActivityDetailValue(value)}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="text-muted-foreground/60">{timeAgo(event.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history">
          <RoutineHistoryTab
            routine={routine}
            isEditDirty={isEditDirty}
            dirtyFields={dirtyFields}
            onDiscardEdits={() => {
              if (routineDefaults) setEditDraft(routineDefaults);
            }}
            onSaveEdits={() => {
              const currentSave = saveRoutineRef.current;
              if (!currentSave.isPending && editDraft.title.trim()) {
                currentSave.mutate();
              }
            }}
            agents={agentById}
            projects={projectById}
            onRestoreSecretMaterials={(response: RestoreRoutineRevisionResponse) => {
              if (response.secretMaterials.length > 0) {
                setSecretMessage({
                  title: response.secretMaterials.length === 1
                    ? "Webhook trigger restored"
                    : `${response.secretMaterials.length} webhook triggers restored`,
                  entries: response.secretMaterials.map((recreated) => ({
                    webhookUrl: recreated.webhookUrl,
                    webhookSecret: recreated.webhookSecret,
                  })),
                });
              }
            }}
            onRestored={(response: RestoreRoutineRevisionResponse) => {
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
                variables: response.routine.variables,
              });
              hydratedRoutineIdRef.current = response.routine.id;
            }}
          />
        </TabsContent>
      </Tabs>
    );
  }, [
    activeIssueId,
    activeTab,
    activity,
    agentById,
    dirtyFields,
    editDraft.title,
    hasLiveRun,
    isEditDirty,
    projectById,
    queryClient,
    rotateTrigger.mutate,
    routine,
    routineDefaults,
    routineRuns,
    routineId,
    setActiveTab,
    togglingTriggerId,
    updateTrigger.mutate,
  ]);

  useEffect(() => {
    if (!activityTabsPanel) {
      closePanel();
      return;
    }
    openPanel(activityTabsPanel);
    return () => closePanel();
  }, [activityTabsPanel, closePanel, openPanel]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !routine) {
    return (
      <p className="pt-6 text-sm text-destructive">
        {error instanceof Error ? error.message : "Routine not found"}
      </p>
    );
  }

  const automationEnabled = routine.status === "active";
  const selectedProject = routine.projectId ? (projects?.find((project) => project.id === routine.projectId) ?? null) : null;
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel = routine.status === "archived"
    ? "Archived"
    : !routine.assigneeAgentId
      ? "Draft"
      : automationEnabled
        ? "Active"
        : "Paused";
  const automationLabelClassName = routine.status === "archived"
    ? "text-muted-foreground"
    : automationEnabled
      ? "text-emerald-400"
      : "text-muted-foreground";

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header: editable title + actions */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <textarea
            ref={titleInputRef}
            className="w-full resize-none overflow-hidden bg-transparent text-xl font-bold outline-none placeholder:text-muted-foreground/50"
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
                descriptionEditorRef.current?.focus();
                return;
              }
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                if (editDraft.assigneeAgentId) {
                  if (editDraft.projectId) {
                    descriptionEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                } else {
                  assigneeSelectorRef.current?.focus();
                }
              }
            }}
          />
          {routine.managedByPlugin ? (
            <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
              Managed by {routine.managedByPlugin.pluginDisplayName}
              <span className="font-mono text-[10px]">{routine.managedByPlugin.resourceKey}</span>
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <RunButton
            onClick={() => {
              setRunVariablesOpen(true);
            }}
            disabled={runRoutine.isPending}
          />
          <ToggleSwitch
            size="lg"
            checked={automationEnabled}
            onCheckedChange={() => {
              if (!automationEnabled && !routine.assigneeAgentId) {
                pushToast({
                  title: "Default agent required",
                  body: "Set a default agent before enabling routine automation.",
                  tone: "warn",
                });
                return;
              }
              updateRoutineStatus.mutate(automationEnabled ? "paused" : "active");
            }}
            disabled={automationToggleDisabled}
            aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
          />
          <span className={`min-w-[3.75rem] text-sm font-medium ${automationLabelClassName}`}>
            {automationLabel}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "hidden md:inline-flex shrink-0 transition-opacity duration-200",
              panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
            )}
            onClick={() => setPanelVisible(true)}
            title="Show triggers, runs and activity"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Secret message banner */}
      {secretMessage && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-3 text-sm">
          <div>
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">Save this now. Paperclip will not show the secret value again.</p>
          </div>
          <div className="space-y-3">
            {secretMessage.entries.map((entry, index) => (
              <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
                {secretMessage.entries.length > 1 && (
                  <p className="text-xs font-medium text-muted-foreground">
                    Webhook trigger {index + 1} of {secretMessage.entries.length}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookUrl} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook URL", entry.webhookUrl)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    URL
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookSecret} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue("Webhook secret", entry.webhookSecret)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Secret
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Save conflict banner */}
      {saveConflict && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="font-medium text-amber-200">Out of date</p>
              <p className="text-xs text-muted-foreground">
                This routine changed while you were editing. Reload to merge the latest revision before
                saving again.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSaveConflict(false);
                  if (routineDefaults) {
                    setEditDraft(routineDefaults);
                  }
                  queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) });
                }}
              >
                Reload latest
              </Button>
            </div>
          </div>
        </div>
      )}

      {!routine.assigneeAgentId ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-900 dark:text-amber-200">
          Default agent required. This routine can stay as a draft and still run manually, but automation stays paused until you assign a default agent.
        </div>
      ) : null}

      {/* Assignment row */}
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span>For</span>
          <InlineEntitySelector
            ref={assigneeSelectorRef}
            value={editDraft.assigneeAgentId}
            options={assigneeOptions}
            recentOptionIds={recentAssigneeIds}
            placeholder="Assignee"
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={(assigneeAgentId) => {
              if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
              setEditDraft((current) => ({ ...current, assigneeAgentId }));
            }}
            onConfirm={() => {
              if (editDraft.projectId) {
                descriptionEditorRef.current?.focus();
              } else {
                projectSelectorRef.current?.focus();
              }
            }}
            renderTriggerValue={(option) =>
              option ? (
                currentAssignee ? (
                  <>
                    <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{option.label}</span>
                  </>
                ) : (
                  <span className="truncate">{option.label}</span>
                )
              ) : (
                <span className="text-muted-foreground">Assignee</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const assignee = agentById.get(option.id);
              return (
                <>
                  {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>in</span>
          <InlineEntitySelector
            ref={projectSelectorRef}
            value={editDraft.projectId}
            options={projectOptions}
            recentOptionIds={recentProjectIds}
            placeholder="Project"
            noneLabel="No project"
            searchPlaceholder="Search projects..."
            emptyMessage="No projects found."
            onChange={(projectId) => {
              if (projectId) trackRecentProject(projectId);
              setEditDraft((current) => ({ ...current, projectId }));
            }}
            onConfirm={() => descriptionEditorRef.current?.focus()}
            renderTriggerValue={(option) =>
              option && currentProject ? (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Project</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const project = projectById.get(option.id);
              return (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: project?.color ?? "#64748b" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        </div>
      </div>

      {/* Instructions */}
      <MarkdownEditor
        ref={descriptionEditorRef}
        value={editDraft.description}
        onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
        placeholder="Add instructions..."
        bordered={false}
        contentClassName="min-h-[120px] text-[15px] leading-7"
        mentions={mentionOptions}
        onSubmit={() => {
          if (!saveRoutine.isPending && editDraft.title.trim()) {
            saveRoutine.mutate();
          }
        }}
      />
      <RoutineVariablesHint />
      <RoutineVariablesEditor
        title={editDraft.title}
        description={editDraft.description}
        value={editDraft.variables}
        onChange={(variables) => setEditDraft((current) => ({ ...current, variables }))}
      />

      {/* Advanced delivery settings */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
          <span className="text-sm font-medium">Advanced delivery settings</span>
          {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Concurrency</p>
              <Select
                value={editDraft.concurrencyPolicy}
                onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {concurrencyPolicies.map((value) => (
                    <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[editDraft.concurrencyPolicy]}</p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Catch-up</p>
              <Select
                value={editDraft.catchUpPolicy}
                onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catchUpPolicies.map((value) => (
                    <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{catchUpPolicyDescriptions[editDraft.catchUpPolicy]}</p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Save bar */}
      <div className="flex items-center justify-between">
        {isEditDirty ? (
          <span className="text-xs text-amber-600">Unsaved changes</span>
        ) : (
          <span />
        )}
        <Button
          onClick={() => saveRoutine.mutate()}
          disabled={saveRoutine.isPending || !editDraft.title.trim()}
        >
          <Save className="mr-2 h-4 w-4" />
          Save routine
        </Button>
      </div>

      <Separator className="md:hidden" />

      {/* Tabs (mobile only — desktop renders in the right properties panel) */}
      <div className="md:hidden">
        {activityTabsPanel}
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

      <TriggerDialog
        open={triggerDialogOpen}
        onOpenChange={(next) => {
          setTriggerDialogOpen(next);
          if (!next) setEditingTrigger(null);
        }}
        trigger={editingTrigger}
        fallbackTimezone={getLocalTimezone()}
        submitting={createTrigger.isPending || updateTrigger.isPending}
        onSubmit={({ id, body }) => {
          if (id) {
            updateTrigger.mutate({ id, patch: body });
          } else {
            createTrigger.mutate(body);
          }
        }}
      />

      <ConfirmDialog
        open={!!triggerPendingDelete}
        onOpenChange={(next) => {
          if (!next) setTriggerPendingDelete(null);
        }}
        title="Delete trigger?"
        description={
          triggerPendingDelete
            ? `"${triggerPendingDelete.label ?? triggerPendingDelete.kind}" will be removed. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleteTrigger.isPending}
        onConfirm={() => {
          if (triggerPendingDelete) deleteTrigger.mutate(triggerPendingDelete.id);
        }}
      />
    </div>
  );
}
