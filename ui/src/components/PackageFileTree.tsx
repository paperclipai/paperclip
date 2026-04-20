import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";

// ── Tree types ────────────────────────────────────────────────────────

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
  /** Optional per-node metadata (e.g. import action) */
  action?: string | null;
};

const TREE_BASE_INDENT = 16;
const TREE_STEP_INDENT = 24;
const TREE_ROW_HEIGHT_CLASS = "min-h-9";

// ── Helpers ───────────────────────────────────────────────────────────

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

// ── Frontmatter helpers ───────────────────────────────────────────────

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

// ── File tree component ───────────────────────────────────────────────

export function PackageFileTree({
  nodes,
  selectedFile,
  expandedDirs,
  checkedFiles,
  onToggleDir,
  onSelectFile,
  onToggleCheck,
  renderFileExtra,
  fileRowClassName,
  showCheckboxes = true,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  expandedDirs: Set<string>;
  checkedFiles?: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleCheck?: (path: string, kind: "file" | "dir") => void;
  /** Optional extra content rendered at the end of each file row (e.g. action badge) */
  renderFileExtra?: (node: FileTreeNode, checked: boolean) => ReactNode;
  /** Optional additional className for file rows */
  fileRowClassName?: (node: FileTreeNode, checked: boolean) => string | undefined;
  showCheckboxes?: boolean;
  depth?: number;
}) {
  const effectiveCheckedFiles = checkedFiles ?? new Set<string>();

  return (
    <div>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && expandedDirs.has(node.path);
        if (node.kind === "dir") {
          const childFiles = collectAllPaths(node.children, "file");
          const allChecked = [...childFiles].every((p) => effectiveCheckedFiles.has(p));
          const someChecked = [...childFiles].some((p) => effectiveCheckedFiles.has(p));
          return (
            <div key={node.path}>
              <div
                className={cn(
                  showCheckboxes
                    ? "group grid w-full grid-cols-[auto_minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                    : "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  TREE_ROW_HEIGHT_CLASS,
                )}
                style={{
                  paddingInlineStart: `${TREE_BASE_INDENT + depth * TREE_STEP_INDENT - 8}px`,
                }}
              >
                {showCheckboxes && (
                  <label className="flex items-center pl-2">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                      onChange={() => onToggleCheck?.(node.path, "dir")}
                      className="mr-2 accent-foreground"
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 py-1 text-left"
                  onClick={() => onToggleDir(node.path)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {expanded ? (
                      <FolderOpen className="h-3.5 w-3.5" />
                    ) : (
                      <Folder className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="truncate">{node.name}</span>
                </button>
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={() => onToggleDir(node.path)}
                >
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              {expanded && (
                <PackageFileTree
                  nodes={node.children}
                  selectedFile={selectedFile}
                  expandedDirs={expandedDirs}
                  checkedFiles={effectiveCheckedFiles}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                  onToggleCheck={onToggleCheck}
                  renderFileExtra={renderFileExtra}
                  fileRowClassName={fileRowClassName}
                  showCheckboxes={showCheckboxes}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const FileIcon = fileIcon(node.name);
        const checked = effectiveCheckedFiles.has(node.path);
        const extraClassName = fileRowClassName?.(node, checked);
        return (
          <div
            key={node.path}
            className={cn(
              "flex w-full items-center gap-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground cursor-pointer",
              TREE_ROW_HEIGHT_CLASS,
              node.path === selectedFile && "text-foreground bg-accent/20",
              extraClassName,
            )}
            style={{
              paddingInlineStart: `${TREE_BASE_INDENT + depth * TREE_STEP_INDENT - 8}px`,
            }}
            onClick={() => onSelectFile(node.path)}
          >
            {showCheckboxes && (
              <label className="flex items-center pl-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleCheck?.(node.path, "file")}
                  className="mr-2 accent-foreground"
                />
              </label>
            )}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
              onClick={() => onSelectFile(node.path)}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                <FileIcon className="h-3.5 w-3.5" />
              </span>
              <span className="truncate">{node.name}</span>
            </button>
            {renderFileExtra?.(node, checked)}
          </div>
        );
      })}
    </div>
  );
}
