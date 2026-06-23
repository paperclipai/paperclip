import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Loader2, LogOut, MoreHorizontal, Plus } from "lucide-react";
import {
  DndContext,
  MouseSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { resourceMembershipState, useResourceMembershipMutation, useResourceMemberships } from "../hooks/useResourceMemberships";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { ProjectTile } from "./ProjectTile";
import { SidebarSection, type SidebarSectionRadioChoice } from "./SidebarSection";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { t, useTranslation } from "@/i18n";
import {
  getProjectSortModeStorageKey,
  PROJECT_SORT_MODE_UPDATED_EVENT,
  readProjectSortMode,
  type ProjectSortModeUpdatedDetail,
  type ProjectSidebarSortMode,
  writeProjectSortMode,
} from "../lib/project-order";
import type { Project } from "@paperclipai/shared";

type ProjectSidebarSlot = ReturnType<typeof usePluginSlots>["slots"][number];

function getProjectSortChoices(): SidebarSectionRadioChoice[] {
  return [
    { value: "top", label: t("components.sidebarProjects.sortTop", { defaultValue: "Top" }) },
    { value: "alphabetical", label: t("components.sidebarProjects.sortAlphabetical", { defaultValue: "Alphabetical" }) },
    { value: "recent", label: t("components.sidebarProjects.sortRecent", { defaultValue: "Recent" }) },
  ];
}
const REORDER_POINTER_MEDIA = "(hover: hover) and (pointer: fine)";

type ProjectItemProps = {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  rail: boolean;
  setSidebarOpen: (open: boolean) => void;
  onLeaveProject: (project: Project) => void;
  leaving?: boolean;
  isDragging?: boolean;
};

function projectTimestamp(project: Project): number {
  const updated = new Date(project.updatedAt).getTime();
  if (Number.isFinite(updated)) return updated;
  const created = new Date(project.createdAt).getTime();
  return Number.isFinite(created) ? created : 0;
}

function sortProjects(projects: Project[], sortMode: ProjectSidebarSortMode): Project[] {
  if (sortMode === "top") return projects;
  const sorted = [...projects];
  if (sortMode === "alphabetical") {
    sorted.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return sorted;
  }
  sorted.sort((left, right) => {
    const timeDiff = projectTimestamp(right) - projectTimestamp(left);
    return timeDiff !== 0 ? timeDiff : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  return sorted;
}

function hasFineReorderPointer() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(REORDER_POINTER_MEDIA).matches;
}

function useFineReorderPointer() {
  const [matches, setMatches] = useState(hasFineReorderPointer);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REORDER_POINTER_MEDIA);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return matches;
}

function ProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  project,
  projectSidebarSlots,
  rail,
  setSidebarOpen,
  onLeaveProject,
  leaving = false,
  isDragging = false,
}: ProjectItemProps) {
  const { t } = useTranslation();
  const routeRef = projectRouteRef(project);

  const link = (
    <NavLink
      to={`/projects/${routeRef}/issues`}
      state={SIDEBAR_SCROLL_RESET_STATE}
      onClick={(e) => {
        if (isDragging) {
          e.preventDefault();
          return;
        }
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 pr-8 pointer-coarse:py-1 text-[13px] font-medium transition-colors",
        activeProjectRef === routeRef || activeProjectRef === project.id
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="xs" />
      <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "flex-1 truncate"}>{project.name}</span>
      {!rail && project.pauseReason === "budget" ? <BudgetSidebarMarker title={t("components.sidebarProjects.projectPausedByBudget", { defaultValue: "Project paused by budget" })} /> : null}
    </NavLink>
  );

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group/project relative flex items-center">
        {rail ? (
          // Anchor the tooltip to a wrapper, not the NavLink: Radix `asChild`
          // (Slot) drops React Router's function className, which would strip
          // `flex` off the <a> and let the in-flow label stack under the icon,
          // growing the row. Keeping the <a> out of Slot preserves a 1:1 row
          // height with the expanded state so the icon never moves (PAP-10676).
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="min-w-0 flex-1">{link}</div>
            </TooltipTrigger>
            <TooltipContent side="right">{project.name}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}

        {!rail && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 transition-opacity data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
                isMobile
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100",
              )}
              aria-label={t("components.sidebarProjects.openActionsFor", { name: project.name, defaultValue: "Open actions for {{name}}" })}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onClick={() => {
                if (leaving) return;
                onLeaveProject(project);
              }}
              disabled={leaving}
            >
              {leaving ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <LogOut className="size-4" />}
              <span>{leaving ? t("components.sidebarProjects.leaving", { defaultValue: "Leaving..." }) : t("components.sidebarProjects.leaveProject", { defaultValue: "Leave project" })}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
      {!rail && projectSidebarSlots.length > 0 && (
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
  );
}

function SortableProjectItem(props: ProjectItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.project.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <ProjectItem {...props} isDragging={isDragging} />
    </div>
  );
}

export function SidebarProjects() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const fineReorderPointer = useFineReorderPointer();
  const location = useLocation();

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
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
  const sortModeStorageKey = useMemo(() => {
    if (!selectedCompanyId) return null;
    return getProjectSortModeStorageKey(selectedCompanyId, currentUserId);
  }, [currentUserId, selectedCompanyId]);
  const [sortMode, setSortMode] = useState<ProjectSidebarSortMode>(() => {
    if (!sortModeStorageKey) return "top";
    return readProjectSortMode(sortModeStorageKey);
  });

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => {
      if (project.archivedAt) return false;
      if (!membershipsQuery.isSuccess) return true;
      return resourceMembershipState(membershipsQuery.data, "project", project.id) !== "left";
    }),
    [membershipsQuery.data, membershipsQuery.isSuccess, projects],
  );
  const { orderedProjects, persistOrder } = useProjectOrder({
    projects: visibleProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const sortedProjects = useMemo(
    () => sortProjects(orderedProjects, sortMode),
    [orderedProjects, sortMode],
  );
  const isTopMode = sortMode === "top";
  const canReorderProjects = isTopMode && !isMobile && fineReorderPointer;

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;
  const sensors = useSensors(
    // Project reordering is intentionally desktop-only; touch should remain tap/scroll behavior.
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  useEffect(() => {
    if (!sortModeStorageKey) {
      setSortMode("top");
      return;
    }
    setSortMode(readProjectSortMode(sortModeStorageKey));
  }, [sortModeStorageKey]);

  useEffect(() => {
    if (!sortModeStorageKey) return;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== sortModeStorageKey) return;
      setSortMode(readProjectSortMode(sortModeStorageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSortModeUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== sortModeStorageKey) return;
      setSortMode(detail.sortMode);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    };
  }, [sortModeStorageKey]);

  const persistSortMode = useCallback(
    (value: string) => {
      const nextSortMode: ProjectSidebarSortMode =
        value === "alphabetical" || value === "recent" ? value : "top";
      setSortMode(nextSortMode);
      if (sortModeStorageKey) {
        writeProjectSortMode(sortModeStorageKey, nextSortMode);
      }
    },
    [sortModeStorageKey],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!isTopMode) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedProjects.map((project) => project.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [isTopMode, orderedProjects, persistOrder],
  );

  const leaveProject = useCallback(
    (project: Project) => membershipMutation.mutate({
      resourceType: "project",
      resourceId: project.id,
      resourceName: project.name,
      state: "left",
    }),
    [membershipMutation],
  );
  const projectLeaving = useCallback(
    (project: Project) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "project" &&
      membershipMutation.variables.resourceId === project.id,
    [membershipMutation.isPending, membershipMutation.variables],
  );

  const renderProject = (project: Project) => (
    <ProjectItem
      key={project.id}
      activeProjectRef={activeProjectRef}
      companyId={selectedCompanyId}
      companyPrefix={selectedCompany?.issuePrefix ?? null}
      isMobile={isMobile}
      project={project}
      projectSidebarSlots={projectSidebarSlots}
      rail={rail}
      setSidebarOpen={setSidebarOpen}
      onLeaveProject={leaveProject}
      leaving={projectLeaving(project)}
    />
  );

  return (
    <SidebarSection
      label={t("components.sidebarProjects.sectionLabel", { defaultValue: "Projects" })}
      collapsible={{ open, onOpenChange: setOpen }}
      headerAction={{
        ariaLabel: t("components.sidebarProjects.newProject", { defaultValue: "New project" }),
        icon: Plus,
        onClick: openNewProject,
      }}
      menu={{
        ariaLabel: t("components.sidebarProjects.sectionActions", { defaultValue: "Projects section actions" }),
        actions: [
          { type: "item", label: t("components.sidebarProjects.browseProjects", { defaultValue: "Browse projects" }), icon: FolderOpen, href: "/projects" },
          { type: "separator" },
        ],
        radioLabel: t("components.sidebarProjects.projectSort", { defaultValue: "Project sort" }),
        radioChoices: getProjectSortChoices(),
        radioValue: sortMode,
        onRadioValueChange: persistSortMode,
      }}
    >
      {canReorderProjects ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedProjects.map((project) => project.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-0.5">
              {orderedProjects.map((project: Project) => (
                <SortableProjectItem
                  key={project.id}
                  activeProjectRef={activeProjectRef}
                  companyId={selectedCompanyId}
                  companyPrefix={selectedCompany?.issuePrefix ?? null}
                  isMobile={isMobile}
                  project={project}
                  projectSidebarSlots={projectSidebarSlots}
                  rail={rail}
                  setSidebarOpen={setSidebarOpen}
                  onLeaveProject={leaveProject}
                  leaving={projectLeaving(project)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="flex flex-col gap-0.5">
          {sortedProjects.map((project: Project) => renderProject(project))}
        </div>
      )}
    </SidebarSection>
  );
}
