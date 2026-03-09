import { useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  MoreVertical,
  Loader2,
  Download,
  FolderArchive,
  Move,
} from "lucide-react";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { workspaceFilesApi, type FileEntry } from "../api/workspace-files";
import { useToast } from "../context/ToastContext";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";

interface FileTreeNodeProps {
  entry: FileEntry;
  workspaceId: string;
  parentPath: string;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedPath: string | null;
}

function getFilePath(parentPath: string, name: string): string {
  if (parentPath === ".") return name;
  return `${parentPath}/${name}`;
}

function FileTreeNode({
  entry,
  workspaceId,
  parentPath,
  depth,
  onFileSelect,
  selectedPath,
}: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [dropHighlight, setDropHighlight] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const filePath = getFilePath(parentPath, entry.name);
  const isDirectory = entry.type === "directory";
  const isSelected = selectedPath === filePath;

  const { data: dirData, isLoading: isDirLoading } = useQuery({
    queryKey: queryKeys.workspaceFiles.list(workspaceId, filePath),
    queryFn: () => workspaceFilesApi.list(workspaceId, filePath),
    enabled: isDirectory && expanded,
  });

  const deleteEntry = useMutation({
    mutationFn: () => workspaceFilesApi.delete(workspaceId, filePath),
    onSuccess: () => {
      setDeleteOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.list(workspaceId, parentPath),
      });
      pushToast({
        title: `${isDirectory ? "Folder" : "File"} deleted`,
        body: entry.name,
        tone: "success",
      });
    },
    onError: () => {
      pushToast({
        title: `Failed to delete ${isDirectory ? "folder" : "file"}`,
        body: entry.name,
        tone: "error",
      });
    },
  });

  const renameEntry = useMutation({
    mutationFn: (newName: string) =>
      workspaceFilesApi.rename(
        workspaceId,
        filePath,
        getFilePath(parentPath, newName),
      ),
    onSuccess: () => {
      setRenaming(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.list(workspaceId, parentPath),
      });
      pushToast({
        title: `${isDirectory ? "Folder" : "File"} renamed`,
        tone: "success",
      });
    },
    onError: () => {
      pushToast({
        title: `Failed to rename ${isDirectory ? "folder" : "file"}`,
        tone: "error",
      });
    },
  });

  const moveEntry = useMutation({
    mutationFn: (newPath: string) =>
      workspaceFilesApi.rename(workspaceId, filePath, newPath),
    onSuccess: (_, newPath) => {
      setMoveOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.list(workspaceId, parentPath),
      });
      // Invalidate the target parent directory too
      const newParent = newPath.includes("/") ? newPath.substring(0, newPath.lastIndexOf("/")) : ".";
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.list(workspaceId, newParent),
      });
      pushToast({
        title: `${isDirectory ? "Folder" : "File"} moved`,
        tone: "success",
      });
    },
    onError: () => {
      pushToast({
        title: `Failed to move ${isDirectory ? "folder" : "file"}`,
        tone: "error",
      });
    },
  });

  const handleClick = () => {
    if (isDirectory) {
      setExpanded((prev) => !prev);
    } else {
      onFileSelect(filePath);
    }
  };

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newName = renameValue.trim();
    if (!newName || newName === entry.name) {
      setRenaming(false);
      return;
    }
    renameEntry.mutate(newName);
  };

  const handleMoveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = moveTarget.trim();
    if (!target) return;
    moveEntry.mutate(target);
  };

  const handleDownload = () => {
    if (isDirectory) {
      window.open(workspaceFilesApi.downloadZipUrl(workspaceId, filePath), "_blank");
    } else {
      window.open(workspaceFilesApi.downloadUrl(workspaceId, filePath), "_blank");
    }
  };

  // Drag-and-drop: drag a file/folder
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/x-filetree-path", filePath);
    e.dataTransfer.setData("text/x-filetree-parent", parentPath);
    e.dataTransfer.setData("text/x-filetree-name", entry.name);
    e.dataTransfer.effectAllowed = "move";
  };

  // Drag-and-drop: drop onto a directory
  const handleDragOver = (e: React.DragEvent) => {
    if (!isDirectory) return;
    const draggedPath = e.dataTransfer.types.includes("text/x-filetree-path");
    if (!draggedPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHighlight(true);
  };

  const handleDragLeave = () => {
    setDropHighlight(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setDropHighlight(false);
    if (!isDirectory) return;
    e.preventDefault();
    const draggedPath = e.dataTransfer.getData("text/x-filetree-path");
    const draggedName = e.dataTransfer.getData("text/x-filetree-name");
    const draggedParent = e.dataTransfer.getData("text/x-filetree-parent");
    if (!draggedPath || !draggedName) return;
    // Don't drop onto same parent
    if (filePath === draggedParent) return;
    // Don't drop onto itself or a child
    if (draggedPath === filePath || filePath.startsWith(draggedPath + "/")) return;

    const newPath = getFilePath(filePath, draggedName);
    workspaceFilesApi
      .rename(workspaceId, draggedPath, newPath)
      .then(() => {
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaceFiles.list(workspaceId, draggedParent),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaceFiles.list(workspaceId, filePath),
        });
        pushToast({ title: "Moved", body: `${draggedName} → ${filePath}/`, tone: "success" });
        // Expand the target directory to show the moved item
        setExpanded(true);
      })
      .catch(() => {
        pushToast({ title: "Failed to move", tone: "error" });
      });
  };

  const sortedItems = useMemo(
    () =>
      dirData?.items
        ? [...dirData.items].sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
        : [],
    [dirData?.items],
  );

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 py-0.5 pr-1 text-sm cursor-pointer rounded-sm transition-colors overflow-hidden",
          isSelected && !isDirectory
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/50",
          deleteEntry.isPending && "opacity-50 pointer-events-none",
          dropHighlight && "bg-accent/70 ring-1 ring-ring",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        role={isDirectory ? "button" : undefined}
        aria-expanded={isDirectory ? expanded : undefined}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDirectory ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {isDirectory ? (
          expanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {renaming ? (
          <form
            onSubmit={handleRenameSubmit}
            className="flex-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              className="w-full rounded border border-border bg-background px-1 py-0 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => {
                if (!renameEntry.isPending) setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameValue(entry.name);
                }
              }}
              autoFocus
            />
          </form>
        ) : (
          <span className="flex-1 min-w-0 truncate">{entry.name}</span>
        )}

        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="File actions"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(entry.name);
                  setRenaming(true);
                }}
              >
                <Pencil className="h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setMoveTarget(filePath);
                  setMoveOpen(true);
                }}
              >
                <Move className="h-4 w-4" />
                Move to…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
              >
                {isDirectory ? (
                  <FolderArchive className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {isDirectory ? "Download ZIP" : "Download"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {isDirectory && expanded && (
        <div>
          {isDirLoading ? (
            <div
              className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          ) : sortedItems.length === 0 ? (
            <div
              className="py-1 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              Empty folder
            </div>
          ) : (
            sortedItems.map((child) => (
              <FileTreeNode
                key={child.name}
                entry={child}
                workspaceId={workspaceId}
                parentPath={filePath}
                depth={depth + 1}
                onFileSelect={onFileSelect}
                selectedPath={selectedPath}
              />
            ))
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {isDirectory ? "folder" : "file"}</DialogTitle>
            <DialogDescription>
              This action cannot be undone.
              {isDirectory && " All contents of the folder will be removed."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete{" "}
            <span className="font-medium text-foreground font-mono">
              {entry.name}
            </span>
            ?
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteEntry.mutate()}
              disabled={deleteEntry.isPending}
            >
              {deleteEntry.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move dialog */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Move {isDirectory ? "folder" : "file"}</DialogTitle>
            <DialogDescription>
              Enter the new path for{" "}
              <span className="font-mono font-medium">{entry.name}</span>.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleMoveSubmit} className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-sm font-medium">New path</label>
              <input
                className="w-full rounded border border-border bg-transparent px-3 py-1.5 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
                placeholder="e.g. src/components/Button.tsx"
                autoFocus
              />
            </div>
          </form>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMoveOpen(false)}
              disabled={moveEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const target = moveTarget.trim();
                if (target) moveEntry.mutate(target);
              }}
              disabled={moveEntry.isPending || !moveTarget.trim()}
            >
              {moveEntry.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Moving…
                </>
              ) : (
                "Move"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface CreateItemDialogProps {
  open: boolean;
  type: "file" | "directory";
  workspaceId: string;
  currentPath: string;
  onOpenChange: (open: boolean) => void;
  onFileCreated?: (path: string) => void;
}

function CreateItemDialog({
  open,
  type,
  workspaceId,
  currentPath,
  onOpenChange,
  onFileCreated,
}: CreateItemDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const isFile = type === "file";
  const label = isFile ? "File" : "Folder";

  const handleClose = () => {
    setName("");
    setError(null);
    onOpenChange(false);
  };

  const createItem = useMutation({
    mutationFn: (itemName: string) => {
      const newPath = getFilePath(currentPath, itemName);
      return isFile
        ? workspaceFilesApi.write(workspaceId, newPath, "")
        : workspaceFilesApi.mkdir(workspaceId, newPath);
    },
    onSuccess: (_, itemName) => {
      const newPath = getFilePath(currentPath, itemName);
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.list(workspaceId, currentPath),
      });
      pushToast({
        title: `${label} created`,
        body: itemName,
        tone: "success",
      });
      if (isFile) onFileCreated?.(newPath);
      handleClose();
    },
    onError: () => {
      setError(`Failed to create ${label.toLowerCase()}. Please try again.`);
      pushToast({ title: `Failed to create ${label.toLowerCase()}`, tone: "error" });
    },
  });

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(`${label} name is required.`);
      return;
    }
    setError(null);
    createItem.mutate(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {label}</DialogTitle>
          <DialogDescription>
            Enter a name for the new {label.toLowerCase()} in this workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label className="text-sm font-medium">{label} name</label>
            <input
              className="w-full rounded border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder={isFile ? "index.ts" : "my-folder"}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") handleClose();
              }}
              disabled={createItem.isPending}
              autoFocus
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={createItem.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createItem.isPending}>
            {createItem.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface FileTreeProps {
  workspaceId: string;
  onFileSelect: (path: string) => void;
  selectedPath: string | null;
}

export function FileTree({
  workspaceId,
  onFileSelect,
  selectedPath,
}: FileTreeProps) {
  const [createDialogType, setCreateDialogType] = useState<
    "file" | "directory" | null
  >(null);

  const {
    data: rootData,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.workspaceFiles.list(workspaceId, "."),
    queryFn: () => workspaceFilesApi.list(workspaceId, "."),
    enabled: !!workspaceId,
  });

  const sortedItems = useMemo(
    () =>
      rootData?.items
        ? [...rootData.items].sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
        : [],
    [rootData?.items],
  );

  // Root-level drop handler for moving items to workspace root
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [rootDropHighlight, setRootDropHighlight] = useState(false);

  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/x-filetree-path")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setRootDropHighlight(true);
  }, []);

  const handleRootDragLeave = useCallback(() => {
    setRootDropHighlight(false);
  }, []);

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      setRootDropHighlight(false);
      e.preventDefault();
      const draggedPath = e.dataTransfer.getData("text/x-filetree-path");
      const draggedName = e.dataTransfer.getData("text/x-filetree-name");
      const draggedParent = e.dataTransfer.getData("text/x-filetree-parent");
      if (!draggedPath || !draggedName) return;
      // Already in root
      if (draggedParent === ".") return;

      workspaceFilesApi
        .rename(workspaceId, draggedPath, draggedName)
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspaceFiles.list(workspaceId, draggedParent),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspaceFiles.list(workspaceId, "."),
          });
          pushToast({ title: "Moved to root", body: draggedName, tone: "success" });
        })
        .catch(() => {
          pushToast({ title: "Failed to move", tone: "error" });
        });
    },
    [workspaceId, queryClient, pushToast],
  );

  return (
    <div className="flex flex-col h-full border-r border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Files
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setCreateDialogType("file")}
            aria-label="New file"
            title="New file"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setCreateDialogType("directory")}
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div
          className={cn("py-1 min-h-full w-0 min-w-full", rootDropHighlight && "bg-accent/30")}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <p className="px-3 py-2 text-xs text-destructive">
              Failed to load files.
            </p>
          ) : sortedItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground italic">
              No files yet.
            </p>
          ) : (
            sortedItems.map((entry) => (
              <FileTreeNode
                key={entry.name}
                entry={entry}
                workspaceId={workspaceId}
                parentPath="."
                depth={0}
                onFileSelect={onFileSelect}
                selectedPath={selectedPath}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <CreateItemDialog
        open={createDialogType !== null}
        type={createDialogType ?? "file"}
        workspaceId={workspaceId}
        currentPath="."
        onOpenChange={(isOpen) => {
          if (!isOpen) setCreateDialogType(null);
        }}
        onFileCreated={onFileSelect}
      />
    </div>
  );
}
