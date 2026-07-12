import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
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
import { formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import {
  buildProjectTree,
  getActiveDescendantCounts,
  getParentTargetAvailability,
  type ProjectTreeNode,
} from "../lib/project-tree";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hexagon,
  MoreHorizontal,
  Move,
  Plus,
} from "lucide-react";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

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

function countProjectTreeNodes(nodes: ProjectTreeNode<Project>[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countProjectTreeNodes(node.children),
    0,
  );
}

function structuredErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; message?: string; details?: { message?: string } } | null;
    return body?.details?.message ?? body?.message ?? body?.error ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function ProjectRow({
  node,
  memberships,
  membershipMutation,
  activeDescendantCounts,
  expandedIds,
  onToggle,
  onCreateChild,
  onMove,
  onArchive,
}: {
  node: ProjectTreeNode<Project>;
  memberships: ReturnType<typeof useResourceMemberships>["data"];
  membershipMutation: ReturnType<typeof useResourceMembershipMutation>;
  activeDescendantCounts: Map<string, number>;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onCreateChild: (project: Project) => void;
  onMove: (project: Project) => void;
  onArchive: (project: Project) => void;
}) {
  const { project, children, depth } = node;
  const expanded = expandedIds.has(project.id);
  const hasChildren = children.length > 0;
  const activeDescendantCount = activeDescendantCounts.get(project.id) ?? 0;
  const state = resourceMembershipState(memberships, "project", project.id);
  const pending = membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "project" &&
    membershipMutation.variables.resourceId === project.id;
  const starPending = pending && membershipMutation.variables?.starred !== undefined;
  const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
  const starred = isStarred(memberships, "project", project.id);

  return (
    <>
      <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
        <EntityRow
          leading={(
            <div className="flex items-center" style={{ paddingLeft: `${depth * 20 - 20}px` }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="mr-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggle(project.id);
                  }}
                >
                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : <span className="mr-1 w-6" />}
              <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />
            </div>
          )}
          title={project.name}
          to={projectUrl(project)}
          className={state === "left" ? "group text-foreground/55" : "group"}
          trailing={(
            <div
              className="flex items-center gap-3"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <span
                className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                title={`${formatNumber(project.taskCount ?? 0)} task${(project.taskCount ?? 0) === 1 ? "" : "s"}`}
              >
                {formatNumber(project.taskCount ?? 0)} task{(project.taskCount ?? 0) === 1 ? "" : "s"}
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
                state={state}
                pending={joinLeavePending}
                pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                resourceName={project.name}
                onJoin={() => membershipMutation.mutate({
                  resourceType: "project",
                  resourceId: project.id,
                  resourceName: project.name,
                  state: "joined",
                })}
                onLeave={() => membershipMutation.mutate({
                  resourceType: "project",
                  resourceId: project.id,
                  resourceName: project.name,
                  state: "left",
                })}
              />
              <StarToggle
                size="row"
                starred={starred}
                pending={starPending}
                resourceName={project.name}
                onToggle={(next) => membershipMutation.mutate({
                  resourceType: "project",
                  resourceId: project.id,
                  resourceName: project.name,
                  starred: next,
                })}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`Actions for ${project.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem
                    disabled={depth >= 3}
                    title={depth >= 3 ? "Projects cannot exceed 3 levels." : undefined}
                    onSelect={() => onCreateChild(project)}
                  >
                    <FolderPlus /> Create child
                  </DropdownMenuItem>
                  {depth >= 3 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">Projects cannot exceed 3 levels.</p>
                  ) : null}
                  <DropdownMenuItem onSelect={() => onMove(project)}>
                    <Move /> Move or detach
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={activeDescendantCount > 0}
                    title={activeDescendantCount > 0 ? `Archive or move ${activeDescendantCount} active descendant${activeDescendantCount === 1 ? "" : "s"} first.` : undefined}
                    onSelect={() => onArchive(project)}
                  >
                    <Archive /> Archive
                  </DropdownMenuItem>
                  {activeDescendantCount > 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      Archive or move {activeDescendantCount} active descendant{activeDescendantCount === 1 ? "" : "s"} first.
                    </p>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        />
      </div>
      {hasChildren && expanded ? children.map((child) => (
        <ProjectRow
          key={child.project.id}
          node={child}
          memberships={memberships}
          membershipMutation={membershipMutation}
          activeDescendantCounts={activeDescendantCounts}
          expandedIds={expandedIds}
          onToggle={onToggle}
          onCreateChild={onCreateChild}
          onMove={onMove}
          onArchive={onArchive}
        />
      )) : null}
    </>
  );
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [moveProject, setMoveProject] = useState<Project | null>(null);
  const [moveParentId, setMoveParentId] = useState<string | null>(null);
  const [archiveProject, setArchiveProject] = useState<Project | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setBreadcrumbs([{ label: "Projects" }]), [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const projects = useMemo(() => (allProjects ?? []) as Project[], [allProjects]);
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);
  const sortedActiveProjects = useMemo(
    () => sortProjects(activeProjects, sortField, sortDir),
    [activeProjects, sortDir, sortField],
  );
  const rootTreesByMembership = useMemo(() => {
    const completeTree = buildProjectTree(sortedActiveProjects);
    return {
      mine: completeTree.filter((node) => resourceMembershipState(
        membershipsQuery.data,
        "project",
        node.project.id,
      ) !== "left"),
      other: completeTree.filter((node) => resourceMembershipState(
        membershipsQuery.data,
        "project",
        node.project.id,
      ) === "left"),
    };
  }, [membershipsQuery.data, sortedActiveProjects]);
  const rootTreeCounts = useMemo(() => ({
    mine: countProjectTreeNodes(rootTreesByMembership.mine),
    other: countProjectTreeNodes(rootTreesByMembership.other),
  }), [rootTreesByMembership]);
  const activeDescendantCounts = useMemo(() => getActiveDescendantCounts(projects), [projects]);
  const selectedMoveTargetAvailability = moveProject && moveParentId
    ? getParentTargetAvailability(projects, moveProject.id, moveParentId)
    : null;
  const moveSelectionInvalid = selectedMoveTargetAvailability?.disabled ?? false;
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  useEffect(() => {
    setExpandedIds((current) => {
      if (current.size > 0) return current;
      const next = new Set<string>();
      const collectParents = (nodes: ProjectTreeNode<Project>[]) => {
        for (const node of nodes) {
          if (node.children.length > 0) next.add(node.project.id);
          collectParents(node.children);
        }
      };
      collectParents(rootTreesByMembership.mine);
      collectParents(rootTreesByMembership.other);
      return next;
    });
  }, [rootTreesByMembership]);

  const updateMutation = useMutation({
    mutationFn: ({ projectId, parentProjectId }: { projectId: string; parentProjectId: string | null }) =>
      projectsApi.update(projectId, { parentProjectId }, selectedCompanyId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) });
      setMoveProject(null);
      setActionError(null);
    },
    onError: (mutationError) => setActionError(structuredErrorMessage(mutationError, "Failed to move project.")),
  });

  const archiveMutation = useMutation({
    mutationFn: (projectId: string) => projectsApi.update(projectId, { archivedAt: new Date().toISOString() }, selectedCompanyId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) });
      setArchiveProject(null);
      setActionError(null);
    },
    onError: (mutationError) => setActionError(structuredErrorMessage(mutationError, "Failed to archive project.")),
  });

  if (!selectedCompanyId) return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
              <ArrowUpDown className="h-3.5 w-3.5 sm:mr-1 sm:h-3 sm:w-3" />
              <span>Sort: {sortLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="space-y-0.5 p-2">
              {PROJECT_SORT_OPTIONS.map((option) => (
                <button
                  key={option.field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${sortField === option.field ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
                  onClick={() => {
                    if (sortField === option.field) {
                      setSortDir((current) => current === "asc" ? "desc" : "asc");
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
        <Button size="sm" variant="outline" onClick={() => openNewProject({ parentProjectId: null })}>
          <Plus className="mr-1 h-4 w-4" /> Add Project
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
      {actionError ? <p role="alert" className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{actionError}</p> : null}

      {activeProjects.length === 0 ? (
        <EmptyState icon={Hexagon} message="No projects yet." action="Add Project" onAction={() => openNewProject({ parentProjectId: null })} />
      ) : (
        <div className="space-y-6">
          {([
            ["My Projects", rootTreeCounts.mine, rootTreesByMembership.mine],
            ["Other Projects", rootTreeCounts.other, rootTreesByMembership.other],
          ] as const).map(([label, sectionProjectCount, sectionTree]) => {
            if (sectionProjectCount === 0) return null;
            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjectCount} project{sectionProjectCount === 1 ? "" : "s"}
                  </span>
                </div>
                <Card className="block overflow-hidden py-0" role="tree">
                  {sectionTree.map((node) => (
                    <ProjectRow
                      key={node.project.id}
                      node={node}
                      memberships={membershipsQuery.data}
                      membershipMutation={membershipMutation}
                      activeDescendantCounts={activeDescendantCounts}
                      expandedIds={expandedIds}
                      onToggle={(id) => setExpandedIds((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id); else next.add(id);
                        return next;
                      })}
                      onCreateChild={(project) => openNewProject({ parentProjectId: project.id })}
                      onMove={(project) => {
                        setMoveProject(project);
                        setMoveParentId(project.parentProjectId);
                        setActionError(null);
                      }}
                      onArchive={(project) => {
                        setArchiveProject(project);
                        setActionError(null);
                      }}
                    />
                  ))}
                </Card>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={!!moveProject} onOpenChange={(open) => !open && setMoveProject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {moveProject?.name}</DialogTitle>
            <DialogDescription>Choose a parent or detach this project to the root. The tree remains limited to three levels.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="move-parent">Parent project</label>
            <select
              id="move-parent"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={moveParentId ?? ""}
              onChange={(event) => setMoveParentId(event.target.value || null)}
            >
              <option value="">No parent (root)</option>
              {moveProject ? projects.map((target) => {
                const availability = getParentTargetAvailability(projects, moveProject.id, target.id);
                return (
                  <option key={target.id} value={target.id} disabled={availability.disabled} title={availability.reason ?? undefined}>
                    {target.name}{availability.reason ? ` — ${availability.reason}` : ""}
                  </option>
                );
              }) : null}
            </select>
          </div>
          {moveSelectionInvalid ? (
            <p role="alert" className="text-sm text-destructive">
              {selectedMoveTargetAvailability?.reason ?? "Selected parent is unavailable."}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveProject(null)}>Cancel</Button>
            <Button
              disabled={!moveProject || updateMutation.isPending || moveSelectionInvalid || moveParentId === moveProject.parentProjectId}
              onClick={() => {
                if (!moveProject || updateMutation.isPending || moveParentId === moveProject.parentProjectId) return;
                const availability = moveParentId
                  ? getParentTargetAvailability(projects, moveProject.id, moveParentId)
                  : null;
                if (availability?.disabled) {
                  setActionError(availability.reason ?? "Selected parent is unavailable.");
                  return;
                }
                updateMutation.mutate({ projectId: moveProject.id, parentProjectId: moveParentId });
              }}
            >
              {updateMutation.isPending ? "Moving…" : moveParentId ? "Move project" : "Detach to root"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!archiveProject} onOpenChange={(open) => !open && setArchiveProject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {archiveProject?.name}?</DialogTitle>
            <DialogDescription>The project will leave the active tree. Its work is not inherited by another project.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveProject(null)}>Cancel</Button>
            <Button variant="destructive" disabled={archiveMutation.isPending} onClick={() => archiveProject && archiveMutation.mutate(archiveProject.id)}>
              {archiveMutation.isPending ? "Archiving…" : "Archive project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
