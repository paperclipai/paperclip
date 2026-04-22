import { useCallback, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
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
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { buildProjectHierarchyEntries } from "../lib/project-hierarchy";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { ProjectCodeBadge } from "./ProjectCodeBadge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import type { Project } from "@paperclipai/shared";

type ProjectSidebarSlot = ReturnType<typeof usePluginSlots>["slots"][number];

function SortableProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  depth,
  isMobile,
  project,
  projectSidebarSlots,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  depth: number;
  isMobile: boolean;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const routeRef = projectRouteRef(project);

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
            "flex min-w-0 items-center gap-2.5 py-1.5 pr-3 text-[13px] font-medium transition-colors",
            activeProjectRef === routeRef || activeProjectRef === project.id
              ? "bg-accent text-foreground"
              : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          )}
          style={{ paddingLeft: `${0.75 + Math.min(depth, 6) * 1}rem` }}
        >
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-sm"
            style={{ backgroundColor: project.color ?? "#6366f1" }}
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate">{project.name}</span>
            <ProjectCodeBadge code={project.code} className="hidden max-w-[4rem] lg:inline-flex" />
          </span>
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
    </div>
  );
}

export function SidebarProjects() {
  const [open, setOpen] = useState(true);
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
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

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const { orderedProjects, persistOrder } = useProjectOrder({
    projects: visibleProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const projectEntries = useMemo(
    () => buildProjectHierarchyEntries(orderedProjects, orderedProjects),
    [orderedProjects],
  );

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;
  const sensors = useSensors(
    // Project reordering is intentionally desktop-only; touch should remain tap/scroll behavior.
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedProjects.map((project) => project.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedProjects, persistOrder],
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 opacity-0 transition-transform group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
              Projects
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewProject();
            }}
            className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="New project"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedProjects.map((project) => project.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="mt-0.5 flex flex-col gap-0.5">
              {projectEntries.map(({ project, depth }) => (
                <SortableProjectItem
                  key={project.id}
                  activeProjectRef={activeProjectRef}
                  companyId={selectedCompanyId}
                  companyPrefix={selectedCompany?.issuePrefix ?? null}
                  depth={depth}
                  isMobile={isMobile}
                  project={project}
                  projectSidebarSlots={projectSidebarSlots}
                  setSidebarOpen={setSidebarOpen}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CollapsibleContent>
    </Collapsible>
  );
}
