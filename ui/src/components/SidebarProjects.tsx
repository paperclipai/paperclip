import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Plus } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
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
import { projectFoldersApi } from "../api/projectFolders";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import type { Project, ProjectFolder } from "@paperclipai/shared";

type ProjectSidebarSlot = ReturnType<typeof usePluginSlots>["slots"][number];

// ─── Inline folder name input ─────────────────────────────────────────────────

function FolderNameInput({
  initialValue,
  placeholder,
  onCommit,
  onCancel,
  className,
}: {
  initialValue: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    if (committedRef.current) return;
    const trimmed = value.trim();
    if (trimmed) { committedRef.current = true; onCommit(trimmed); }
    else onCancel();
  }

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "bg-transparent outline-none border-b border-border/60 focus:border-foreground/30 transition-colors w-full",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

// ─── Shared project nav link ──────────────────────────────────────────────────

function ProjectNavLink({
  project,
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  projectSidebarSlots,
  setSidebarOpen,
  indent = false,
}: {
  project: Project;
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
  indent?: boolean;
}) {
  const routeRef = projectRouteRef(project);
  return (
    <div className="flex flex-col gap-0.5">
      <NavLink
        to={`/projects/${routeRef}/issues`}
        state={SIDEBAR_SCROLL_RESET_STATE}
        onClick={() => { if (isMobile) setSidebarOpen(false); }}
        className={cn(
          "flex items-center gap-2.5 py-1.5 text-[13px] font-medium transition-colors",
          indent ? "px-5" : "px-3",
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
        <div className={cn("flex flex-col gap-0.5", indent ? "ml-8" : "ml-5")}>
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

// ─── Flat-mode sortable project item ─────────────────────────────────────────

function SortableProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  project,
  projectSidebarSlots,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={cn(isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <ProjectNavLink
        project={project}
        activeProjectRef={activeProjectRef}
        companyId={companyId}
        companyPrefix={companyPrefix}
        isMobile={isMobile}
        projectSidebarSlots={projectSidebarSlots}
        setSidebarOpen={setSidebarOpen}
      />
    </div>
  );
}

// ─── Folder group (folder-mode only) ─────────────────────────────────────────

function FolderGroup({
  folder,
  projects,
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  projectSidebarSlots,
  setSidebarOpen,
  activeDragId,
  onDropProject,
  onRename,
  onDelete,
}: {
  folder: ProjectFolder | null;
  projects: Project[];
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
  activeDragId: string | null;
  onDropProject: (projectId: string, folderId: string | null) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const folderId = folder?.id ?? null;
  const isUncategorized = folder === null;

  const { setNodeRef: setDropRef, isOver } = useSortable({
    id: `folder:${folderId ?? "__uncategorized__"}`,
  });

  const isDraggingForeign = activeDragId !== null && !projects.some((p) => p.id === activeDragId);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        ref={setDropRef}
        className={cn(
          "group/folder rounded transition-colors",
          isOver && isDraggingForeign && "bg-accent/30",
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => { if (activeDragId) onDropProject(activeDragId, folderId); }}
      >
        <div className="flex items-center gap-0.5 px-2 py-0.5">
          <CollapsibleTrigger className="flex items-center gap-1.5 flex-1 min-w-0 py-1 text-left">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/50 transition-transform shrink-0",
                open && "rotate-90",
              )}
            />
            <Folder className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            {renaming && folder ? (
              <FolderNameInput
                initialValue={folder.name}
                placeholder="Folder name"
                onCommit={(name) => { onRename(folder.id, name); setRenaming(false); }}
                onCancel={() => setRenaming(false)}
                className="text-[11px] font-medium uppercase tracking-wider"
              />
            ) : (
              <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider truncate">
                {folder?.name ?? "Uncategorized"}
              </span>
            )}
          </CollapsibleTrigger>

          {/* Actions — only for real folders */}
          {!isUncategorized && !renaming && (
            <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
              <PopoverTrigger asChild>
                <button
                  className="shrink-0 flex items-center justify-center h-4 w-4 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors opacity-0 group-hover/folder:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Folder options"
                  type="button"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-32 p-1" align="end">
                <button
                  className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left"
                  onClick={() => { setActionsOpen(false); setRenaming(true); setOpen(true); }}
                >
                  Rename
                </button>
                <button
                  className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive text-left"
                  onClick={() => { setActionsOpen(false); if (folder) onDelete(folder.id); }}
                >
                  Delete
                </button>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      <CollapsibleContent>
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5 mt-0.5">
            {projects.map((project) => (
              <SortableProjectItem
                key={project.id}
                activeProjectRef={activeProjectRef}
                companyId={companyId}
                companyPrefix={companyPrefix}
                isMobile={isMobile}
                project={project}
                projectSidebarSlots={projectSidebarSlots}
                setSidebarOpen={setSidebarOpen}
              />
            ))}
          </div>
        </SortableContext>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Main SidebarProjects ─────────────────────────────────────────────────────

export function SidebarProjects() {
  const [open, setOpen] = useState(true);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const queryClient = useQueryClient();

  const foldersEnabled = selectedCompany?.projectFoldersEnabled ?? false;

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: folders } = useQuery({
    queryKey: queryKeys.projectFolders.list(selectedCompanyId!),
    queryFn: () => projectFoldersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && foldersEnabled,
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

  // ── Folder mutations ───────────────────────────────────────────────────────

  const invalidateFolders = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projectFolders.list(selectedCompanyId!) });

  const invalidateProjects = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) });

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => projectFoldersApi.create(selectedCompanyId!, { name }),
    onSuccess: () => invalidateFolders(),
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      projectFoldersApi.update(selectedCompanyId!, id, { name }),
    onSuccess: () => invalidateFolders(),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (id: string) => projectFoldersApi.remove(selectedCompanyId!, id),
    onSuccess: () => { invalidateFolders(); invalidateProjects(); },
  });

  const moveProjectMutation = useMutation({
    mutationFn: ({ projectId, folderId }: { projectId: string; folderId: string | null }) =>
      projectsApi.update(projectId, { folderId }, selectedCompanyId ?? undefined),
    onSuccess: () => invalidateProjects(),
  });

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Flat mode handlers ────────────────────────────────────────────────────

  const handleFlatDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
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

  // ── Folder mode handlers ──────────────────────────────────────────────────

  const handleFolderDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleFolderDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      if (overId.startsWith("folder:")) {
        const rawFolderId = overId.slice("folder:".length);
        const newFolderId = rawFolderId === "__uncategorized__" ? null : rawFolderId;
        const project = visibleProjects.find((p) => p.id === activeId);
        if (project && project.folderId !== newFolderId) {
          moveProjectMutation.mutate({ projectId: activeId, folderId: newFolderId });
        }
        return;
      }

      if (activeId !== overId) {
        const ids = orderedProjects.map((p) => p.id);
        const oldIndex = ids.indexOf(activeId);
        const newIndex = ids.indexOf(overId);
        if (oldIndex !== -1 && newIndex !== -1) {
          persistOrder(arrayMove(ids, oldIndex, newIndex));
        }
      }
    },
    [orderedProjects, persistOrder, visibleProjects, moveProjectMutation],
  );

  const handleDropProject = useCallback(
    (projectId: string, folderId: string | null) => {
      const project = visibleProjects.find((p) => p.id === projectId);
      if (project && project.folderId !== folderId) {
        moveProjectMutation.mutate({ projectId, folderId });
      }
    },
    [visibleProjects, moveProjectMutation],
  );

  // ── Folder grouping ───────────────────────────────────────────────────────

  const folderGroups = useMemo(() => {
    if (!foldersEnabled) return null;

    const sortedFolders = [...(folders ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    const byFolderId = new Map<string | null, Project[]>();

    for (const project of orderedProjects) {
      const key = project.folderId ?? null;
      let arr = byFolderId.get(key);
      if (!arr) { arr = []; byFolderId.set(key, arr); }
      arr.push(project);
    }

    const groups: Array<{ folder: ProjectFolder | null; projects: Project[] }> = [];
    for (const folder of sortedFolders) {
      groups.push({ folder, projects: byFolderId.get(folder.id) ?? [] });
    }
    const uncategorized = byFolderId.get(null) ?? [];
    if (uncategorized.length > 0) {
      groups.push({ folder: null, projects: uncategorized });
    }
    return groups;
  }, [foldersEnabled, folders, orderedProjects]);

  const allDndIds = useMemo(() => {
    if (!foldersEnabled || !folderGroups) return orderedProjects.map((p) => p.id);
    const projectIds = orderedProjects.map((p) => p.id);
    const folderHeaderIds = folderGroups.map(({ folder }) => `folder:${folder?.id ?? "__uncategorized__"}`);
    return [...projectIds, ...folderHeaderIds];
  }, [foldersEnabled, folderGroups, orderedProjects]);

  const activeDragProject = activeDragId
    ? visibleProjects.find((p) => p.id === activeDragId) ?? null
    : null;

  // ── Shared props for project items ────────────────────────────────────────

  const sharedProjectProps = {
    activeProjectRef,
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
    isMobile,
    projectSidebarSlots,
    setSidebarOpen,
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Projects
            </span>
          </CollapsibleTrigger>
          <div className="flex items-center gap-0.5">
            {foldersEnabled && (
              <button
                onClick={(e) => { e.stopPropagation(); setCreatingFolder(true); setOpen(true); }}
                className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
                aria-label="New folder"
                title="New folder"
              >
                <FolderPlus className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); openNewProject(); }}
              className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
              aria-label="New project"
              title="New project"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <CollapsibleContent>
        {/* Inline folder creation input */}
        {foldersEnabled && creatingFolder && (
          <div className="flex items-center gap-1.5 px-3 py-1 mx-1 mb-0.5 border border-dashed border-border/60 rounded">
            <Folder className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <FolderNameInput
              initialValue=""
              placeholder="Folder name"
              onCommit={(name) => {
                createFolderMutation.mutate(name);
                setCreatingFolder(false);
              }}
              onCancel={() => setCreatingFolder(false)}
              className="text-[12px]"
            />
          </div>
        )}

        {!foldersEnabled ? (
          // ── Flat mode ──────────────────────────────────────────────────
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFlatDragEnd}>
            <SortableContext items={orderedProjects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5 mt-0.5">
                {orderedProjects.map((project: Project) => (
                  <SortableProjectItem key={project.id} project={project} {...sharedProjectProps} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          // ── Folder mode ─────────────────────────────────────────────────
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleFolderDragStart}
            onDragEnd={handleFolderDragEnd}
          >
            <SortableContext items={allDndIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5 mt-0.5">
                {(folderGroups ?? []).map(({ folder, projects: groupProjects }) => (
                  <FolderGroup
                    key={folder?.id ?? "__uncategorized__"}
                    folder={folder}
                    projects={groupProjects}
                    activeDragId={activeDragId}
                    onDropProject={handleDropProject}
                    onRename={(id, name) => renameFolderMutation.mutate({ id, name })}
                    onDelete={(id) => deleteFolderMutation.mutate(id)}
                    {...sharedProjectProps}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeDragProject ? (
                <div className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium bg-accent/80 backdrop-blur-sm rounded shadow-sm opacity-90">
                  <span
                    className="shrink-0 h-3.5 w-3.5 rounded-sm"
                    style={{ backgroundColor: activeDragProject.color ?? "#6366f1" }}
                  />
                  <span className="truncate">{activeDragProject.name}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
