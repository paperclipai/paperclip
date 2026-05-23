import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  History as HistoryIcon,
  KeyRound,
  Play,
  RefreshCw,
  Repeat,
  Save,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { ApiError } from "../api/client";
import { routinesApi, type RoutineTriggerResponse, type RotateRoutineTriggerResponse, type RestoreRoutineRevisionResponse } from "../api/routines";
import { secretsApi } from "../api/secrets";
import { EnvVarEditor } from "../components/EnvVarEditor";
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
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "../components/MarkdownEditor";
import { useTranslation } from "@/i18n";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
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
import type {
  EnvBinding,
  RoutineDetail as RoutineDetailType,
  RoutineEnvConfig,
  RoutineTrigger,
  RoutineVariable,
} from "@paperclipai/shared";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const triggerKinds = ["schedule", "webhook"];
const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"];
const routineTabs = ["triggers", "runs", "activity", "secrets", "history"] as const;
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the routine is already active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the routine or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};
const signingModeDescriptions: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
  github_hmac: "Accept GitHub-style X-Hub-Signature-256 header (HMAC over raw body, no timestamp).",
  none: "No authentication — the webhook URL itself acts as a shared secret.",
};
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);

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
  env: RoutineEnvConfig | null;
}) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    assigneeAgentId: input.assigneeAgentId || null,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : null,
  };
}

function TriggerEditor({
  trigger,
  onSave,
  onRotate,
  onDelete,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {trigger.kind === "schedule" ? <Clock3 className="h-3.5 w-3.5" /> : trigger.kind === "webhook" ? <Webhook className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {trigger.label ?? trigger.kind}
        </div>
        <span className="text-xs text-muted-foreground">
          {trigger.kind === "schedule" && trigger.nextRunAt
            ? t("routineDetail.nextAt", { time: new Date(trigger.nextRunAt).toLocaleString(), defaultValue: `Next: ${new Date(trigger.nextRunAt).toLocaleString()}` })
            : trigger.kind === "webhook"
              ? t("routineDetail.webhook", { defaultValue: "Webhook" })
              : t("routineDetail.api", { defaultValue: "API" })}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("routineDetail.label", { defaultValue: "Label" })}</Label>
          <Input
            value={draft.label}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        {trigger.kind === "schedule" && (
          <div className="md:col-span-2 space-y-1.5">
            <Label className="text-xs">{t("routineDetail.schedule", { defaultValue: "Schedule" })}</Label>
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) => setDraft((current) => ({ ...current, cronExpression }))}
            />
          </div>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("routineDetail.signingMode", { defaultValue: "Signing mode" })}</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signingModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("routineDetail.replayWindow", { defaultValue: "Replay window (seconds)" })}</Label>
                <Input
                  value={draft.replayWindowSec}
                  onChange={(event) => setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))}
                />
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {trigger.lastResult && <span className="text-xs text-muted-foreground">{t("routineDetail.lastResult", { result: trigger.lastResult, defaultValue: `Last: ${trigger.lastResult}` })}</span>}
        <div className="ml-auto flex items-center gap-2">
          {trigger.kind === "webhook" && (
            <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("routineDetail.rotateSecret", { defaultValue: "Rotate secret" })}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()))}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {t("routineDetail.saveTrigger", { defaultValue: "Save trigger" })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RoutineDetail() {
  const { t } = useTranslation();
  const { routineId } = useParams<{ routineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [runVariablesOpen, setRunVariablesOpen] = useState(false);
  const [newTrigger, setNewTrigger] = useState({
    kind: "schedule",
    cronExpression: "0 10 * * *",
    signingMode: "bearer",
    replayWindowSec: "300",
  });
  const [editDraft, setEditDraft] = useState<{
    title: string;
    description: string;
    projectId: string;
    assigneeAgentId: string;
    priority: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    variables: RoutineVariable[];
    env: RoutineEnvConfig | null;
  }>({
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
            env: routine.env ?? null,
          }
        : null,
    [routine],
  );
  const dirtyFields = useMemo<RoutineHistoryDirtyFieldDescriptor[]>(() => {
    if (!routineDefaults) return [];
    const result: RoutineHistoryDirtyFieldDescriptor[] = [];
    if (editDraft.title !== routineDefaults.title) result.push({ key: "title", label: t("routineDetail.dirty.title", { defaultValue: "the title" }) });
    if (editDraft.description !== routineDefaults.description) {
      result.push({ key: "description", label: t("routineDetail.dirty.description", { defaultValue: "the description" }) });
    }
    if (editDraft.projectId !== routineDefaults.projectId) {
      result.push({ key: "projectId", label: t("routineDetail.dirty.project", { defaultValue: "the project" }) });
    }
    if (editDraft.assigneeAgentId !== routineDefaults.assigneeAgentId) {
      result.push({ key: "assigneeAgentId", label: t("routineDetail.dirty.defaultAgent", { defaultValue: "the default agent" }) });
    }
    if (editDraft.priority !== routineDefaults.priority) {
      result.push({ key: "priority", label: t("routineDetail.dirty.priority", { defaultValue: "the priority" }) });
    }
    if (editDraft.concurrencyPolicy !== routineDefaults.concurrencyPolicy) {
      result.push({ key: "concurrencyPolicy", label: t("routineDetail.dirty.concurrencyPolicy", { defaultValue: "the concurrency policy" }) });
    }
    if (editDraft.catchUpPolicy !== routineDefaults.catchUpPolicy) {
      result.push({ key: "catchUpPolicy", label: t("routineDetail.dirty.catchUpPolicy", { defaultValue: "the catch-up policy" }) });
    }
    if (JSON.stringify(editDraft.variables) !== JSON.stringify(routineDefaults.variables)) {
      result.push({ key: "variables", label: t("routineDetail.dirty.variables", { defaultValue: "the variables" }) });
    }
    if (JSON.stringify(editDraft.env ?? null) !== JSON.stringify(routineDefaults.env ?? null)) {
      result.push({ key: "env", label: t("routineDetail.dirty.secrets", { defaultValue: "the secrets" }) });
    }
    return result;
  }, [editDraft, routineDefaults, t]);
  const isEditDirty = dirtyFields.length > 0;

  useEffect(() => {
    if (!routine) return;
    setBreadcrumbs([{ label: t("sidebar.routines", { defaultValue: "Routines" }), href: "/routines" }, { label: routine.title }]);
    if (!routineDefaults) return;

    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
    }
  }, [routine, routineDefaults, isEditDirty, setBreadcrumbs, t]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, routine?.id]);

  const copySecretValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ title: t("routineDetail.toast.copied", { label, defaultValue: `${label} copied` }), tone: "success" });
    } catch (error) {
      pushToast({
        title: t("routineDetail.toast.copyFailed", { label: label.toLowerCase(), defaultValue: `Failed to copy ${label.toLowerCase()}` }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.clipboardDenied", { defaultValue: "Clipboard access was denied." }),
        tone: "error",
      });
    }
  };

  const setActiveTab = (value: string) => {
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
  };

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
          title: t("routineDetail.toast.routineChanged", { defaultValue: "Routine changed" }),
          body: t("routineDetail.toast.routineChangedBody", { defaultValue: "Someone else updated this routine. Reload to see the latest revision." }),
          tone: "warn",
        });
        return;
      }
      pushToast({
        title: t("routineDetail.toast.saveFailed", { defaultValue: "Failed to save routine" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.saveFailedBody", { defaultValue: "Paperclip could not save the routine." }),
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
      pushToast({ title: t("routineDetail.toast.runStarted", { defaultValue: "Routine run started" }), tone: "success" });
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
        title: t("routineDetail.toast.runFailed", { defaultValue: "Routine run failed" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.runFailedBody", { defaultValue: "Paperclip could not start the routine run." }),
        tone: "error",
      });
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: (status: string) => routinesApi.update(routineId!, { status }),
    onSuccess: async (_data, status) => {
      pushToast({
        title: t("routineDetail.toast.routineSaved", { defaultValue: "Routine saved" }),
        body: status === "paused"
          ? t("routineDetail.toast.automationPaused", { defaultValue: "Automation paused." })
          : t("routineDetail.toast.automationEnabled", { defaultValue: "Automation enabled." }),
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: t("routineDetail.toast.updateFailed", { defaultValue: "Failed to update routine" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.updateFailedBody", { defaultValue: "Paperclip could not update the routine." }),
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
          ? {
            signingMode: newTrigger.signingMode,
            replayWindowSec: Number(newTrigger.replayWindowSec || "300"),
          }
          : {}),
      });
    },
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: t("routineDetail.toast.webhookCreated", { defaultValue: "Webhook trigger created" }),
          entries: [{
            webhookUrl: result.secretMaterial.webhookUrl,
            webhookSecret: result.secretMaterial.webhookSecret,
          }],
        });
      } else {
        pushToast({
          title: t("routineDetail.toast.triggerAdded", { defaultValue: "Trigger added" }),
          body: t("routineDetail.toast.triggerAddedBody", { defaultValue: "The routine schedule was saved." }),
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
        title: t("routineDetail.toast.addTriggerFailed", { defaultValue: "Failed to add trigger" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.addTriggerFailedBody", { defaultValue: "Paperclip could not create the trigger." }),
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      pushToast({
        title: t("routineDetail.toast.triggerSaved", { defaultValue: "Trigger saved" }),
        body: t("routineDetail.toast.triggerSavedBody", { defaultValue: "The routine cadence update was saved." }),
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: t("routineDetail.toast.updateTriggerFailed", { defaultValue: "Failed to update trigger" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.updateTriggerFailedBody", { defaultValue: "Paperclip could not update the trigger." }),
        tone: "error",
      });
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      pushToast({
        title: t("routineDetail.toast.triggerDeleted", { defaultValue: "Trigger deleted" }),
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: t("routineDetail.toast.deleteTriggerFailed", { defaultValue: "Failed to delete trigger" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.deleteTriggerFailedBody", { defaultValue: "Paperclip could not delete the trigger." }),
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: t("routineDetail.toast.webhookSecretRotated", { defaultValue: "Webhook secret rotated" }),
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
        title: t("routineDetail.toast.rotateFailed", { defaultValue: "Failed to rotate webhook secret" }),
        body: error instanceof Error ? error.message : t("routineDetail.toast.rotateFailedBody", { defaultValue: "Paperclip could not rotate the webhook secret." }),
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

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message={t("routineDetail.selectCompany", { defaultValue: "Select a company to view routines." })} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !routine) {
    return (
      <p className="pt-6 text-sm text-destructive">
        {error instanceof Error ? error.message : t("routineDetail.notFound", { defaultValue: "Routine not found" })}
      </p>
    );
  }

  const automationEnabled = routine.status === "active";
  const selectedProject = routine.projectId ? (projects?.find((project) => project.id === routine.projectId) ?? null) : null;
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel = routine.status === "archived"
    ? t("routineDetail.status.archived", { defaultValue: "Archived" })
    : !routine.assigneeAgentId
      ? t("routineDetail.status.draft", { defaultValue: "Draft" })
      : automationEnabled
        ? t("routineDetail.status.active", { defaultValue: "Active" })
        : t("routineDetail.status.paused", { defaultValue: "Paused" });
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
            placeholder={t("routineDetail.titlePlaceholder", { defaultValue: "Routine title" })}
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
              {t("routineDetail.managedBy", { plugin: routine.managedByPlugin.pluginDisplayName, defaultValue: `Managed by ${routine.managedByPlugin.pluginDisplayName}` })}
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
                  title: t("routineDetail.toast.defaultAgentRequired", { defaultValue: "Default agent required" }),
                  body: t("routineDetail.toast.defaultAgentRequiredBody", { defaultValue: "Set a default agent before enabling routine automation." }),
                  tone: "warn",
                });
                return;
              }
              updateRoutineStatus.mutate(automationEnabled ? "paused" : "active");
            }}
            disabled={automationToggleDisabled}
            aria-label={automationEnabled
              ? t("routineDetail.aria.pauseAutomation", { defaultValue: "Pause automatic triggers" })
              : t("routineDetail.aria.enableAutomation", { defaultValue: "Enable automatic triggers" })}
          />
          <span className={`min-w-[3.75rem] text-sm font-medium ${automationLabelClassName}`}>
            {automationLabel}
          </span>
        </div>
      </div>

      {/* Secret message banner */}
      {secretMessage && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-3 text-sm">
          <div>
            <p className="font-medium">{secretMessage.title}</p>
            <p className="text-xs text-muted-foreground">{t("routineDetail.secretSaveWarning", { defaultValue: "Save this now. Paperclip will not show the secret value again." })}</p>
          </div>
          <div className="space-y-3">
            {secretMessage.entries.map((entry, index) => (
              <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
                {secretMessage.entries.length > 1 && (
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("routineDetail.webhookTriggerOf", {
                      index: index + 1,
                      total: secretMessage.entries.length,
                      defaultValue: `Webhook trigger ${index + 1} of ${secretMessage.entries.length}`,
                    })}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookUrl} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue(t("routineDetail.webhookUrl", { defaultValue: "Webhook URL" }), entry.webhookUrl)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    {t("routineDetail.urlButton", { defaultValue: "URL" })}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input value={entry.webhookSecret} readOnly className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => copySecretValue(t("routineDetail.webhookSecretLabel", { defaultValue: "Webhook secret" }), entry.webhookSecret)}>
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    {t("routineDetail.secretButton", { defaultValue: "Secret" })}
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
              <p className="font-medium text-amber-200">{t("routineDetail.outOfDate", { defaultValue: "Out of date" })}</p>
              <p className="text-xs text-muted-foreground">
                {t("routineDetail.outOfDateBody", { defaultValue: "This routine changed while you were editing. Reload to merge the latest revision before saving again." })}
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
                {t("routineDetail.reloadLatest", { defaultValue: "Reload latest" })}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!routine.assigneeAgentId ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-900 dark:text-amber-200">
          {t("routineDetail.defaultAgentBanner", { defaultValue: "Default agent required. This routine can stay as a draft and still run manually, but automation stays paused until you assign a default agent." })}
        </div>
      ) : null}

      {/* Assignment row */}
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span>{t("routineDetail.for", { defaultValue: "For" })}</span>
          <InlineEntitySelector
            ref={assigneeSelectorRef}
            value={editDraft.assigneeAgentId}
            options={assigneeOptions}
            recentOptionIds={recentAssigneeIds}
            placeholder={t("routineDetail.assignee", { defaultValue: "Assignee" })}
            noneLabel={t("routineDetail.noAssignee", { defaultValue: "No assignee" })}
            searchPlaceholder={t("routineDetail.searchAssignees", { defaultValue: "Search assignees..." })}
            emptyMessage={t("routineDetail.noAssigneesFound", { defaultValue: "No assignees found." })}
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
                <span className="text-muted-foreground">{t("routineDetail.assignee", { defaultValue: "Assignee" })}</span>
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
          <span>{t("routineDetail.in", { defaultValue: "in" })}</span>
          <InlineEntitySelector
            ref={projectSelectorRef}
            value={editDraft.projectId}
            options={projectOptions}
            recentOptionIds={recentProjectIds}
            placeholder={t("routineDetail.project", { defaultValue: "Project" })}
            noneLabel={t("routineDetail.noProject", { defaultValue: "No project" })}
            searchPlaceholder={t("routineDetail.searchProjects", { defaultValue: "Search projects..." })}
            emptyMessage={t("routineDetail.noProjectsFound", { defaultValue: "No projects found." })}
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
                <span className="text-muted-foreground">{t("routineDetail.project", { defaultValue: "Project" })}</span>
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
        placeholder={t("routineDetail.instructionsPlaceholder", { defaultValue: "Add instructions..." })}
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
          <span className="text-sm font-medium">{t("routineDetail.advancedDelivery", { defaultValue: "Advanced delivery settings" })}</span>
          {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t("routineDetail.concurrency", { defaultValue: "Concurrency" })}</p>
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
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t("routineDetail.catchUp", { defaultValue: "Catch-up" })}</p>
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
          <span className="text-xs text-amber-600">{t("routineDetail.unsavedChanges", { defaultValue: "Unsaved changes" })}</span>
        ) : (
          <span />
        )}
        <Button
          onClick={() => saveRoutine.mutate()}
          disabled={saveRoutine.isPending || !editDraft.title.trim()}
        >
          <Save className="mr-2 h-4 w-4" />
          {t("routineDetail.saveRoutine", { defaultValue: "Save routine" })}
        </Button>
      </div>

      <Separator />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="triggers" className="gap-1.5">
            <Clock3 className="h-3.5 w-3.5" />
            {t("routineDetail.tabs.triggers", { defaultValue: "Triggers" })}
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <Play className="h-3.5 w-3.5" />
            {t("routineDetail.tabs.runs", { defaultValue: "Runs" })}
            {hasLiveRun && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
          </TabsTrigger>
<TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            {t("routineDetail.tabs.activity", { defaultValue: "Activity" })}
          </TabsTrigger>
          <TabsTrigger value="secrets" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            {t("routineDetail.tabs.secrets", { defaultValue: "Secrets" })}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <HistoryIcon className="h-3.5 w-3.5" />
            {t("routineDetail.tabs.history", { defaultValue: "History" })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="triggers" className="space-y-4">
          {/* Add trigger form */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm font-medium">{t("routineDetail.addTrigger", { defaultValue: "Add trigger" })}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("routineDetail.kind", { defaultValue: "Kind" })}</Label>
                <Select value={newTrigger.kind} onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {triggerKinds.map((kind) => (
                      <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                        {kind}{kind === "webhook" ? t("routineDetail.comingSoon", { defaultValue: " — COMING SOON" }) : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {newTrigger.kind === "schedule" && (
                <div className="md:col-span-2 space-y-1.5">
                  <Label className="text-xs">{t("routineDetail.schedule", { defaultValue: "Schedule" })}</Label>
                  <ScheduleEditor
                    value={newTrigger.cronExpression}
                    onChange={(cronExpression) => setNewTrigger((current) => ({ ...current, cronExpression }))}
                  />
                </div>
              )}
              {newTrigger.kind === "webhook" && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("routineDetail.signingMode", { defaultValue: "Signing mode" })}</Label>
                    <Select value={newTrigger.signingMode} onValueChange={(signingMode) => setNewTrigger((current) => ({ ...current, signingMode }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {signingModes.map((mode) => (
                          <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{signingModeDescriptions[newTrigger.signingMode]}</p>
                  </div>
                  {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(newTrigger.signingMode) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("routineDetail.replayWindow", { defaultValue: "Replay window (seconds)" })}</Label>
                      <Input value={newTrigger.replayWindowSec} onChange={(event) => setNewTrigger((current) => ({ ...current, replayWindowSec: event.target.value }))} />
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center justify-end">
              <Button size="sm" onClick={() => createTrigger.mutate()} disabled={createTrigger.isPending}>
                {createTrigger.isPending
                  ? t("routineDetail.adding", { defaultValue: "Adding..." })
                  : t("routineDetail.addTrigger", { defaultValue: "Add trigger" })}
              </Button>
            </div>
          </div>

          {/* Existing triggers */}
          {routine.triggers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("routineDetail.noTriggers", { defaultValue: "No triggers configured yet." })}</p>
          ) : (
            <div className="space-y-3">
              {routine.triggers.map((trigger) => (
                <TriggerEditor
                  key={trigger.id}
                  trigger={trigger}
                  onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
                  onRotate={(id) => rotateTrigger.mutate(id)}
                  onDelete={(id) => deleteTrigger.mutate(id)}
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
            <p className="text-xs text-muted-foreground">{t("routineDetail.noRuns", { defaultValue: "No runs yet." })}</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(routineRuns ?? []).map((run) => (
                <div key={run.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="shrink-0">{run.source}</Badge>
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"} className="shrink-0">
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                    {run.trigger && (
                      <span className="text-muted-foreground truncate">{run.trigger.label ?? run.trigger.kind}</span>
                    )}
                    {run.linkedIssue && (
                      <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="text-muted-foreground hover:underline truncate">
                        {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                      </Link>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">{timeAgo(run.triggeredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {(activity ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("routineDetail.noActivity", { defaultValue: "No activity yet." })}</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {(activity ?? []).map((event) => (
                <div key={event.id} className="flex items-center justify-between px-3 py-2 text-xs gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-foreground/90 shrink-0">{event.action.replaceAll(".", " ")}</span>
                    {event.details && Object.keys(event.details).length > 0 && (
                      <span className="text-muted-foreground truncate">
                        {Object.entries(event.details).slice(0, 3).map(([key, value], i) => (
                          <span key={key}>
                            {i > 0 && <span className="mx-1 text-border">·</span>}
                            <span className="text-muted-foreground/70">{key.replaceAll("_", " ")}:</span>{" "}
                            {formatActivityDetailValue(value)}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground/60 shrink-0">{timeAgo(event.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="secrets" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("routineDetail.secretsDescription", { defaultValue: "Routine secrets apply to every issue this routine creates. They override matching keys in project and agent env." })} <span className="font-mono">PAPERCLIP_*</span> {t("routineDetail.secretsReserved", { defaultValue: "variables are reserved." })}
          </p>
          <EnvVarEditor
            value={(editDraft.env ?? {}) as Record<string, EnvBinding>}
            secrets={availableSecrets}
            onCreateSecret={async (name, value) => {
              const created = await createSecret.mutateAsync({ name, value });
              return created;
            }}
            onChange={(env) =>
              setEditDraft((current) => ({ ...current, env: env ?? null }))
            }
          />
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
              if (!saveRoutine.isPending && editDraft.title.trim()) {
                saveRoutine.mutate();
              }
            }}
            agents={agentById}
            projects={projectById}
            secrets={availableSecrets}
            onRestoreSecretMaterials={(response: RestoreRoutineRevisionResponse) => {
              if (response.secretMaterials.length > 0) {
                setSecretMessage({
                  title: response.secretMaterials.length === 1
                    ? t("routineDetail.toast.webhookRestored", { defaultValue: "Webhook trigger restored" })
                    : t("routineDetail.toast.webhooksRestored", {
                        count: response.secretMaterials.length,
                        defaultValue: `${response.secretMaterials.length} webhook triggers restored`,
                      }),
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
                env: response.routine.env ?? null,
              });
              hydratedRoutineIdRef.current = response.routine.id;
            }}
          />
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
