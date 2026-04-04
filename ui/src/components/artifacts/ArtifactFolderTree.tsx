import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, Plus, MoreHorizontal } from "lucide-react";
import type { ArtifactFolderTreeNode } from "@paperclipai/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ArtifactFolderTreeProps {
  tree: ArtifactFolderTreeNode[];
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: ArtifactFolderTreeNode) => void;
  onDeleteFolder: (folder: ArtifactFolderTreeNode) => void;
}

function FolderNode({
  node,
  depth,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  node: ArtifactFolderTreeNode;
  depth: number;
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (folder: ArtifactFolderTreeNode) => void;
  onDeleteFolder: (folder: ArtifactFolderTreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isSelected = selectedFolderId === node.id;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1 text-sm cursor-pointer rounded-md hover:bg-muted/50",
          isSelected && "bg-muted font-medium",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelectFolder(node.id)}
      >
        <button
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5" />
          )}
        </button>
        {expanded ? (
          <FolderOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}
        <span className="truncate flex-1">{node.name}</span>
        {node.fileCount > 0 && (
          <span className="text-xs text-muted-foreground">{node.fileCount}</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded hover:bg-muted"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onCreateFolder(node.id)}>New subfolder</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRenameFolder(node)}>Rename</DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => onDeleteFolder(node)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded &&
        node.children.map((child: ArtifactFolderTreeNode) => (
          <FolderNode
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ))}
    </div>
  );
}

export function ArtifactFolderTree({
  tree,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: ArtifactFolderTreeProps) {
  return (
    <div className="flex flex-col h-full border-r">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Folders</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onCreateFolder(null)}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 text-sm cursor-pointer rounded-md hover:bg-muted/50 mx-1",
            selectedFolderId === null && "bg-muted font-medium",
          )}
          onClick={() => onSelectFolder(null)}
        >
          <Folder className="w-4 h-4 text-muted-foreground ml-5" />
          <span>All Files</span>
        </div>
        {tree.map((node) => (
          <FolderNode
            key={node.id}
            node={node}
            depth={0}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ))}
      </div>
    </div>
  );
}
