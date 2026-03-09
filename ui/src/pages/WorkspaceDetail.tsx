/**
 * WorkspaceDetail page.
 *
 * Displays a single workspace with a split-pane layout: a resizable file tree
 * on the left and a CodeMirror 6 editor on the right. Selecting a file in the
 * tree loads its content into the editor; Ctrl+S / Cmd+S or the Save button
 * writes the buffer back to the server via the workspace-files API.
 *
 * The info bar shows the current git branch (with dirty indicator) when the
 * workspace directory is a git repository.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { workspaceFilesApi } from "../api/workspace-files";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { FileTree } from "../components/FileTree";
import { CodeMirrorEditor } from "../components/CodeMirrorEditor";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  FolderOpen,
  Trash2,
  GitBranch,
  ChevronRight,
  Home,
  Save,
  X,
  Undo2,
  Redo2,
  Eye,
  Pencil,
  PanelLeft,
  WrapText,
  GripVertical,
  Circle,
} from "lucide-react";
import { cn, formatDate } from "../lib/utils";

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

/** Editor view mode for the current file. */
type EditorMode = "edit" | "preview";

const AUTO_SAVE_DELAY = 1500; // ms

export function WorkspaceDetail() {
  const { companyPrefix, projectId, workspaceId } = useParams<{
    companyPrefix?: string;
    projectId: string;
    workspaceId: string;
  }>();
  const { companies, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const { isMobile } = useSidebar();
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editingName, setEditingName] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [pathValue, setPathValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  // File tree + editor state
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");

  const [wordWrap, setWordWrap] = useState(false);

  // Mobile: show file tree or editor panel
  const [mobileShowTree, setMobileShowTree] = useState(true);

  // Resizable divider
  const [treeWidth, setTreeWidth] = useState(208); // 13rem ≈ 208px
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const prefix = companyPrefix.toUpperCase();
    return companies.find((c) => c.issuePrefix.toUpperCase() === prefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;

  const { data: project } = useQuery({
    queryKey: [...queryKeys.projects.detail(projectId ?? ""), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(projectId!, lookupCompanyId),
    enabled: !!projectId,
  });

  const { data: workspace, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.workspace(projectId ?? "", workspaceId ?? ""),
    queryFn: () => projectsApi.getWorkspace(projectId!, workspaceId!, lookupCompanyId),
    enabled: !!projectId && !!workspaceId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? projectId ?? "Project", href: `/projects/${projectId}` },
      { label: "Workspaces", href: `/projects/${projectId}/workspaces` },
      { label: workspace?.name ?? workspaceId ?? "Workspace" },
    ]);
  }, [setBreadcrumbs, project, projectId, workspace, workspaceId]);

  const invalidateWorkspace = () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.workspace(projectId!, workspaceId!),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.workspaces(projectId!),
    });
  };

  const updateWorkspace = useMutation({
    mutationFn: (data: { name?: string; cwd?: string }) =>
      projectsApi.updateWorkspace(projectId!, workspaceId!, data, lookupCompanyId),
    onSuccess: () => {
      setEditingName(false);
      setEditingPath(false);
      setNameError(null);
      setPathError(null);
      invalidateWorkspace();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: () => projectsApi.removeWorkspace(projectId!, workspaceId!, lookupCompanyId),
    onSuccess: () => {
      navigate(`/projects/${projectId}/workspaces`);
    },
  });

  const handleDelete = () => {
    if (!window.confirm(`Delete workspace "${workspace?.name}"?`)) return;
    removeWorkspace.mutate();
  };

  // File editor is only available when workspace has a local directory
  const workspaceCwd = workspace?.cwd;
  const hasLocalDir = !!workspaceCwd && workspaceCwd !== "/__paperclip_repo_only__";

  // Git branch info
  const { data: gitInfo } = useQuery({
    queryKey: queryKeys.workspaceFiles.gitInfo(workspaceId ?? ""),
    queryFn: () => workspaceFilesApi.gitInfo(workspaceId!),
    enabled: !!workspaceId && hasLocalDir,
    staleTime: 30_000,
  });

  // Load file content when a file is selected
  const { data: fileData, isLoading: isFileLoading } = useQuery({
    queryKey: queryKeys.workspaceFiles.file(workspaceId ?? "", selectedFilePath ?? ""),
    queryFn: () => workspaceFilesApi.read(workspaceId!, selectedFilePath!),
    enabled: !!workspaceId && !!selectedFilePath && hasLocalDir,
  });

  useEffect(() => {
    if (fileData) {
      setEditorContent(fileData.content);
      setEditorDirty(false);
    }
  }, [fileData]);

  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      workspaceFilesApi.write(workspaceId!, path, content),
    onSuccess: (_, { path, content }) => {
      setEditorDirty(false);
      queryClient.setQueryData(
        queryKeys.workspaceFiles.file(workspaceId!, path),
        { path, content },
      );
      pushToast({ title: "File saved", body: path, tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to save file", tone: "error" });
    },
  });

  // Stable ref for save mutation so auto-save timer doesn't go stale
  const saveFileRef = useRef(saveFile);
  saveFileRef.current = saveFile;

  // Auto-save: debounced save after edits
  useEffect(() => {
    if (!autoSave || !editorDirty || !selectedFilePath) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    const savePath = selectedFilePath;
    const saveContent = editorContent;
    autoSaveTimerRef.current = setTimeout(() => {
      saveFileRef.current.mutate({ path: savePath, content: saveContent });
    }, AUTO_SAVE_DELAY);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [autoSave, editorDirty, editorContent, selectedFilePath]);

  const handleFileSelect = (path: string) => {
    // If the same file is already selected, just ensure the editor is visible
    if (path === selectedFilePath) {
      if (isMobile) setMobileShowTree(false);
      return;
    }
    if (editorDirty) {
      if (!window.confirm("You have unsaved changes. Discard them?")) return;
    }
    setSelectedFilePath(path);
    setEditorContent("");
    setEditorDirty(false);
    // Default markdown files to preview mode
    setEditorMode(isMarkdownFile(path) ? "preview" : "edit");
    // On mobile, switch to editor view when a file is selected
    if (isMobile) setMobileShowTree(false);
  };

  const handleEditorChange = useCallback((value: string) => {
    setEditorContent(value);
    setEditorDirty(true);
  }, []);

  const handleEditorSave = useCallback(() => {
    if (selectedFilePath) {
      saveFile.mutate({ path: selectedFilePath, content: editorContent });
    }
  }, [saveFile, selectedFilePath, editorContent]);

  // Build breadcrumb segments for the current file path
  const pathSegments = useMemo(() => {
    if (!selectedFilePath) return [];
    return selectedFilePath.split("/").filter(Boolean);
  }, [selectedFilePath]);

  // Undo/redo via CodeMirror commands dispatched from the parent
  const editorRef = useRef<{ undo: () => void; redo: () => void } | null>(null);

  // Resizable divider mouse handlers
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = treeWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientX - startXRef.current;
      const newWidth = Math.max(120, Math.min(600, startWidthRef.current + delta));
      setTreeWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [treeWidth]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!workspace) return null;

  const isMarkdown = selectedFilePath ? isMarkdownFile(selectedFilePath) : false;

  return (
    <div className="flex flex-col gap-3 -mb-4 md:-mb-6" style={{ height: "calc(100dvh - 7rem)" }}>
      {/* Header row */}
      <div className="flex items-start gap-3 shrink-0">
        <FolderOpen className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = nameValue.trim();
                if (!name) {
                  setNameError("Name cannot be empty.");
                  return;
                }
                setNameError(null);
                updateWorkspace.mutate({ name });
              }}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-lg font-bold outline-none focus:ring-1 focus:ring-ring"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  autoFocus
                />
                <Button size="sm" type="submit" disabled={updateWorkspace.isPending}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => { setEditingName(false); setNameError(null); }}
                >
                  Cancel
                </Button>
              </div>
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
            </form>
          ) : (
            <h2
              className="text-lg font-bold cursor-pointer hover:opacity-70 truncate"
              onClick={() => {
                setNameValue(workspace.name);
                setNameError(null);
                setEditingName(true);
              }}
              title="Click to edit name"
            >
              {workspace.name}
            </h2>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleDelete}
          disabled={removeWorkspace.isPending}
          aria-label="Delete workspace"
          className="shrink-0"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Info bar */}
      <div className="flex items-center justify-between gap-2 border-b border-border shrink-0 pb-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          {gitInfo?.branch && (
            <span className="flex items-center gap-1 shrink-0" title={gitInfo.dirty ? "Uncommitted changes" : "Clean"}>
              <GitBranch className="h-3.5 w-3.5" />
              <span className="font-mono">{gitInfo.branch}</span>
              {gitInfo.dirty && <Circle className="h-2 w-2 fill-amber-400 text-amber-400" />}
            </span>
          )}
          {gitInfo?.branch && <span className="text-muted-foreground/50">·</span>}
          {editingPath ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const cwd = pathValue.trim();
                if (!cwd) {
                  setPathError("Path cannot be empty.");
                  return;
                }
                setPathError(null);
                updateWorkspace.mutate({ cwd });
              }}
              className="flex items-center gap-2"
            >
              <input
                className="w-64 rounded border border-border bg-transparent px-2 py-0.5 text-xs font-mono outline-none focus:ring-1 focus:ring-ring"
                value={pathValue}
                onChange={(e) => setPathValue(e.target.value)}
                autoFocus
              />
              <Button size="xs" type="submit" disabled={updateWorkspace.isPending}>
                Save
              </Button>
              <Button
                size="xs"
                variant="ghost"
                type="button"
                onClick={() => { setEditingPath(false); setPathError(null); }}
              >
                Cancel
              </Button>
              {pathError && <span className="text-destructive">{pathError}</span>}
            </form>
          ) : (
            <span
              className="hidden md:inline font-mono cursor-pointer hover:text-foreground transition-colors truncate max-w-xs"
              onClick={() => {
                setPathValue(workspace.cwd ?? "");
                setPathError(null);
                setEditingPath(true);
              }}
              title="Click to edit path"
            >
              {workspace.cwd ?? "No path set"}
            </span>
          )}
        </div>
        <span className="hidden md:inline shrink-0 text-xs text-muted-foreground" title={`Created ${formatDate(workspace.createdAt)}`}>
          Updated {formatDate(workspace.updatedAt)}
        </span>
      </div>

      {/* File browser — fills remaining space */}
      {hasLocalDir ? (
        <div className="rounded-lg border border-border overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="flex flex-1 min-h-0">
            {/* File tree sidebar — hidden on mobile when a file is selected */}
            <div
              className={cn(
                "shrink-0 flex flex-col min-h-0",
                isMobile
                  ? mobileShowTree
                    ? "w-full"
                    : "hidden"
                  : "",
              )}
              style={isMobile ? undefined : { width: treeWidth }}
            >
              <FileTree
                workspaceId={workspaceId!}
                onFileSelect={handleFileSelect}
                selectedPath={selectedFilePath}
              />
            </div>

            {/* Resizable divider — desktop only */}
            {!isMobile && (
              <div
                className="w-1 shrink-0 cursor-col-resize flex items-center justify-center hover:bg-accent/60 active:bg-accent transition-colors border-l border-border"
                onMouseDown={handleDividerMouseDown}
                title="Drag to resize"
              >
                <GripVertical className="h-4 w-4 text-muted-foreground/40" />
              </div>
            )}

            {/* Editor pane — hidden on mobile when tree is shown */}
            <div
              className={cn(
                "flex flex-col flex-1 min-w-0 min-h-0",
                isMobile && mobileShowTree && "hidden",
              )}
            >
              {/* Path breadcrumb + mobile back button */}
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border text-xs text-muted-foreground shrink-0 min-h-[32px]">
                {isMobile && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 mr-1"
                    onClick={() => setMobileShowTree(true)}
                    aria-label="Show file tree"
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Home className="h-3 w-3 shrink-0" />
                {pathSegments.map((segment, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span
                      className={
                        i === pathSegments.length - 1
                          ? "text-foreground font-medium"
                          : ""
                      }
                    >
                      {segment}
                    </span>
                  </span>
                ))}
              </div>

              {selectedFilePath ? (
                <div className="flex flex-col flex-1 min-h-0">
                  {/* Editor toolbar */}
                  <div className="flex items-center justify-between px-2 md:px-3 py-1 border-b border-border shrink-0 gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-xs text-muted-foreground truncate">
                        {isFileLoading
                          ? "Loading…"
                          : editorDirty
                            ? autoSave ? "Auto-saving…" : "Unsaved changes"
                            : "Saved"}
                      </span>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {/* Undo / Redo */}
                      {editorMode === "edit" && (
                        <>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => editorRef.current?.undo()}
                            title="Undo (Ctrl+Z)"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => editorRef.current?.redo()}
                            title="Redo (Ctrl+Shift+Z)"
                          >
                            <Redo2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}

                      {/* Word wrap toggle */}
                      {editorMode === "edit" && (
                        <Button
                          size="icon-xs"
                          variant={wordWrap ? "secondary" : "ghost"}
                          onClick={() => setWordWrap((w) => !w)}
                          title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
                        >
                          <WrapText className="h-3.5 w-3.5" />
                        </Button>
                      )}

                      {/* Markdown preview / edit toggle */}
                      {isMarkdown && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setEditorMode((m) => (m === "preview" ? "edit" : "preview"))
                          }
                          title={editorMode === "preview" ? "Edit" : "Preview"}
                        >
                          {editorMode === "preview" ? (
                            <><Pencil className="h-3.5 w-3.5 mr-1" />Edit</>
                          ) : (
                            <><Eye className="h-3.5 w-3.5 mr-1" />Preview</>
                          )}
                        </Button>
                      )}

                      {/* Auto-save toggle */}
                      <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none ml-1">
                        <input
                          type="checkbox"
                          checked={autoSave}
                          onChange={(e) => setAutoSave(e.target.checked)}
                          className="h-3 w-3 rounded border-border"
                        />
                        Auto
                      </label>

                      {editorDirty && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            if (fileData) {
                              setEditorContent(fileData.content);
                              setEditorDirty(false);
                            }
                          }}
                        >
                          <X className="h-3.5 w-3.5 mr-1" />
                          <span className="hidden md:inline">Discard</span>
                        </Button>
                      )}
                      <Button
                        size="xs"
                        onClick={() => selectedFilePath && saveFile.mutate({ path: selectedFilePath, content: editorContent })}
                        disabled={!editorDirty || saveFile.isPending}
                      >
                        <Save className="h-3.5 w-3.5 mr-1" />
                        Save
                      </Button>
                    </div>
                  </div>

                  {isFileLoading ? (
                    <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
                      Loading file…
                    </div>
                  ) : editorMode === "preview" && isMarkdown ? (
                    <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
                      <MarkdownBody>{editorContent}</MarkdownBody>
                    </div>
                  ) : (
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <CodeMirrorEditor
                        ref={editorRef}
                        filePath={selectedFilePath}
                        content={editorContent}
                        onChange={handleEditorChange}
                        onSave={handleEditorSave}
                        wordWrap={wordWrap}
                        dark={theme === "dark"}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 text-center gap-2 text-muted-foreground">
                  <FolderOpen className="h-8 w-8 opacity-30" />
                  <p className="text-sm">Select a file to view its contents</p>
                  <p className="text-xs opacity-70">
                    Use the file tree on the left to navigate
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground border border-border rounded-lg">
          <FolderOpen className="h-8 w-8 opacity-30" />
          <p className="text-sm">No local directory configured</p>
          <p className="text-xs opacity-70">
            Set a filesystem path above to enable the file editor.
          </p>
        </div>
      )}

      {updateWorkspace.isError && (
        <p className="text-sm text-destructive shrink-0">Failed to update workspace.</p>
      )}
      {removeWorkspace.isError && (
        <p className="text-sm text-destructive shrink-0">Failed to delete workspace.</p>
      )}
    </div>
  );
}
