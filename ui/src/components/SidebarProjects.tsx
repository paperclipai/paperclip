import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus, Search, X } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { sortProjectsByRecentActivity } from "../lib/project-recency";
import { useProjectPins } from "../hooks/useProjectPins";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { PROJECT_COLORS, type Project } from "@paperclipai/shared";
import { ProjectStarButton } from "./ProjectStarButton";
import { ProjectLabelPills } from "./ProjectLabelPills";
import {
  buildProjectWorkspaceInput,
  deriveProjectNameFromRepoUrl,
  looksLikeProjectRepoUrl,
} from "../lib/project-workspace";

type ProjectSidebarSlot = ReturnType<typeof usePluginSlots>["slots"][number];

function buildSidebarProjectSearchText(project: Project) {
  return [
    project.name,
    project.urlKey,
    project.description,
    project.status,
    project.status.replaceAll("_", " "),
    ...(project.labels ?? []).map((label) => label.name),
    ...project.goals.map((goal) => goal.title),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function SortableProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  isStarred,
  onToggleStarred,
  project,
  projectSidebarSlots,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  isStarred: boolean;
  onToggleStarred: (projectId: string) => void;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
}) {
  const routeRef = projectRouteRef(project);

  return (
    <div>
      <div className="flex flex-col gap-0.5">
        <div className="group/project flex items-center gap-1 pr-1">
          <NavLink
            to={`/projects/${routeRef}/issues`}
            state={SIDEBAR_SCROLL_RESET_STATE}
            onClick={() => {
              if (isMobile) setSidebarOpen(false);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
              activeProjectRef === routeRef || activeProjectRef === project.id
                ? "bg-accent text-foreground"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span
              className="shrink-0 h-3.5 w-3.5 rounded-sm"
              style={{ backgroundColor: project.color ?? "#6366f1" }}
            />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">{project.name}</span>
              <ProjectLabelPills labels={project.labels} variant="dense" />
            </span>
            {project.pauseReason === "budget" ? <BudgetSidebarMarker title="Project paused by budget" /> : null}
          </NavLink>
          <ProjectStarButton
            starred={isStarred}
            projectName={project.name}
            onToggle={() => onToggleStarred(project.id)}
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors opacity-100",
              isStarred
                ? "text-foreground"
                : "hover:bg-accent/50 hover:text-foreground",
            )}
            iconClassName="h-3 w-3"
          />
        </div>
        {projectSidebarSlots.length > 0 && (
          <div className="ml-5 flex flex-col gap-0.5">
            {projectSidebarSlots.map((slot) => (
              <PluginSlotMount
                key={`${project.id}:${slot.pluginKey}:${slot.id}`}
                slot={slot}
                context={{
                  companyId,
                  companyPrefix,
                  projectId: project.id,
                  projectRef: routeRef,
                  entityId: project.id,
                  entityType: "project",
                }}
                missingBehavior="placeholder"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SidebarProjects() {
  const [open, setOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddRepoUrl, setQuickAddRepoUrl] = useState("");
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const quickAddInputRef = useRef<HTMLInputElement | null>(null);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { slots: projectSidebarSlots } = usePluginSlots({
    slotTypes: ["projectSidebarItem"],
    entityType: "project",
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const orderedProjects = useMemo(
    () => sortProjectsByRecentActivity(visibleProjects),
    [visibleProjects],
  );
  const {
    orderedProjects: starredProjectsFirst,
    pinnedIds: starredProjectIds,
    togglePinned: toggleStarred,
  } = useProjectPins({
    projects: orderedProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredProjects = useMemo(() => {
    if (!normalizedSearchQuery) return starredProjectsFirst;
    return starredProjectsFirst.filter((project) =>
      buildSidebarProjectSearchText(project).includes(normalizedSearchQuery),
    );
  }, [starredProjectsFirst, normalizedSearchQuery]);

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;

  const createProject = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      if (!selectedCompanyId) throw new Error("Select a company before creating a project.");
      return projectsApi.create(selectedCompanyId, data);
    },
  });

  function resetQuickAdd() {
    setQuickAddRepoUrl("");
    setQuickAddError(null);
  }

  function closeQuickAdd() {
    setQuickAddOpen(false);
    resetQuickAdd();
  }

  useEffect(() => {
    if (!quickAddOpen) return;
    quickAddInputRef.current?.focus();
  }, [quickAddOpen]);

  useEffect(() => {
    closeQuickAdd();
    // We intentionally reset the inline form when the company changes so a pasted
    // repo URL cannot accidentally land on a different company.
  }, [selectedCompanyId]);

  async function handleQuickAddSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCompanyId) return;

    const repoUrl = quickAddRepoUrl.trim();
    if (!repoUrl) {
      setQuickAddError("Repo URL is required.");
      return;
    }

    if (!looksLikeProjectRepoUrl(repoUrl)) {
      setQuickAddError("Repo must use a valid GitHub or GitHub Enterprise repo URL.");
      return;
    }

    setQuickAddError(null);

    try {
      const created = await createProject.mutateAsync({
        name: deriveProjectNameFromRepoUrl(repoUrl),
        status: "planned",
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        workspace: buildProjectWorkspaceInput({ repoUrl }),
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) }),
      ]);

      closeQuickAdd();
      if (isMobile) setSidebarOpen(false);
      navigate(`/projects/${projectRouteRef(created)}/issues`, {
        state: SIDEBAR_SCROLL_RESET_STATE,
      });
    } catch (error) {
      setQuickAddError(error instanceof Error ? error.message : "Failed to create project.");
    }
  }

  function handleOpenFullProjectForm() {
    closeQuickAdd();
    openNewProject();
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) closeQuickAdd();
      }}
    >
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Projects
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!selectedCompanyId) return;
              setOpen(true);
              setQuickAddOpen((current) => {
                const nextOpen = !current;
                if (!nextOpen) resetQuickAdd();
                return nextOpen;
              });
            }}
            type="button"
            disabled={!selectedCompanyId}
            className={cn(
              "flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 transition-colors",
              selectedCompanyId
                ? "hover:text-foreground hover:bg-accent/50"
                : "cursor-not-allowed opacity-50",
            )}
            aria-label={quickAddOpen ? "Close quick add" : "Quick add project"}
          >
            <Plus className={cn("h-3 w-3 transition-transform", quickAddOpen && "rotate-45")} />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        {quickAddOpen ? (
          <form className="px-3 pb-2" onSubmit={handleQuickAddSubmit}>
            <div className="rounded-md border border-border/70 bg-accent/20 p-2">
              <div className="flex items-center gap-2">
                <input
                  ref={quickAddInputRef}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none"
                  value={quickAddRepoUrl}
                  onChange={(event) => {
                    setQuickAddRepoUrl(event.target.value);
                    if (quickAddError) setQuickAddError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeQuickAdd();
                    }
                  }}
                  placeholder="https://github.com/org/repo"
                  aria-label="Repo URL"
                />
                <button
                  type="submit"
                  disabled={createProject.isPending}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center justify-center rounded px-2 text-[11px] font-medium transition-colors",
                    createProject.isPending
                      ? "cursor-wait bg-muted text-muted-foreground"
                      : "bg-foreground text-background hover:opacity-90",
                  )}
                >
                  {createProject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className={cn(
                  "min-w-0 text-[11px]",
                  quickAddError ? "text-destructive" : "text-muted-foreground",
                )}>
                  {quickAddError ?? "Paste a repo URL to create a project instantly."}
                </p>
                <button
                  type="button"
                  onClick={handleOpenFullProjectForm}
                  className="shrink-0 text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Full form
                </button>
              </div>
            </div>
          </form>
        ) : null}
        {starredProjectsFirst.length > 0 && (
          <div className="relative mx-3 mt-0.5 mb-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search projects..."
              aria-label="Search projects in sidebar"
              className="h-7 rounded-sm border-border/70 bg-background/60 pl-7 pr-7 text-xs shadow-none"
            />
            {searchQuery.trim() && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
                aria-label="Clear project search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        <div className="flex flex-col gap-0.5 mt-0.5">
          {filteredProjects.map((project: Project) => (
            <SortableProjectItem
              key={project.id}
              activeProjectRef={activeProjectRef}
              companyId={selectedCompanyId}
              companyPrefix={selectedCompany?.issuePrefix ?? null}
              isMobile={isMobile}
              isStarred={starredProjectIds.includes(project.id)}
              onToggleStarred={toggleStarred}
              project={project}
              projectSidebarSlots={projectSidebarSlots}
              setSidebarOpen={setSidebarOpen}
            />
          ))}
          {normalizedSearchQuery && filteredProjects.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">No projects found.</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
