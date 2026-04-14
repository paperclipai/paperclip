import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike, type BudgetPolicySummary, type Agent, type ActivityEvent } from "@ironworksai/shared";
import { CopyPlus } from "lucide-react";
import { MarkdownBody } from "../components/MarkdownBody";
import { budgetsApi } from "../api/budgets";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { activityApi } from "../api/activity";
import { ActivityRow } from "../components/ActivityRow";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import type { KanbanGoalInfo } from "../components/KanbanBoard";
import { goalsApi } from "../api/goals";
import { goalProgressApi } from "../api/goalProgress";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { projectRouteRef, cn } from "../lib/utils";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "configuration" | "budget" | "activity";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "activity") return "activity";
  if (tab === "issues") return "list";
  return null;
}

/* ── Overview tab content ── */

function formatBudgetCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
  budgetSummary,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  budgetSummary?: BudgetPolicySummary;
}) {
  const readme = (project as Record<string, unknown>).readme as string | undefined;
  return (
    <div className="space-y-6">
      {/* Project README (12.56) */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project README</h3>
        <InlineEditor
          value={readme ?? ""}
          onSave={(val) => onUpdate({ readme: val })}
          as="p"
          className="text-sm"
          placeholder="Write a project README - describe purpose, setup instructions, architecture..."
          multiline
          imageUploadHandler={imageUploadHandler}
        />
        {readme ? (
          <div className="border-t border-border pt-3">
            <MarkdownBody className="prose prose-sm dark:prose-invert max-w-none">{readme}</MarkdownBody>
          </div>
        ) : null}
      </div>

      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">Target Date</span>
            <p>{project.targetDate}</p>
          </div>
        )}
      </div>

      {/* Budget allocation vs spent */}
      {budgetSummary && budgetSummary.amount > 0 && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Budget</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground text-xs">Allocated</span>
              <p className="font-mono font-medium">{formatBudgetCents(budgetSummary.amount)}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Spent</span>
              <p className="font-mono font-medium">{formatBudgetCents(budgetSummary.observedAmount)}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Remaining</span>
              <p className={cn("font-mono font-medium", budgetSummary.remainingAmount < 0 ? "text-red-500" : "")}>
                {formatBudgetCents(budgetSummary.remainingAmount)}
              </p>
            </div>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                budgetSummary.utilizationPercent > 90 ? "bg-red-500" :
                budgetSummary.utilizationPercent > 70 ? "bg-amber-500" : "bg-emerald-500",
              )}
              style={{ width: `${Math.min(budgetSummary.utilizationPercent, 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {budgetSummary.utilizationPercent.toFixed(1)}% utilized
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId, goalIds }: { projectId: string; companyId: string; goalIds?: string[] }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  // Goal info for Kanban board header
  const primaryGoalId = goalIds?.[0] ?? null;
  const { data: primaryGoal } = useQuery({
    queryKey: queryKeys.goals.detail(primaryGoalId!),
    queryFn: () => goalsApi.get(primaryGoalId!),
    enabled: !!primaryGoalId,
    staleTime: 30_000,
  });
  const { data: goalProgress } = useQuery({
    queryKey: ["goals", "progress-detail", primaryGoalId],
    queryFn: () => goalProgressApi.detail(primaryGoalId!),
    enabled: !!primaryGoalId,
    staleTime: 30_000,
  });

  const goalInfo: KanbanGoalInfo | null = primaryGoal
    ? {
        title: primaryGoal.title,
        healthStatus: primaryGoal.healthStatus ?? null,
        progressPercent: goalProgress?.progressPercent ?? 0,
      }
    : null;

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`ironworks:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      goalInfo={goalInfo}
    />
  );
}

/* ── Activity tab for project ── */

function ProjectActivityTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { data: activity, isLoading } = useQuery({
    queryKey: [...queryKeys.activity(companyId), "project", projectId],
    queryFn: () => activityApi.list(companyId, { entityType: "project", entityId: projectId }),
    enabled: !!companyId && !!projectId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    return map;
  }, [agents]);

  // Also fetch all project-related issue activity
  const { data: issueActivity } = useQuery({
    queryKey: [...queryKeys.issues.listByProject(companyId, projectId), "activity"],
    queryFn: async () => {
      const issues = await issuesApi.list(companyId, { projectId });
      const allActivity: ActivityEvent[] = [];
      // Get activity for each issue in this project (via company activity filtered)
      const companyActivity = await activityApi.list(companyId);
      const projectIssueIds = new Set(issues.map((i) => i.id));
      for (const evt of companyActivity) {
        if (evt.entityType === "issue" && projectIssueIds.has(evt.entityId)) {
          allActivity.push(evt);
        }
        if (evt.entityType === "project" && evt.entityId === projectId) {
          allActivity.push(evt);
        }
      }
      // Build name maps from issues
      for (const i of issues) {
        entityNameMap.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
      }
      return allActivity.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },
    enabled: !!companyId && !!projectId,
  });

  const combinedActivity = useMemo(() => {
    const seen = new Set<string>();
    const merged: ActivityEvent[] = [];
    for (const evt of [...(activity ?? []), ...(issueActivity ?? [])]) {
      if (!seen.has(evt.id)) {
        seen.add(evt.id);
        merged.push(evt);
      }
    }
    return merged.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activity, issueActivity]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-10 rounded-md" />
        ))}
      </div>
    );
  }

  if (combinedActivity.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No activity recorded for this project yet.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
      {combinedActivity.slice(0, 50).map((evt) => (
        <ActivityRow
          key={evt.id}
          event={evt}
          agentMap={agentMap}
          entityNameMap={entityNameMap}
        />
      ))}
    </div>
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive project" : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const deleteProject = useMutation({
    mutationFn: () =>
      projectsApi.remove(projectLookupRef, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: () => {
      const name = project?.name ?? "Project";
      pushToast({ title: `"${name}" has been deleted`, tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId ?? lookupCompanyId ?? "") });
      navigate("/dashboard");
    },
    onError: () => {
      pushToast({ title: "Failed to delete project", tone: "error" });
    },
  });

  const cloneProject = useMutation({
    mutationFn: async () => {
      if (!project || !resolvedCompanyId) throw new Error("No project to clone");
      return projectsApi.create(resolvedCompanyId, {
        name: `${project.name} (Copy)`,
        description: project.description,
        color: project.color,
        targetDate: project.targetDate,
        status: "planned",
      });
    },
    onSuccess: (cloned) => {
      pushToast({ title: `Project cloned as "${cloned.name}"`, tone: "success" });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      }
      navigate(`/projects/${cloned.urlKey ?? cloned.id}`);
    },
    onError: () => {
      pushToast({ title: "Failed to clone project", tone: "error" });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "activity") {
      navigate(`/projects/${canonicalProjectRef}/activity`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Project",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`ironworks:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (cachedTab === "activity") {
      return <Navigate to={`/projects/${canonicalProjectRef}/activity`} replace />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`ironworks:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "activity") {
      navigate(`/projects/${canonicalProjectRef}/activity`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2 flex-1">
          <div className="flex items-center gap-2">
            <InlineEditor
              value={project.name}
              onSave={(name) => updateProject.mutate({ name })}
              as="h2"
              className="text-xl font-bold"
            />
            <button
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              onClick={() => cloneProject.mutate()}
              disabled={cloneProject.isPending}
            >
              <CopyPlus className="h-3 w-3" />
              {cloneProject.isPending ? "Cloning..." : "Clone"}
            </button>
          </div>
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={[
            { value: "list", label: "Missions" },
            { value: "overview", label: "Overview" },
            { value: "activity", label: "Activity" },
            { value: "configuration", label: "Configuration" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          budgetSummary={projectBudgetSummary}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} goalIds={project.goalIds} />
      )}

      {activeTab === "activity" && project?.id && resolvedCompanyId && (
        <ProjectActivityTab projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
            onDelete={() => deleteProject.mutate()}
            deletePending={deleteProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
