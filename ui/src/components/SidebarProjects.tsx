import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Plus } from "lucide-react";
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
import { cn, projectRouteRef } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarSection, type SidebarSectionRadioChoice } from "./SidebarSection";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
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

const PROJECT_SORT_CHOICES: SidebarSectionRadioChoice[] = [
  { value: "top", label: "Top" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Recent" },
];

type ProjectItemProps = {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
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

function ProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  project,
  projectSidebarSlots,
  setSidebarOpen,
  isDragging = false,
}: ProjectItemProps) {
  const routeRef = projectRouteRef(project);

  return (
    <div className="flex flex-col gap-0.5">
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
          "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
          activeProjectRef === routeRef || activeProjectRef === project.id
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <span
          className="shrink-0 h-3.5 w-3.5 rounded-sm"
          style={{ backgroundColor: project.color ?? "#6366f1" }}
        />
        <span className="flex-1 truncate">{project.name}</span>
        {project.pauseReason === "budget" ? <BudgetSidebarMarker title="Project paused by budget" /> : null}
      </NavLink>
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
  const [open, setOpen] = useState(true);
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

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
  const sortModeStorageKey = useMemo(() => {
    if (!selectedCompanyId) return null;
    return getProjectSortModeStorageKey(selectedCompanyId, currentUserId);
  }, [currentUserId, selectedCompanyId]);
  const [sortMode, setSortMode] = useState<ProjectSidebarSortMode>(() => {
    if (!sortModeStorageKey) return "top";
    return readProjectSortMode(sortModeStorageKey);
  });

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => !project.archivedAt),
    [projects],
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

  const renderProject = (project: Project) => (
    <ProjectItem
      key={project.id}
      activeProjectRef={activeProjectRef}
      companyId={selectedCompanyId}
      companyPrefix={selectedCompany?.issuePrefix ?? null}
      isMobile={isMobile}
      project={project}
      projectSidebarSlots={projectSidebarSlots}
      setSidebarOpen={setSidebarOpen}
    />
  );

  return (
    <SidebarSection
      label="Projects"
      collapsible={{ open, onOpenChange: setOpen }}
      headerAction={{
        ariaLabel: "New project",
        icon: Plus,
        onClick: openNewProject,
      }}
      menu={{
        ariaLabel: "Projects section actions",
        actions: [
          { type: "item", label: "Browse projects", icon: FolderOpen, href: "/projects" },
          { type: "separator" },
        ],
        radioLabel: "Project sort",
        radioChoices: PROJECT_SORT_CHOICES,
        radioValue: sortMode,
        onRadioValueChange: persistSortMode,
      }}
    >
      {isTopMode ? (
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
                  setSidebarOpen={setSidebarOpen}
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
