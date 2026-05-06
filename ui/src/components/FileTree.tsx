import type { KeyboardEvent, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

// -- Tree types --------------------------------------------------------------

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
  /** Optional per-node metadata (e.g. import action) */
  action?: string | null;
};

export type FileTreeBadgeVariant = "ok" | "warning" | "error" | "info" | "pending";

export type FileTreeBadge = {
  label: string;
  status: FileTreeBadgeVariant;
  tooltip?: string;
};

export type FileTreeTone = "default" | "warning" | "error" | "muted";

export type FileTreeEmptyState = {
  title?: string;
  description?: string;
};

export type FileTreeErrorState = {
  message: string;
  retry?: () => void;
};

type VisibleFileTreeNode = {
  node: FileTreeNode;
  depth: number;
};

const TREE_BASE_INDENT = 16;
const TREE_STEP_INDENT = 24;
const TREE_ROW_HEIGHT_CLASS = "min-h-9";

const fileTreeToneClass: Record<FileTreeTone, string | undefined> = {
  default: undefined,
  warning: "bg-amber-500/5 text-amber-700 dark:text-amber-300",
  error: "bg-destructive/5 text-destructive",
  muted: "opacity-50",
};

// -- Helpers -----------------------------------------------------------------

export function buildFileTree(
  files: Record<string, unknown>,
  actionMap?: Map<string, string>,
): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };

  for (const filePath of Object.keys(files)) {
    const segments = filePath.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = i === segments.length - 1;
      let next = current.children.find((c) => c.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: [],
          action: isLeaf ? (actionMap?.get(filePath) ?? null) : null,
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  function sortNode(node: FileTreeNode) {
    node.children.sort((a, b) => {
      // Files before directories so PROJECT.md appears above tasks/
      if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

export function countFiles(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "file") count++;
    else count += countFiles(node.children);
  }
  return count;
}

export function collectAllPaths(
  nodes: FileTreeNode[],
  type: "file" | "dir" | "all" = "all",
): Set<string> {
  const paths = new Set<string>();
  for (const node of nodes) {
    if (type === "all" || node.kind === type) paths.add(node.path);
    for (const p of collectAllPaths(node.children, type)) paths.add(p);
  }
  return paths;
}

function fileIcon(name: string) {
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return FileCode2;
  return FileText;
}

function flattenVisibleNodes(
  nodes: FileTreeNode[],
  expandedDirs: Set<string>,
  depth = 0,
): VisibleFileTreeNode[] {
  const flattened: VisibleFileTreeNode[] = [];
  for (const node of nodes) {
    flattened.push({ node, depth });
    if (node.kind === "dir" && expandedDirs.has(node.path)) {
      flattened.push(...flattenVisibleNodes(node.children, expandedDirs, depth + 1));
    }
  }
  return flattened;
}

function checkboxState(node: FileTreeNode, checkedFiles: Set<string>) {
  if (node.kind === "file") {
    return {
      allChecked: checkedFiles.has(node.path),
      someChecked: false,
    };
  }

  const childFiles = collectAllPaths(node.children, "file");
  const childFilePaths = [...childFiles];
  const allChecked = childFilePaths.length > 0 && childFilePaths.every((p) => checkedFiles.has(p));
  const someChecked = childFilePaths.some((p) => checkedFiles.has(p));
  return { allChecked, someChecked: someChecked && !allChecked };
}

// -- Frontmatter helpers -----------------------------------------------------

export type FrontmatterData = Record<string, string | string[]>;

export function parseFrontmatter(content: string): { data: FrontmatterData; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const data: FrontmatterData = {};
  const rawYaml = match[1];
  const body = match[2];

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    if (currentKey && currentList) {
      data[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].trim().replace(/^["']|["']$/g, "");
      if (val === "null") {
        currentKey = null;
        continue;
      }
      if (val) {
        data[key] = val;
        currentKey = null;
      } else {
        currentKey = key;
      }
    }
  }

  if (currentKey && currentList) {
    data[currentKey] = currentList;
  }

  return Object.keys(data).length > 0 ? { data, body } : null;
}

export const FRONTMATTER_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  kind: "Kind",
  reportsTo: "Reports to",
  skills: "Skills",
  status: "Status",
  description: "Description",
  priority: "Priority",
  assignee: "Assignee",
  project: "Project",
  recurring: "Recurring",
  targetDate: "Target date",
};

// -- File tree component -----------------------------------------------------

export type FileTreeProps = {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  expandedDirs: Set<string>;
  checkedFiles?: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleCheck?: (path: string, kind: "file" | "dir") => void;
  /** Serializable badge metadata keyed by path. This is safe to expose through plugin UI contracts. */
  fileBadges?: Record<string, FileTreeBadge | undefined>;
  /** Closed row tone metadata keyed by path. This avoids raw host class names in public contracts. */
  fileTones?: Record<string, FileTreeTone | undefined>;
  /** Internal-only escape hatch for current host call sites that need richer row content. */
  renderFileExtra?: (node: FileTreeNode, checked: boolean) => ReactNode;
  /** @deprecated Use fileTones for public surfaces. Kept for compatibility with host-only callers. */
  fileRowClassName?: (node: FileTreeNode, checked: boolean) => string | undefined;
  showCheckboxes?: boolean;
  /** Allow long file and directory names to wrap instead of forcing horizontal overflow. */
  wrapLabels?: boolean;
  loading?: boolean;
  error?: FileTreeErrorState | null;
  empty?: FileTreeEmptyState;
  ariaLabel?: string;
};

export function FileTree({
  nodes,
  selectedFile,
  expandedDirs,
  checkedFiles,
  onToggleDir,
  onSelectFile,
  onToggleCheck,
  fileBadges,
  fileTones,
  renderFileExtra,
  fileRowClassName,
  showCheckboxes = true,
  wrapLabels = true,
  loading = false,
  error,
  empty,
  ariaLabel = "Files",
}: FileTreeProps) {
  const effectiveCheckedFiles = checkedFiles ?? new Set<string>();
  const visibleNodes = useMemo(
    () => flattenVisibleNodes(nodes, expandedDirs),
    [expandedDirs, nodes],
  );
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  function focusPath(path: string) {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(path)?.focus();
    });
  }

  function toggleNode(node: FileTreeNode) {
    if (node.kind === "dir") onToggleDir(node.path);
    else onSelectFile(node.path);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number, node: FileTreeNode) {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = visibleNodes[Math.min(index + 1, visibleNodes.length - 1)];
        if (next) focusPath(next.node.path);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = visibleNodes[Math.max(index - 1, 0)];
        if (previous) focusPath(previous.node.path);
        break;
      }
      case "ArrowRight":
        if (node.kind === "dir" && !expandedDirs.has(node.path)) {
          event.preventDefault();
          onToggleDir(node.path);
        }
        break;
      case "ArrowLeft":
        if (node.kind === "dir" && expandedDirs.has(node.path)) {
          event.preventDefault();
          onToggleDir(node.path);
        }
        break;
      case "Enter":
        event.preventDefault();
        toggleNode(node);
        break;
      case " ":
        if (showCheckboxes && onToggleCheck) {
          event.preventDefault();
          onToggleCheck(node.path, node.kind);
        }
        break;
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" aria-label={ariaLabel} role="tree" className="py-1">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className={cn("flex items-center gap-2 px-4", TREE_ROW_HEIGHT_CLASS)}>
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
            <Skeleton className={cn("h-3.5", row === 1 ? "w-3/5" : "w-4/5")} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div aria-label={ariaLabel} role="tree" className="p-3">
        <div
          role="treeitem"
          aria-level={1}
          className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
                statusBadge.error ?? statusBadgeDefault,
              )}
            >
              error
            </span>
            <span className="min-w-0 text-destructive">{error.message}</span>
          </div>
          {error.retry && (
            <Button type="button" size="xs" variant="outline" onClick={error.retry}>
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div aria-label={ariaLabel} role="tree" className="p-3">
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
          <div className="text-sm font-medium">{empty?.title ?? "No files"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {empty?.description ?? "Files will appear here when they are available."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div aria-label={ariaLabel} role="tree">
      {visibleNodes.map(({ node, depth }, index) => {
        const expanded = node.kind === "dir" && expandedDirs.has(node.path);
        const { allChecked, someChecked } = checkboxState(node, effectiveCheckedFiles);
        const badge = fileBadges?.[node.path];
        const tone = fileTones?.[node.path] ?? "default";
        const extraClassName = node.kind === "file" ? fileRowClassName?.(node, allChecked) : undefined;
        const FileIcon = node.kind === "file" ? fileIcon(node.name) : null;
        const isSelected = node.kind === "file" && node.path === selectedFile;

        return (
          <div
            key={node.path}
            ref={(element) => {
              if (element) rowRefs.current.set(node.path, element);
              else rowRefs.current.delete(node.path);
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={node.kind === "dir" ? expanded : undefined}
            aria-selected={node.kind === "file" ? isSelected : undefined}
            aria-checked={showCheckboxes ? (someChecked ? "mixed" : allChecked) : undefined}
            tabIndex={(focusedPath ?? visibleNodes[0]?.node.path) === node.path ? 0 : -1}
            className={cn(
              node.kind === "dir"
                ? showCheckboxes
                  ? "group grid w-full grid-cols-[auto_minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                  : "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground max-[480px]:grid-cols-[minmax(0,1fr)]"
                : "group flex w-full items-center gap-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground cursor-pointer",
              TREE_ROW_HEIGHT_CLASS,
              isSelected && "text-foreground bg-accent/20",
              fileTreeToneClass[tone],
              extraClassName,
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
            )}
            style={{
              paddingInlineStart: `${TREE_BASE_INDENT + depth * TREE_STEP_INDENT - 8}px`,
            }}
            onFocus={() => setFocusedPath(node.path)}
            onClick={() => toggleNode(node)}
            onKeyDown={(event) => handleRowKeyDown(event, index, node)}
            data-file-tree-path={node.path}
          >
            {showCheckboxes && (
              <label className="flex items-center pl-2" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(element) => {
                    if (element) element.indeterminate = someChecked;
                  }}
                  onChange={() => onToggleCheck?.(node.path, node.kind)}
                  className="mr-2 accent-foreground"
                />
              </label>
            )}
            <span className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {node.kind === "dir" ? (
                  expanded ? (
                    <FolderOpen className="h-3.5 w-3.5" />
                  ) : (
                    <Folder className="h-3.5 w-3.5" />
                  )
                ) : FileIcon ? (
                  <FileIcon className="h-3.5 w-3.5" />
                ) : null}
              </span>
              <span className={cn("min-w-0", wrapLabels ? "break-all leading-4" : "truncate")}>
                {node.name}
              </span>
            </span>
            {badge && (
              <span
                className={cn(
                  "ml-3 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  statusBadge[badge.status] ?? statusBadgeDefault,
                )}
                title={badge.tooltip}
              >
                {badge.label}
              </span>
            )}
            {node.kind === "file" && renderFileExtra?.(node, allChecked)}
            {node.kind === "dir" && (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 max-[480px]:hidden"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleDir(node.path);
                }}
                aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
