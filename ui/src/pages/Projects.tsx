import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, ResourceMembershipState } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUpDown, Check, Hexagon, LayoutGrid, List, Plus, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";
type ProjectViewMode = "list" | "grid";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

const PROJECT_VIEW_MODE_OPTIONS: Array<{
  mode: ProjectViewMode;
  label: string;
  icon: LucideIcon;
}> = [
  { mode: "list", label: "List view", icon: List },
  { mode: "grid", label: "Grid view", icon: LayoutGrid },
];

/**
 * The chosen view is a personal browsing preference, so it stays in
 * localStorage instead of the server — same approach as the Secrets page.
 */
const PROJECTS_VIEW_MODE_STORAGE_KEY = "paperclip.projects.viewMode";

function readStoredViewMode(): ProjectViewMode {
  try {
    const stored = window.localStorage.getItem(PROJECTS_VIEW_MODE_STORAGE_KEY);
    return stored === "grid" ? "grid" : "list";
  } catch {
    // Storage can be unavailable (private mode / disabled); fall back to list.
    return "list";
  }
}

function writeStoredViewMode(mode: ProjectViewMode) {
  try {
    window.localStorage.setItem(PROJECTS_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures; the view still switches for this session.
  }
}

function formatTaskCount(taskCount: number): string {
  return `${formatNumber(taskCount)} task${taskCount === 1 ? "" : "s"}`;
}

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

/**
 * Per-project membership state and handlers, shared by the list row and the
 * grid card so both views drive the same mutation.
 */
interface ProjectMembershipControls {
  state: ResourceMembershipState;
  starred: boolean;
  starPending: boolean;
  joinLeavePending: boolean;
  pendingState: ResourceMembershipState | null;
  onJoin: () => void;
  onLeave: () => void;
  onToggleStar: (nextStarred: boolean) => void;
}

interface ProjectViewItemProps {
  project: Project;
  controls: ProjectMembershipControls;
}

function ProjectListRow({ project, controls }: ProjectViewItemProps) {
  const taskCountLabel = formatTaskCount(project.taskCount ?? 0);

  return (
    <EntityRow
      leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
      title={project.name}
      subtitle={project.description ?? undefined}
      reserveSubtitleSpace
      to={projectUrl(project)}
      className={controls.state === "left" ? "group text-foreground/55" : "group"}
      trailing={
        <div className="flex items-center gap-3">
          <span
            className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
            title={taskCountLabel}
          >
            {taskCountLabel}
          </span>
          {project.budget && (
            <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
              {formatProjectBudget(project.budget)}
            </span>
          )}
          {project.targetDate && (
            <span className="hidden text-xs text-muted-foreground md:inline">
              {formatDate(project.targetDate)}
            </span>
          )}
          <StatusBadge status={project.status} />
          <MembershipAction
            state={controls.state}
            pending={controls.joinLeavePending}
            pendingState={controls.pendingState}
            resourceName={project.name}
            onJoin={controls.onJoin}
            onLeave={controls.onLeave}
          />
          <StarToggle
            size="row"
            starred={controls.starred}
            pending={controls.starPending}
            resourceName={project.name}
            onToggle={controls.onToggleStar}
          />
        </div>
      }
    />
  );
}

/**
 * A stretched project link keeps the card clickable, while its action buttons
 * remain separate interactive elements above the link's hit area.
 */
function ProjectGridCard({ project, controls }: ProjectViewItemProps) {
  const taskCountLabel = formatTaskCount(project.taskCount ?? 0);

  return (
    <Card
      interactive
      className={cn(
        "group relative isolate h-full gap-3 py-4",
        controls.state === "left" && "text-foreground/55",
      )}
    >
      <div className="flex items-start gap-3 px-4">
        <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="lg" />
        <Link
          to={projectUrl(project)}
          className="min-w-0 flex-1 text-inherit no-underline after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <p className="truncate text-sm font-medium" title={project.name}>
            {project.name}
          </p>
          <p
            className="mt-0.5 line-clamp-2 min-h-8 text-xs text-muted-foreground"
            aria-hidden={!project.description}
          >
            {project.description ?? ""}
          </p>
        </Link>
        <StarToggle
          size="row"
          className="relative z-10"
          starred={controls.starred}
          pending={controls.starPending}
          resourceName={project.name}
          onToggle={controls.onToggleStar}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs text-muted-foreground">
        <span className="tabular-nums" title={taskCountLabel}>{taskCountLabel}</span>
        {project.budget && <span className="tabular-nums">{formatProjectBudget(project.budget)}</span>}
        {project.targetDate && <span>{formatDate(project.targetDate)}</span>}
      </div>
      <div className="flex items-center justify-between gap-2 px-4">
        <StatusBadge status={project.status} />
        <div className="relative z-10">
          <MembershipAction
            state={controls.state}
            pending={controls.joinLeavePending}
            pendingState={controls.pendingState}
            resourceName={project.name}
            onJoin={controls.onJoin}
            onLeave={controls.onLeave}
          />
        </div>
      </div>
    </Card>
  );
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");
  const [viewMode, setViewModeState] = useState<ProjectViewMode>(readStoredViewMode);

  const setViewMode = useCallback((mode: ProjectViewMode) => {
    setViewModeState(mode);
    writeStoredViewMode(mode);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const projects = useMemo(
    () => allProjects ?? [],
    [allProjects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  const membershipControls = useCallback(
    (project: Project): ProjectMembershipControls => {
      const pending = membershipMutation.isPending &&
        membershipMutation.variables?.resourceType === "project" &&
        membershipMutation.variables.resourceId === project.id;
      const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
      const mutate = (
        change: { state: ResourceMembershipState } | { starred: boolean },
      ) => membershipMutation.mutate({
        resourceType: "project",
        resourceId: project.id,
        resourceName: project.name,
        ...change,
      });

      return {
        state: resourceMembershipState(membershipsQuery.data, "project", project.id),
        starred: isStarred(membershipsQuery.data, "project", project.id),
        starPending: pending && membershipMutation.variables?.starred !== undefined,
        joinLeavePending,
        pendingState: joinLeavePending ? membershipMutation.variables?.state ?? null : null,
        onJoin: () => mutate({ state: "joined" }),
        onLeave: () => mutate({ state: "left" }),
        onToggleStar: (next: boolean) => mutate({ starred: next }),
      };
    },
    [membershipMutation, membershipsQuery.data],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select an organization to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
              <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>Sort: {sortLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {PROJECT_SORT_OPTIONS.map((option) => (
                <button
                  key={option.field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    sortField === option.field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => {
                    if (sortField === option.field) {
                      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                      return;
                    }
                    setSortField(option.field);
                    setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                  }}
                >
                  <span>{option.label}</span>
                  {sortField === option.field ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {sortDir === "asc" ? "Asc" : "Desc"}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
          <div
            role="group"
            aria-label="View mode"
            className="flex items-center overflow-hidden rounded-md border border-border"
          >
            {PROJECT_VIEW_MODE_OPTIONS.map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center transition-colors",
                  viewMode === mode
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            ["My Projects", groupedProjects.mine],
            ["Other Projects", groupedProjects.other],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project{sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                {viewMode === "grid" ? (
                  <div
                    data-testid="projects-grid"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                  >
                    {sectionProjects.map((project) => (
                      <ProjectGridCard
                        key={project.id}
                        project={project}
                        controls={membershipControls(project)}
                      />
                    ))}
                  </div>
                ) : (
                  <Card data-testid="projects-list" className="block py-0 overflow-hidden divide-y divide-border">
                    {sectionProjects.map((project) => (
                      <ProjectListRow
                        key={project.id}
                        project={project}
                        controls={membershipControls(project)}
                      />
                    ))}
                  </Card>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
