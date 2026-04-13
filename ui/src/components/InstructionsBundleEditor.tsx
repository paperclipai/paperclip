import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

type InstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
};

type InstructionsFileDetail = InstructionsFileSummary & {
  content: string;
};

type FileTreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
};

function buildTree(files: InstructionsFileSummary[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = i === segments.length - 1;
      let next = current.children.find((c) => c.name === segment);
      if (!next) {
        next = { name: segment, path: currentPath, kind: isLeaf ? "file" : "dir", children: [] };
        current.children.push(next);
      }
      current = next;
    }
  }
  function sortNode(node: FileTreeNode) {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  }
  sortNode(root);
  return root.children;
}

type InstructionsBundleEditorProps = {
  title?: string;
  description?: string;
  files: InstructionsFileSummary[];
  entryFile: string;
  fileDetail?: InstructionsFileDetail;
  loading?: boolean;
  fileLoading?: boolean;
  savePending?: boolean;
  deletePending?: boolean;
  selectedFile?: string;
  onSelectedFileChange?: (path: string) => void;
  initialSelectedFile?: string;
  emptyMessage: string;
  emptyAction: string;
  emptyFilePath: string;
  emptyFileContent: string;
  editorHeight?: string;
  onSaveFile: (
    data: { path: string; content: string },
    opts?: { onSuccess?: () => void },
  ) => void;
  onDeleteFile: (relativePath: string) => void;
};

export function InstructionsBundleEditor({
  title,
  description,
  files,
  entryFile,
  fileDetail,
  loading = false,
  fileLoading = false,
  savePending = false,
  deletePending = false,
  selectedFile: controlledSelectedFile,
  onSelectedFileChange,
  initialSelectedFile,
  emptyMessage,
  emptyAction,
  emptyFilePath,
  emptyFileContent,
  editorHeight = "calc(100vh - 220px)",
  onSaveFile,
  onDeleteFile,
}: InstructionsBundleEditorProps) {
  const [uncontrolledSelectedFile, setUncontrolledSelectedFile] = useState(initialSelectedFile ?? entryFile);
  const [draft, setDraft] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const selectedFile = controlledSelectedFile ?? uncontrolledSelectedFile;
  const fileTree = useMemo(() => buildTree(files), [files]);
  const selectedOrEntry = selectedFile || entryFile;
  const selectedExists = files.some((f) => f.path === selectedOrEntry);
  const currentContent = selectedExists ? (fileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const isDirty = draft !== null && draft !== currentContent;

  useEffect(() => {
    if (files.length === 0) return;
    const paths = files.map((file) => file.path);
    if (!paths.includes(selectedFile)) {
      const nextPath = paths.includes(entryFile) ? entryFile : paths[0]!;
      if (onSelectedFileChange) onSelectedFileChange(nextPath);
      else setUncontrolledSelectedFile(nextPath);
    }
  }, [entryFile, files, onSelectedFileChange, selectedFile]);

  useEffect(() => {
    const next = new Set<string>();
    for (const file of files) {
      const parts = file.path.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i]!;
        next.add(cur);
      }
    }
    setExpandedDirs(next);
  }, [files]);

  useEffect(() => {
    setDraft(null);
  }, [selectedOrEntry]);

  const setSelectedFile = useCallback((path: string) => {
    if (onSelectedFileChange) onSelectedFileChange(path);
    else setUncontrolledSelectedFile(path);
  }, [onSelectedFileChange]);

  const handleSave = useCallback(() => {
    if (!isDirty) return;
    onSaveFile({ path: selectedOrEntry, content: displayValue });
  }, [displayValue, isDirty, onSaveFile, selectedOrEntry]);

  const handleCreateFile = useCallback(() => {
    const trimmed = newFilePath.trim();
    if (!trimmed) return;
    const normalized = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    onSaveFile(
      { path: normalized, content: "" },
      {
        onSuccess: () => {
          setSelectedFile(normalized);
          setNewFilePath("");
          setShowNewFileInput(false);
        },
      },
    );
  }, [newFilePath, onSaveFile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleSave]);

  function renderTreeNode(node: FileTreeNode, depth: number) {
    if (node.kind === "dir") {
      const isExpanded = expandedDirs.has(node.path);
      return (
        <div key={node.path}>
          <button
            className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 rounded transition-colors"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={() => {
              setExpandedDirs((prev) => {
                const next = new Set(prev);
                if (isExpanded) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            }}
          >
            {isExpanded ? (
              <>
                <ChevronDown className="h-3 w-3 shrink-0" />
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3 shrink-0" />
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded && node.children.map((child) => renderTreeNode(child, depth + 1))}
        </div>
      );
    }

    const isSelected = selectedOrEntry === node.path;
    const isEntry = node.path === entryFile;
    return (
      <button
        key={node.path}
        className={`flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded transition-colors ${
          isSelected
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground hover:bg-accent/50"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => setSelectedFile(node.path)}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
        {isEntry ? (
          <span className="ml-auto text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
            entry
          </span>
        ) : null}
      </button>
    );
  }

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {title ? (
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          ) : null}
        </div>
      ) : null}

      {files.length === 0 && !showNewFileInput ? (
        <EmptyState
          icon={FileText}
          message={emptyMessage}
          action={emptyAction}
          onAction={() => {
            onSaveFile(
              { path: emptyFilePath, content: emptyFileContent },
              { onSuccess: () => setSelectedFile(emptyFilePath) },
            );
          }}
        />
      ) : (
        <div className="flex border border-border rounded-lg overflow-hidden" style={{ height: editorHeight, minHeight: 400 }}>
          <div className="w-52 shrink-0 border-r border-border bg-card flex flex-col">
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Files
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => setShowNewFileInput(true)}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {fileTree.map((node) => renderTreeNode(node, 0))}
              {showNewFileInput ? (
                <div className="px-2 py-1">
                  <input
                    autoFocus
                    className="w-full rounded border border-border bg-transparent px-1.5 py-0.5 text-xs outline-none"
                    placeholder="path/file.md"
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateFile();
                      if (e.key === "Escape") {
                        setShowNewFileInput(false);
                        setNewFilePath("");
                      }
                    }}
                    onBlur={() => {
                      if (!newFilePath.trim()) {
                        setShowNewFileInput(false);
                        setNewFilePath("");
                      }
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-medium">{selectedOrEntry}</span>
                {isDirty ? <span className="text-amber-500">modified</span> : null}
              </div>
              <div className="flex items-center gap-1">
                {selectedExists ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onDeleteFile(selectedOrEntry)}
                    disabled={deletePending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-xs px-2"
                  disabled={!isDirty || savePending}
                  onClick={handleSave}
                >
                  <Save className="h-3 w-3 mr-1" />
                  {savePending ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              {fileLoading && selectedExists ? (
                <div className="p-4 text-sm text-muted-foreground">Loading...</div>
              ) : !selectedExists && files.length > 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  File does not exist yet. It will be created when you save.
                </div>
              ) : (
                <textarea
                  className="w-full h-full resize-none bg-transparent p-4 text-sm font-mono outline-none"
                  value={displayValue}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`# ${selectedOrEntry}\n\nWrite your instructions here...`}
                  spellCheck={false}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
