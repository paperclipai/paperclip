import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Hexagon,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { projectsApi } from "../api/projects";
import { projectFoldersApi } from "../api/projectFolders";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate, projectUrl } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Project, ProjectFolder } from "@paperclipai/shared";

// ─── Draggable project row ────────────────────────────────────────────────────

function DraggableProjectRow({ project }: { project: Project }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={cn(isDragging && "opacity-60 ring-1 ring-border rounded")}
      {...attributes}
      {...listeners}
    >
      <EntityRow
        title={project.name}
        subtitle={project.description ?? undefined}
        to={projectUrl(project)}
        trailing={
          <div className="flex items-center gap-3">
            {project.targetDate && (
              <span className="text-xs text-muted-foreground">{formatDate(project.targetDate)}</span>
            )}
            <StatusBadge status={project.status} />
          </div>
        }
      />
    </div>
  );
}

// ─── Inline folder name input (create or rename) ──────────────────────────────

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
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    if (committedRef.current) return;
    const trimmed = value.trim();
    if (trimmed) { committedRef.current = true; onCommit(trimmed); }
    else onCancel();
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "bg-transparent outline-none border-b border-border focus:border-foreground/40 transition-colors text-sm w-full",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={commit}
    />
  );
}

// ─── Folder section with drag-to-assign and folder actions ───────────────────

function FolderSection({
  folder,
  projects,
  activeDragId,
  onRename,
  onDelete,
}: {
  folder: ProjectFolder | null;
  projects: Project[];
  activeDragId: string | null;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const folderId = folder?.id ?? null;

  const { setNodeRef, isOver } = useSortable({
    id: `folder:${folderId ?? "__uncategorized__"}`,
  });

  const isDraggingForeign = activeDragId !== null && !projects.some((p) => p.id === activeDragId);
  const Icon = collapsed ? Folder : FolderOpen;
  const isUncategorized = folder === null;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md transition-colors",
        isOver && isDraggingForeign && "ring-2 ring-primary/40 bg-accent/20",
      )}
    >
      {/* Folder header */}
      <div className="group/folder flex items-center gap-1 px-1">
        <button
          className="flex items-center gap-2 flex-1 min-w-0 py-2 px-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => !renaming && setCollapsed((v) => !v)}
          type="button"
        >
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
          />
          <Icon className="h-3.5 w-3.5 shrink-0" />
          {renaming && folder ? (
            <FolderNameInput
              initialValue={folder.name}
              placeholder="Folder name"
              onCommit={(name) => { onRename(folder.id, name); setRenaming(false); }}
              onCancel={() => setRenaming(false)}
              className="text-xs font-medium uppercase tracking-wide"
            />
          ) : (
            <>
              <span className="font-medium text-xs uppercase tracking-wide truncate flex-1">
                {folder?.name ?? "Uncategorized"}
              </span>
              <span className="text-xs text-muted-foreground/50 shrink-0">{projects.length}</span>
            </>
          )}
        </button>

        {/* Actions (rename/delete) — only for real folders */}
        {!isUncategorized && !renaming && (
          <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
            <PopoverTrigger asChild>
              <button
                className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors opacity-0 group-hover/folder:opacity-100"
                onClick={(e) => e.stopPropagation()}
                aria-label="Folder options"
                type="button"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="end">
              <button
                className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left"
                onClick={() => { setActionsOpen(false); setRenaming(true); setCollapsed(false); }}
              >
                Rename
              </button>
              <button
                className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive text-left"
                onClick={() => {
                  setActionsOpen(false);
                  if (folder && window.confirm(`Delete "${folder.name}"? Projects inside will move to Uncategorized.`)) {
                    onDelete(folder.id);
                  }
                }}
              >
                Delete folder
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* Projects in this folder */}
      {!collapsed && (
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className="border border-border ml-4 mr-0 rounded-sm">
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 px-4 py-3 italic">
                Drag projects here
              </p>
            ) : (
              projects.map((project) => (
                <DraggableProjectRow key={project.id} project={project} />
              ))
            )}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

// ─── Projects page ─────────────────────────────────────────────────────────────

export function Projects() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const foldersEnabled = selectedCompany?.projectFoldersEnabled ?? false;

  // Inline folder creation state
  const [creatingFolder, setCreatingFolder] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: !!selectedCompanyId,
  });

  const { data: folders } = useQuery({
    queryKey: queryKeys.projectFolders.list(selectedCompanyId!),
    queryFn: () => projectFoldersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && foldersEnabled,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  const { orderedProjects, persistOrder } = useProjectOrder({
    projects,
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

  // ── DnD ───────────────────────────────────────────────────────────────────

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      if (overId.startsWith("folder:")) {
        const rawFolderId = overId.slice("folder:".length);
        const newFolderId = rawFolderId === "__uncategorized__" ? null : rawFolderId;
        const project = projects.find((p) => p.id === activeId);
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
    [orderedProjects, persistOrder, projects, moveProjectMutation],
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
    groups.push({ folder: null, projects: byFolderId.get(null) ?? [] });
    return groups;
  }, [foldersEnabled, folders, orderedProjects]);

  const allDndIds = useMemo(() => {
    if (!foldersEnabled || !folderGroups) return orderedProjects.map((p) => p.id);
    const projectIds = orderedProjects.map((p) => p.id);
    const folderHeaderIds = folderGroups.map(
      ({ folder }) => `folder:${folder?.id ?? "__uncategorized__"}`,
    );
    return [...projectIds, ...folderHeaderIds];
  }, [foldersEnabled, folderGroups, orderedProjects]);

  const activeDragProject = activeDragId ? projects.find((p) => p.id === activeDragId) ?? null : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-end gap-2">
        {foldersEnabled && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreatingFolder(true)}
          >
            <FolderPlus className="h-4 w-4 mr-1" />
            New folder
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && !creatingFolder && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {/* Inline new-folder input */}
      {foldersEnabled && creatingFolder && (
        <div className="flex items-center gap-2 border border-dashed border-border rounded-md px-4 py-2.5">
          <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
          <FolderNameInput
            initialValue=""
            placeholder="Folder name"
            onCommit={(name) => {
              createFolderMutation.mutate(name);
              setCreatingFolder(false);
            }}
            onCancel={() => setCreatingFolder(false)}
            className="text-sm"
          />
        </div>
      )}

      {projects.length > 0 && !foldersEnabled && (
        // ── Flat list ──────────────────────────────────────────────────────
        <div className="border border-border">
          {orderedProjects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">{formatDate(project.targetDate)}</span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}

      {foldersEnabled && (
        // ── Folder mode ────────────────────────────────────────────────────
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={allDndIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {(folderGroups ?? []).map(({ folder, projects: groupProjects }) => (
                <FolderSection
                  key={folder?.id ?? "__uncategorized__"}
                  folder={folder}
                  projects={groupProjects}
                  activeDragId={activeDragId}
                  onRename={(id, name) => renameFolderMutation.mutate({ id, name })}
                  onDelete={(id) => deleteFolderMutation.mutate(id)}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeDragProject ? (
              <div className="border border-border bg-card shadow-sm rounded-sm opacity-90">
                <EntityRow
                  title={activeDragProject.name}
                  subtitle={activeDragProject.description ?? undefined}
                  trailing={<StatusBadge status={activeDragProject.status} />}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
