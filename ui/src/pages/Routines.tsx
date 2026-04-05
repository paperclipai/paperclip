import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { ChevronDown, ChevronRight, MoreHorizontal, Play, Plus, Repeat } from "lucide-react";
import { routinesApi } from "../api/routines";
import { instanceSettingsApi } from "../api/instanceSettings";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import {
  RoutineRunVariablesDialog,
  routineRunNeedsConfiguration,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { Button, Card, Modal, Select, Dropdown, ListBox, Separator } from "@heroui/react";
import type { RoutineListItem, RoutineVariable } from "@paperclipai/shared";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMutationRoutineId, setStatusMutationRoutineId] = useState<string | null>(null);
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<{
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

  useEffect(() => {
    setBreadcrumbs([{ label: "Routines" }]);
  }, [setBreadcrumbs]);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const createRoutine = useMutation({
    mutationFn: () =>
      routinesApi.create(selectedCompanyId!, {
        ...draft,
        description: draft.description.trim() || null,
      }),
    onSuccess: async (routine) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
        assigneeAgentId: "",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      });
      setComposerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) });
      pushToast({
        title: "Routine created",
        body: "Add the first trigger to turn it into a live workflow.",
        tone: "success",
      });
      navigate(`/routines/${routine.id}?tab=triggers`);
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => routinesApi.update(id, { status }),
    onMutate: ({ id }) => {
      setStatusMutationRoutineId(id);
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setStatusMutationRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update routine",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not update the routine.",
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RoutineRunDialogSubmitData }) => routinesApi.run(id, {
      ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
      ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
      ...(data?.executionWorkspacePreference !== undefined
        ? { executionWorkspacePreference: data.executionWorkspacePreference }
        : {}),
      ...(data?.executionWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
        : {}),
    }),
    onMutate: ({ id }) => {
      setRunningRoutineId(id);
    },
    onSuccess: async (_, { id }) => {
      setRunDialogRoutine(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(id) }),
      ]);
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen]);
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
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const runDialogProject = runDialogRoutine?.projectId ? projectById.get(runDialogRoutine.projectId) ?? null : null;
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;

  function handleRunNow(routine: RoutineListItem) {
    const project = routine.projectId ? projectById.get(routine.projectId) ?? null : null;
    const needsConfiguration = routineRunNeedsConfiguration({
      variables: routine.variables ?? [],
      project,
      isolatedWorkspacesEnabled: experimentalSettings?.enableIsolatedWorkspaces === true,
    });
    if (needsConfiguration) {
      setRunDialogRoutine(routine);
      return;
    }
    runRoutine.mutate({ id: routine.id, data: {} });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            Routines
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">Beta</span>
          </h1>
          <p className="text-sm text-foreground/40">
            Recurring work definitions that materialize into auditable execution issues.
          </p>
        </div>
        <Button size="sm" variant="primary" onPress={() => setComposerOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Routine
        </Button>
      </div>

      <Modal.Backdrop
        isOpen={composerOpen}
        onOpenChange={(open: boolean) => {
          if (!createRoutine.isPending) {
            setComposerOpen(open);
          }
        }}
      >
        <Modal.Container className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <Modal.Dialog>
          {() => (<>
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-default-200/60 px-5 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-foreground/40">New routine</p>
              <p className="text-sm text-foreground/40">
                Define the recurring work first. Trigger setup comes next on the detail page.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                setComposerOpen(false);
                setAdvancedOpen(false);
              }}
              isDisabled={createRoutine.isPending}
            >
              Cancel
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-5 pb-3">
              <textarea
                ref={titleInputRef}
                className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-foreground/50"
                placeholder="Routine title"
                rows={1}
                value={draft.title}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, title: event.target.value }));
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
                    if (draft.assigneeAgentId) {
                      if (draft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    } else {
                      assigneeSelectorRef.current?.focus();
                    }
                  }
                }}
                autoFocus
              />
            </div>

            <div className="px-5 pb-3">
              <div className="overflow-x-auto overscroll-x-contain">
                <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-foreground/40 sm:min-w-max sm:flex-nowrap">
                  <span>For</span>
                  <InlineEntitySelector
                    ref={assigneeSelectorRef}
                    value={draft.assigneeAgentId}
                    options={assigneeOptions}
                    placeholder="Assignee"
                    noneLabel="No assignee"
                    searchPlaceholder="Search assignees..."
                    emptyMessage="No assignees found."
                    onChange={(assigneeAgentId) => {
                      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                      setDraft((current) => ({ ...current, assigneeAgentId }));
                    }}
                    onConfirm={() => {
                      if (draft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    }}
                    renderTriggerValue={(option) =>
                      option ? (
                        currentAssignee ? (
                          <>
                            <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                            <span className="truncate">{option.label}</span>
                          </>
                        ) : (
                          <span className="truncate">{option.label}</span>
                        )
                      ) : (
                        <span className="text-foreground/40">Assignee</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const assignee = agentById.get(option.id);
                      return (
                        <>
                          {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-foreground/40" /> : null}
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                  <span>in</span>
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={draft.projectId}
                    options={projectOptions}
                    placeholder="Project"
                    noneLabel="No project"
                    searchPlaceholder="Search projects..."
                    emptyMessage="No projects found."
                    onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
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
                        <span className="text-foreground/40">Project</span>
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
            </div>

            <div className="border-t border-default-200/60 px-5 py-4">
              <MarkdownEditor
                ref={descriptionEditorRef}
                value={draft.description}
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
                placeholder="Add instructions..."
                bordered={false}
                contentClassName="min-h-[160px] text-sm text-foreground/40"
                onSubmit={() => {
                  if (!createRoutine.isPending && draft.title.trim() && draft.projectId && draft.assigneeAgentId) {
                    createRoutine.mutate();
                  }
                }}
              />
              <div className="mt-3 space-y-3">
                <RoutineVariablesHint />
                <RoutineVariablesEditor
                  description={draft.description}
                  value={draft.variables}
                  onChange={(variables) => setDraft((current) => ({ ...current, variables }))}
                />
              </div>
            </div>

            <div className="border-t border-default-200/60 px-5 py-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <div>
                  <p className="text-sm font-medium">Advanced delivery settings</p>
                  <p className="text-sm text-foreground/40">Keep policy controls secondary to the work definition.</p>
                </div>
                {advancedOpen ? <ChevronDown className="h-4 w-4 text-foreground/40" /> : <ChevronRight className="h-4 w-4 text-foreground/40" />}
              </button>
              {advancedOpen && (
                <div className="pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-foreground/40">Concurrency</p>
                      <Select
                        selectedKey={draft.concurrencyPolicy}
                        onSelectionChange={(key) => setDraft((current) => ({ ...current, concurrencyPolicy: key as string }))}
                      >
                        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {concurrencyPolicies.map((value) => (
                              <ListBox.Item key={value} id={value}>{value.replaceAll("_", " ")}</ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                      <p className="text-xs text-foreground/40">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-foreground/40">Catch-up</p>
                      <Select
                        selectedKey={draft.catchUpPolicy}
                        onSelectionChange={(key) => setDraft((current) => ({ ...current, catchUpPolicy: key as string }))}
                      >
                        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {catchUpPolicies.map((value) => (
                              <ListBox.Item key={value} id={value}>{value.replaceAll("_", " ")}</ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                      <p className="text-xs text-foreground/40">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-3 border-t border-default-200/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-foreground/40">
              After creation, Paperclip takes you straight to trigger setup for schedules, webhooks, or internal runs.
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onPress={() => createRoutine.mutate()}
                isDisabled={
                  createRoutine.isPending ||
                  !draft.title.trim() ||
                  !draft.projectId ||
                  !draft.assigneeAgentId
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                {createRoutine.isPending ? "Creating..." : "Create routine"}
              </Button>
              {createRoutine.isError ? (
                <p className="text-sm text-danger">
                  {createRoutine.error instanceof Error ? createRoutine.error.message : "Failed to create routine"}
                </p>
              ) : null}
            </div>
          </div>
          </>)}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {error ? (
        <Card>
          <Card.Content className="pt-6 text-sm text-danger">
            {error instanceof Error ? error.message : "Failed to load routines"}
          </Card.Content>
        </Card>
      ) : null}

      <div>
        {(routines ?? []).length === 0 ? (
          <div className="py-12">
            <EmptyState
              icon={Repeat}
              message="No routines yet. Use Create routine to define the first recurring workflow."
            />
          </div>
        ) : (
          <Card className="border-default-200/60">
            <Card.Content className="p-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-foreground/40 border-b border-default-200/40">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="w-12 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(routines ?? []).map((routine) => {
                  const enabled = routine.status === "active";
                  const isArchived = routine.status === "archived";
                  const isStatusPending = statusMutationRoutineId === routine.id;
                  return (
                    <tr
                      key={routine.id}
                      className="align-middle border-b border-default-200/30 transition-colors hover:bg-accent/[0.03] last:border-b-0 cursor-pointer"
                      onClick={() => navigate(`/routines/${routine.id}`)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="min-w-[180px]">
                          <span className="font-medium">
                            {routine.title}
                          </span>
                          {(isArchived || routine.status === "paused") && (
                            <div className="mt-1 text-xs text-foreground/40">
                              {isArchived ? "archived" : "paused"}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {routine.projectId ? (
                          <div className="flex items-center gap-2 text-sm text-foreground/40">
                            <span
                              className="shrink-0 h-3 w-3 rounded-sm"
                              style={{ backgroundColor: projectById.get(routine.projectId)?.color ?? "#6366f1" }}
                            />
                            <span className="truncate">{projectById.get(routine.projectId)?.name ?? "Unknown"}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {routine.assigneeAgentId ? (() => {
                          const agent = agentById.get(routine.assigneeAgentId);
                          return agent ? (
                            <div className="flex items-center gap-2 text-sm text-foreground/40">
                              <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0" />
                              <span className="truncate">{agent.name}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-foreground/40">Unknown</span>
                          );
                        })() : (
                          <span className="text-xs text-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-foreground/40">
                        <div>{formatLastRunTimestamp(routine.lastRun?.triggeredAt)}</div>
                        {routine.lastRun ? (
                          <div className="mt-1 text-xs">{routine.lastRun.status.replaceAll("_", " ")}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            role="switch"
                            data-slot="toggle"
                            aria-checked={enabled}
                            aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`}
                            disabled={isStatusPending || isArchived}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              enabled ? "bg-foreground" : "bg-default-200"
                            } ${isStatusPending || isArchived ? "cursor-not-allowed opacity-50" : ""}`}
                            onClick={() =>
                              updateRoutineStatus.mutate({
                                id: routine.id,
                                status: nextRoutineStatus(routine.status, !enabled),
                              })
                            }
                          >
                            <span
                              className={`inline-block h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${
                                enabled ? "translate-x-5" : "translate-x-0.5"
                              }`}
                            />
                          </button>
                          <span className="text-xs text-foreground/40">
                            {isArchived ? "Archived" : enabled ? "On" : "Off"}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <Dropdown>
                          <Dropdown.Trigger>
                            <Button variant="ghost" size="sm" aria-label={`More actions for ${routine.title}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </Dropdown.Trigger>
                          <Dropdown.Popover>
                            <Dropdown.Menu>
                              <Dropdown.Item id="edit" onAction={() => navigate(`/routines/${routine.id}`)}>
                                Edit
                              </Dropdown.Item>
                              <Dropdown.Item
                                id="run"
                                isDisabled={runningRoutineId === routine.id || isArchived}
                                onAction={() => handleRunNow(routine)}
                              >
                                {runningRoutineId === routine.id ? "Running..." : "Run now"}
                              </Dropdown.Item>
                              <Dropdown.Section className="border-t border-default-200/30 my-1" aria-label="Status">
                                <Dropdown.Item
                                  id="toggle-status"
                                  onAction={() =>
                                    updateRoutineStatus.mutate({
                                      id: routine.id,
                                      status: enabled ? "paused" : "active",
                                    })
                                  }
                                  isDisabled={isStatusPending || isArchived}
                                >
                                  {enabled ? "Pause" : "Enable"}
                                </Dropdown.Item>
                                <Dropdown.Item
                                  id="archive"
                                  onAction={() =>
                                    updateRoutineStatus.mutate({
                                      id: routine.id,
                                      status: routine.status === "archived" ? "active" : "archived",
                                    })
                                  }
                                  isDisabled={isStatusPending}
                                >
                                  {routine.status === "archived" ? "Restore" : "Archive"}
                                </Dropdown.Item>
                              </Dropdown.Section>
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </Card.Content>
          </Card>
        )}
      </div>

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={selectedCompanyId}
        project={runDialogProject}
        variables={runDialogRoutine?.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => {
          if (!runDialogRoutine) return;
          runRoutine.mutate({ id: runDialogRoutine.id, data });
        }}
      />
    </div>
  );
}
