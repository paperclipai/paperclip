import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Boxes,
  Check,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Hash,
  Home,
  Layers,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  User,
} from "lucide-react";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FolderSwatch, type FolderSelection } from "./FolderControls";
import {
  buildSkillFolderTree,
  folderBreadcrumbTrail,
  isBundledFolder,
  isProjectsFolder,
  reservedRootLabel,
  subtreeFolderIds,
  treeFromResult,
  type FolderTreeNode,
  type SkillFolderTreeModel,
} from "./skill-folder-tree";

export {
  buildSkillFolderTree,
  folderBreadcrumbTrail,
  isBundledFolder,
  isProjectsFolder,
  subtreeFolderIds,
  treeFromResult,
  type SkillFolderTreeModel,
};

export interface TagFacet {
  slug: string;
  count: number;
}

/** Whether a folder's own actions (rename/recolor/subfolder/delete) are offered. */
function folderIsEditable(folder: FolderListItem): boolean {
  return !folder.systemKey && !isBundledFolder(folder) && !isProjectsFolder(folder);
}

function ancestorIds(model: SkillFolderTreeModel, folderId: string): string[] {
  return folderBreadcrumbTrail(model, folderId)
    .map((folder) => folder.id)
    .filter((id) => id !== folderId);
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

export function SkillFolderRail({
  result,
  selection,
  loading = false,
  tags,
  activeTag,
  onSelect,
  onSelectTag,
  onCreateFolder,
  onRenameFolder,
  onEditFolder,
  onDeleteFolder,
  onEnsureMyFolder,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  loading?: boolean;
  tags: TagFacet[];
  activeTag: string | null;
  onSelect: (selection: FolderSelection) => void;
  onSelectTag: (slug: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: FolderListItem, name: string) => void;
  onEditFolder: (folder: FolderListItem) => void;
  onDeleteFolder: (folder: FolderListItem) => void;
  onEnsureMyFolder?: () => void;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Auto-expand the ancestors of the current selection so it's always visible.
  useEffect(() => {
    if (selection === "all" || selection === "unfiled") return;
    const ancestors = ancestorIds(model, selection);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [model, selection]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startRename(folder: FolderListItem) {
    setRenamingId(folder.id);
    setRenameDraft(folder.name);
  }

  function commitRename(folder: FolderListItem) {
    const name = renameDraft.trim();
    if (name && name !== folder.name) onRenameFolder(folder, name);
    setRenamingId(null);
  }

  const allCount = result?.allCount ?? 0;
  const unfiledCount = result?.unfiledCount ?? 0;

  return (
    <nav
      aria-label="Skill folders"
      className="hidden w-(--sz-folder-rail) shrink-0 flex-col overflow-y-auto border-r border-border pr-3 md:flex"
    >
      <div className="mb-2 flex items-center justify-between gap-2 pt-0.5">
        <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          Folders
        </div>
        <Button variant="ghost" size="icon-sm" title="New folder" onClick={() => onCreateFolder(null)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-7 rounded-md bg-muted/60" />
          <div className="h-7 rounded-md bg-muted/40" />
          <div className="h-7 rounded-md bg-muted/30" />
        </div>
      ) : (
        <div className="space-y-0.5">
          <VirtualRow
            active={selection === "all"}
            label="All skills"
            count={allCount}
            icon={<Layers className="h-3.5 w-3.5" />}
            onSelect={() => onSelect("all")}
          />

          {/* My Skills — personal namespace */}
          {model.my ? (
            <TreeBranch
              node={model.my}
              depth={0}
              selection={selection}
              expanded={expanded}
              renamingId={renamingId}
              renameDraft={renameDraft}
              rootLabel="My Skills"
              rootIcon={<User className="h-3.5 w-3.5" />}
              onToggle={toggle}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onStartRename={startRename}
              onRenameDraftChange={setRenameDraft}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingId(null)}
            />
          ) : onEnsureMyFolder ? (
            <VirtualRow
              active={false}
              label="My Skills"
              count={0}
              icon={<User className="h-3.5 w-3.5" />}
              muted
              onSelect={onEnsureMyFolder}
            />
          ) : null}

          {/* Company — plain top-level company folders */}
          <RailHeading label="Company" onCreate={() => onCreateFolder(null)} />
          {model.company.length > 0 ? (
            model.company.map((node) => (
              <TreeBranch
                key={node.folder.id}
                node={node}
                depth={0}
                selection={selection}
                expanded={expanded}
                renamingId={renamingId}
                renameDraft={renameDraft}
                onToggle={toggle}
                onSelect={onSelect}
                onCreateFolder={onCreateFolder}
                onEditFolder={onEditFolder}
                onDeleteFolder={onDeleteFolder}
                onStartRename={startRename}
                onRenameDraftChange={setRenameDraft}
                onRenameCommit={commitRename}
                onRenameCancel={() => setRenamingId(null)}
              />
            ))
          ) : (
            <div className="px-2 py-1 text-xs text-muted-foreground">No company folders yet.</div>
          )}

          {/* Projects — auto-managed, read-only structure */}
          {model.projects ? (
            <TreeBranch
              node={model.projects}
              depth={0}
              selection={selection}
              expanded={expanded}
              renamingId={renamingId}
              renameDraft={renameDraft}
              rootLabel="Projects"
              rootIcon={<Boxes className="h-3.5 w-3.5" />}
              onToggle={toggle}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onStartRename={startRename}
              onRenameDraftChange={setRenameDraft}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingId(null)}
            />
          ) : (
            <VirtualRow
              active={false}
              label="Projects"
              count={0}
              icon={<Boxes className="h-3.5 w-3.5" />}
              muted
              disabled
              onSelect={() => undefined}
            />
          )}

          {/* Bundled — read-only */}
          {model.bundled ? (
            <TreeBranch
              node={model.bundled}
              depth={0}
              selection={selection}
              expanded={expanded}
              renamingId={renamingId}
              renameDraft={renameDraft}
              rootLabel="Bundled"
              rootIcon={<Boxes className="h-3.5 w-3.5" />}
              onToggle={toggle}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onStartRename={startRename}
              onRenameDraftChange={setRenameDraft}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingId(null)}
            />
          ) : null}

          <div className="px-2 pb-1 pt-3 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            System
          </div>
          <VirtualRow
            active={selection === "unfiled"}
            label="Unfiled"
            count={unfiledCount}
            icon={<FolderSwatch color={null} />}
            onSelect={() => onSelect("unfiled")}
          />
        </div>
      )}

      {/* Tags facet — folders locate, tags describe. Filters within the subtree. */}
      {tags.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-1.5 flex items-center gap-1.5 px-2 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            <Hash className="h-3 w-3" />
            Tags
          </div>
          <div className="flex flex-wrap gap-1.5 px-1">
            {activeTag ? (
              <button
                type="button"
                onClick={() => onSelectTag(null)}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-accent/60 px-2 py-0.5 text-xs text-foreground"
              >
                {activeTag}
                <Check className="h-3 w-3" />
              </button>
            ) : null}
            {tags
              .filter((tag) => tag.slug !== activeTag)
              .map((tag) => (
                <button
                  key={tag.slug}
                  type="button"
                  onClick={() => onSelectTag(tag.slug)}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  <span className="max-w-32 truncate">{tag.slug}</span>
                  <span className="text-(length:--text-micro) opacity-70">{tag.count}</span>
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

function RailHeading({ label, onCreate }: { label: string; onCreate: () => void }) {
  return (
    <div className="group/heading flex items-center justify-between px-2 pb-0.5 pt-3">
      <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <button
        type="button"
        onClick={onCreate}
        title={`New ${label.toLowerCase()} folder`}
        className="opacity-0 transition-opacity group-hover/heading:opacity-100"
      >
        <Plus className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

function VirtualRow({
  active,
  label,
  count,
  icon,
  muted = false,
  disabled = false,
  onSelect,
}: {
  active: boolean;
  label: string;
  count: number;
  icon: ReactNode;
  muted?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "grid w-full grid-cols-(--gtc-folder-row) items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/40",
        active ? "bg-accent/60 text-foreground" : muted ? "text-muted-foreground/70" : "text-muted-foreground",
      )}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

/** A folder node and (when expanded) its descendants, indented by depth. */
function TreeBranch({
  node,
  depth,
  selection,
  expanded,
  renamingId,
  renameDraft,
  rootLabel,
  rootIcon,
  onToggle,
  onSelect,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onStartRename,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
}: {
  node: FolderTreeNode;
  depth: number;
  selection: FolderSelection;
  expanded: Set<string>;
  renamingId: string | null;
  renameDraft: string;
  rootLabel?: string;
  rootIcon?: ReactNode;
  onToggle: (id: string) => void;
  onSelect: (selection: FolderSelection) => void;
  onCreateFolder: (parentId: string | null) => void;
  onEditFolder: (folder: FolderListItem) => void;
  onDeleteFolder: (folder: FolderListItem) => void;
  onStartRename: (folder: FolderListItem) => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: (folder: FolderListItem) => void;
  onRenameCancel: () => void;
}) {
  const { folder, children } = node;
  const isOpen = expanded.has(folder.id);
  const active = selection === folder.id;
  const editable = folderIsEditable(folder);
  const canNest = folder.systemKey !== "my" && !isBundledFolder(folder) && !isProjectsFolder(folder) && folder.depth < 4;
  const label = rootLabel ?? folder.name;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md pr-1 text-sm transition-colors hover:bg-accent/40",
          active ? "bg-accent/60 text-foreground" : "text-muted-foreground",
        )}
        style={{ paddingLeft: `${depth * 0.75}rem` }}
      >
        <button
          type="button"
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
          className={cn(
            "flex h-6 w-4 items-center justify-center text-muted-foreground",
            children.length === 0 && "invisible",
          )}
          onClick={() => onToggle(folder.id)}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(folder.id)}
          onDoubleClick={() => editable && onStartRename(folder)}
        >
          {rootIcon ? (
            <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">{rootIcon}</span>
          ) : (
            <FolderSwatch color={folder.color} />
          )}
          {renamingId === folder.id ? (
            <input
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") onRenameCommit(folder);
                if (event.key === "Escape") onRenameCancel();
              }}
              onBlur={() => onRenameCommit(folder)}
              className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-sm outline-none"
              autoFocus
            />
          ) : (
            <span className="truncate">{label}</span>
          )}
        </button>
        <span className="text-xs text-muted-foreground">{folder.itemCount}</span>
        {editable || canNest ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Folder actions for ${label}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canNest ? (
                <DropdownMenuItem onSelect={() => onCreateFolder(folder.id)}>
                  <FolderPlus className="h-3.5 w-3.5" />
                  New subfolder
                </DropdownMenuItem>
              ) : null}
              {editable ? (
                <>
                  <DropdownMenuItem onSelect={() => onStartRename(folder)}>Rename</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEditFolder(folder)}>Edit color</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => onDeleteFolder(folder)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="h-6 w-6" />
        )}
      </div>
      {isOpen && children.length > 0 ? (
        <div>
          {children.map((child) => (
            <TreeBranch
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selection={selection}
              expanded={expanded}
              renamingId={renamingId}
              renameDraft={renameDraft}
              onToggle={onToggle}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
              onStartRename={onStartRename}
              onRenameDraftChange={onRenameDraftChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

export function FolderBreadcrumb({
  result,
  selection,
  onSelect,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const trail = selection === "all" || selection === "unfiled"
    ? []
    : folderBreadcrumbTrail(model, selection);

  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/40",
          selection === "all" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        <Home className="h-3.5 w-3.5" />
        All skills
      </button>
      {selection === "unfiled" ? (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="rounded px-1.5 py-0.5 font-medium text-foreground">Unfiled</span>
        </>
      ) : null}
      {trail.map((folder, index) => {
        const isLast = index === trail.length - 1;
        const label = index === 0 ? reservedRootLabel(folder) : folder.name;
        return (
          <span key={folder.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
            <button
              type="button"
              onClick={() => onSelect(folder.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/40",
                isLast ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {folder.color ? <FolderSwatch color={folder.color} /> : null}
              {label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Subfolder tiles (folder browser)
// ---------------------------------------------------------------------------

export function FolderTiles({
  result,
  selection,
  onOpen,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  onOpen: (folderId: string) => void;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const children = useMemo<FolderTreeNode[]>(() => {
    if (selection === "unfiled") return [];
    if (selection === "all") return model.roots;
    return model.childrenById.get(selection) ?? [];
  }, [model, selection]);

  if (children.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="mb-2 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        Folders
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]">
        {children.map((node) => (
          <button
            key={node.folder.id}
            type="button"
            onClick={() => onOpen(node.folder.id)}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/30"
          >
            {node.folder.systemKey && ["my", "projects", "bundled"].includes(node.folder.systemKey) ? (
              <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderSwatch color={node.folder.color} className="h-3.5 w-3.5" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {reservedRootLabel(node.folder)}
            </span>
            <span className="text-xs text-muted-foreground">{node.folder.itemCount}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move-to-folder dialog (tree picker + inline new folder + path preview)
// ---------------------------------------------------------------------------

export function MoveToFolderDialog({
  open,
  onOpenChange,
  result,
  title,
  subtitle,
  currentFolderId,
  pending = false,
  onMove,
  onCreateFolder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: FolderListResult | null | undefined;
  title: string;
  subtitle?: string | null;
  currentFolderId: string | null | undefined;
  pending?: boolean;
  onMove: (folderId: string | null) => void;
  /** Create a folder under `parentId` (null = top level); resolve to the new id. */
  onCreateFolder: (parentId: string | null, name: string) => Promise<string | null>;
}) {
  const model = useMemo(() => treeFromResult(result), [result]);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTarget(undefined);
      setCreatingParent(undefined);
      setNewName("");
    }
  }, [open]);

  const lowered = query.trim().toLowerCase();
  const matches = (folder: FolderListItem) =>
    !lowered || folder.name.toLowerCase().includes(lowered) || folder.path.toLowerCase().includes(lowered);

  // The selected destination (undefined = nothing picked yet).
  const chosen = target;
  const chosenFolder = typeof chosen === "string" ? model.byId.get(chosen) ?? null : null;
  const previewPath = chosen === undefined
    ? null
    : chosen === null
      ? "Unfiled"
      : chosenFolder?.path ?? null;

  async function submitNewFolder() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const id = await onCreateFolder(creatingParent ?? null, name);
      if (id) setTarget(id);
      setCreatingParent(undefined);
      setNewName("");
    } finally {
      setCreating(false);
    }
  }

  function renderNode(node: FolderTreeNode, depth: number): ReactNode {
    const { folder } = node;
    const bundled = isBundledFolder(folder);
    const selectable = !bundled;
    const isChosen = chosen === folder.id;
    const isCurrent = currentFolderId === folder.id;
    const nestable = selectable && !isProjectsFolder(folder) && folder.depth < 4;
    const visibleChildren = node.children;
    const selfMatches = matches(folder);
    // Keep a folder if it or any descendant matches the filter.
    const childMatches = subtreeMatches(node, matches);
    if (lowered && !selfMatches && !childMatches) return null;

    return (
      <div key={folder.id}>
        <div
          className={cn(
            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            selectable ? "cursor-pointer hover:bg-accent/40" : "cursor-not-allowed opacity-50",
            isChosen && "bg-accent/70",
          )}
          style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
          onClick={() => selectable && setTarget(folder.id)}
        >
          {folder.systemKey && ["my", "projects", "bundled"].includes(folder.systemKey) ? (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderSwatch color={folder.color} />
          )}
          <span className="min-w-0 flex-1 truncate">{reservedRootLabel(folder)}</span>
          {isCurrent ? <span className="text-xs text-muted-foreground">current</span> : null}
          {bundled ? <span className="text-xs text-muted-foreground">read-only</span> : null}
          {isChosen ? <Check className="h-3.5 w-3.5" /> : null}
          {nestable ? (
            <button
              type="button"
              title="New folder inside…"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                setCreatingParent(folder.id);
                setNewName("");
              }}
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ) : null}
        </div>
        {creatingParent === folder.id ? (
          <InlineNewFolder
            depth={depth + 1}
            value={newName}
            pending={creating}
            onChange={setNewName}
            onSubmit={submitNewFolder}
            onCancel={() => setCreatingParent(undefined)}
          />
        ) : null}
        {visibleChildren.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border border-border px-2.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search folders"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border border-border p-1">
          <div
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40",
              chosen === null && "bg-accent/70",
            )}
            onClick={() => setTarget(null)}
          >
            <FolderSwatch color={null} />
            <span className="min-w-0 flex-1 truncate">Unfiled</span>
            {currentFolderId == null ? <span className="text-xs text-muted-foreground">current</span> : null}
            {chosen === null ? <Check className="h-3.5 w-3.5" /> : null}
          </div>
          {model.roots.map((node) => renderNode(node, 0))}
          <div className="mt-1 border-t border-border pt-1">
            {creatingParent === null ? (
              <InlineNewFolder
                depth={0}
                value={newName}
                pending={creating}
                onChange={setNewName}
                onSubmit={submitNewFolder}
                onCancel={() => setCreatingParent(undefined)}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCreatingParent(null);
                  setNewName("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New top-level folder…
              </button>
            )}
          </div>
        </div>

        <div className="min-h-5 text-xs text-muted-foreground">
          {previewPath ? (
            <span>
              Moving to <span className="font-mono text-foreground">{previewPath}</span>
            </span>
          ) : (
            <span>Pick a destination folder.</span>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || chosen === undefined || chosen === currentFolderId}
            onClick={() => chosen !== undefined && onMove(chosen)}
          >
            {pending ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function subtreeMatches(node: FolderTreeNode, matches: (folder: FolderListItem) => boolean): boolean {
  if (matches(node.folder)) return true;
  return node.children.some((child) => subtreeMatches(child, matches));
}

function InlineNewFolder({
  depth,
  value,
  pending,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>
      <FolderPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Folder name"
        autoFocus
        className="h-7 flex-1 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSubmit} disabled={pending || !value.trim()}>
        Add
      </Button>
    </div>
  );
}
