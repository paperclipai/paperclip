import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ProjectFileDetail, ProjectFilesBranch, ProjectFilesBranchSyncDetail, ProjectFilesBranchSyncResult, ProjectFilesTreeEntry } from "@paperclipai/shared";
import { AlertCircle, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, CheckCircle2, ChevronLeft, ChevronRight, Cloud, Copy, FilePlus2, FolderPlus, FolderTree, GitBranch, GitMerge, Loader2, RefreshCw, Save, UploadCloud, XCircle } from "lucide-react";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PackageFileTree, type FileTreeNode } from "./PackageFileTree";
import { MarkdownBody } from "./MarkdownBody";
import { PageSkeleton } from "./PageSkeleton";
import { CopyText } from "./CopyText";
import { useToast } from "../context/ToastContext";
import { ProjectCodeEditor } from "./ProjectCodeEditor";

type TreeCache = Record<string, ProjectFilesTreeEntry[]>;

function parentDir(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
}

function fileNodesFromCache(entriesByDir: TreeCache, dirPath = ""): FileTreeNode[] {
  const entries = entriesByDir[dirPath] ?? [];
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    kind: entry.kind === "dir" ? "dir" : "file",
    children: entry.kind === "dir" ? fileNodesFromCache(entriesByDir, entry.path) : [],
  }));
}

function filterBranches(branches: ProjectFilesBranch[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return branches;
  return branches.filter((branch) => branch.name.toLowerCase().includes(normalized));
}

function treeSignature(entries: ProjectFilesTreeEntry[]) {
  return entries
    .map((entry) => `${entry.kind}:${entry.path}:${entry.hiddenByDefault ? "hidden" : "visible"}`)
    .join("|");
}

const BRANCH_SYNC_ACTION_CONFIG: Record<
  ProjectFilesBranchSyncDetail["action"],
  { icon: React.ReactNode; label: string; textColor: string }
> = {
  pushed_to_remote: { icon: <ArrowUpFromLine className="h-4 w-4" />, label: "Pushed to remote", textColor: "text-green-400" },
  created_local_tracking: { icon: <ArrowDownToLine className="h-4 w-4" />, label: "Created local tracking branch", textColor: "text-blue-400" },
  remote_deleted_local_remains: { icon: <AlertTriangle className="h-4 w-4" />, label: "Remote deleted — local branch remains", textColor: "text-amber-400" },
  already_in_sync: { icon: <CheckCircle2 className="h-4 w-4" />, label: "In sync", textColor: "text-muted-foreground" },
  error: { icon: <XCircle className="h-4 w-4" />, label: "Error", textColor: "text-destructive" },
};

function BranchSyncDetailRow({ detail }: { detail: ProjectFilesBranchSyncDetail }) {
  const config = BRANCH_SYNC_ACTION_CONFIG[detail.action];
  return (
    <div className={`flex items-start gap-2 text-sm py-1 ${config.textColor}`}>
      <span className="mt-0.5 shrink-0">{config.icon}</span>
      <div className="min-w-0 flex-1">
        <span className="font-mono font-medium">{detail.branchName}</span>
        <span className="ml-2 text-xs opacity-75">{config.label}</span>
        {detail.errorMessage ? (
          <p className="text-xs opacity-60 truncate mt-0.5">{detail.errorMessage}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ProjectFilesTab({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showIgnored, setShowIgnored] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [entriesByDir, setEntriesByDir] = useState<TreeCache>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const [createBranchName, setCreateBranchName] = useState("");
  const [createPathOpen, setCreatePathOpen] = useState<null | "file" | "folder" | "rename" | "delete">(null);
  const [actionTargetPath, setActionTargetPath] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [dirtyBranchTarget, setDirtyBranchTarget] = useState<string | null>(null);
  const [branchSyncDialogOpen, setBranchSyncDialogOpen] = useState(false);
  const [branchSyncResult, setBranchSyncResult] = useState<ProjectFilesBranchSyncResult | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [showReloadHint, setShowReloadHint] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [markdownViewMode, setMarkdownViewMode] = useState<"preview" | "source">("preview");
  const [compactTreePane, setCompactTreePane] = useState(false);
  const entriesByDirRef = useRef<TreeCache>({});
  const selectedPathRef = useRef<string | null>(null);
  const loadingDirKeysRef = useRef<Set<string>>(new Set());
  const watchInFlightRef = useRef(false);

  const { data: summary, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.projects.filesSummary(projectId, companyId),
    queryFn: () => projectsApi.filesSummary(projectId, companyId),
    enabled: Boolean(projectId && companyId),
  });

  const fileTree = useMemo(() => fileNodesFromCache(entriesByDir), [entriesByDir]);

  const selectedFileQuery = useQuery({
    queryKey: selectedPath ? queryKeys.projects.fileContent(projectId, selectedPath, companyId) : ["projects", "file-content", "none"],
    queryFn: () => projectsApi.fileContent(projectId, selectedPath!, companyId),
    enabled: Boolean(selectedPath),
  });

  useEffect(() => {
    if (selectedFileQuery.data?.textContent != null) {
      setEditorValue(selectedFileQuery.data.textContent);
    }
  }, [selectedFileQuery.data?.path, selectedFileQuery.data?.textContent]);

  useEffect(() => {
    if (selectedFileQuery.data?.previewType === "markdown") {
      setMarkdownViewMode("preview");
      return;
    }
    setMarkdownViewMode("source");
  }, [selectedFileQuery.data?.path, selectedFileQuery.data?.previewType]);

  useEffect(() => {
    entriesByDirRef.current = entriesByDir;
  }, [entriesByDir]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const loadDirectory = useCallback(async (dirPath: string, force = false) => {
    const cacheKey = `${showIgnored ? "ignored" : "default"}:${dirPath}`;
    if (!force && entriesByDirRef.current[dirPath]) return;
    if (loadingDirKeysRef.current.has(cacheKey)) return;
    loadingDirKeysRef.current.add(cacheKey);
    setLoadingDirs((current) => new Set(current).add(dirPath));
    try {
      const tree = await projectsApi.filesTree(projectId, { path: dirPath, showIgnored, companyId });
      setEntriesByDir((current) => ({ ...current, [dirPath]: tree.entries }));
      if (!selectedPathRef.current) {
        const firstFile = tree.entries.find((entry) => entry.kind === "file");
        if (firstFile) setSelectedPath(firstFile.path);
      }
    } catch (treeError) {
      pushToast({
        title: treeError instanceof Error ? treeError.message : "Failed to load files",
        tone: "error",
      });
    } finally {
      setLoadingDirs((current) => {
        const next = new Set(current);
        next.delete(dirPath);
        return next;
      });
      loadingDirKeysRef.current.delete(cacheKey);
    }
  }, [companyId, projectId, pushToast, showIgnored]);

  useEffect(() => {
    if (!summary?.available) return;
    void loadDirectory("", true);
  }, [summary?.available, showIgnored, loadDirectory]);

  const checkForExternalChanges = useCallback(async () => {
    if (!summary?.available || showReloadHint || watchInFlightRef.current || document.visibilityState !== "visible") return;
    const loadedDirs = Object.keys(entriesByDirRef.current);
    if (loadedDirs.length === 0) return;
    watchInFlightRef.current = true;
    try {
      for (const dirPath of loadedDirs) {
        const latest = await projectsApi.filesTree(projectId, { path: dirPath, showIgnored, companyId });
        const currentEntries = entriesByDirRef.current[dirPath] ?? [];
        if (treeSignature(latest.entries) !== treeSignature(currentEntries)) {
          setShowReloadHint(true);
          return;
        }
      }
      if (selectedPathRef.current) {
        const latestFile = await projectsApi.fileContent(projectId, selectedPathRef.current, companyId);
        const currentFile = selectedFileQuery.data;
        if (
          currentFile &&
          latestFile.updatedAt !== currentFile.updatedAt
        ) {
          setShowReloadHint(true);
        }
      }
    } catch {
      // Ignore background watch errors; manual refresh remains available.
    } finally {
      watchInFlightRef.current = false;
    }
  }, [companyId, projectId, selectedFileQuery.data, showIgnored, showReloadHint, summary?.available]);

  useEffect(() => {
    if (!summary?.available) return;
    const intervalId = window.setInterval(() => {
      void checkForExternalChanges();
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [checkForExternalChanges, summary?.available]);

  const refreshAll = useCallback(async () => {
    setEntriesByDir({});
    entriesByDirRef.current = {};
    loadingDirKeysRef.current.clear();
    setShowReloadHint(false);
    await refetch();
    await loadDirectory("", true);
    if (selectedPath) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.fileContent(projectId, selectedPath, companyId) });
    }
  }, [companyId, loadDirectory, projectId, queryClient, refetch, selectedPath]);

  const switchBranch = useMutation({
    mutationFn: (input: { branch: string; mode?: "default" | "autostash" | "discard" }) =>
      projectsApi.switchBranch(projectId, input, companyId),
    onSuccess: async () => {
      setDirtyBranchTarget(null);
      setBranchDialogOpen(false);
      await refreshAll();
    },
    onError: (mutationError, input) => {
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        setDirtyBranchTarget(input.branch);
        return;
      }
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to switch branch",
        tone: "error",
      });
    },
  });

  const createBranch = useMutation({
    mutationFn: (name: string) => projectsApi.createBranch(projectId, { name }, companyId),
    onSuccess: async () => {
      setCreateBranchName("");
      setBranchDialogOpen(false);
      await refreshAll();
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to create branch",
        tone: "error",
      });
    },
  });

  const syncRepo = useMutation({
    mutationFn: () => projectsApi.syncFiles(projectId, companyId),
    onSuccess: async (result) => {
      pushToast({
        title: result.message ?? `Git sync ${result.status}`,
        tone: result.status === "success" ? "success" : "error",
      });
      await refreshAll();
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to sync repository",
        tone: "error",
      });
    },
  });

  const syncBranches = useMutation({
    mutationFn: () => projectsApi.syncBranches(projectId, companyId),
    onSuccess: async (result) => {
      await refreshAll();
      setBranchSyncResult(result);
      setBranchSyncDialogOpen(true);
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to sync branches",
        tone: "error",
      });
    },
  });

  const publishToRemote = useMutation({
    mutationFn: () => projectsApi.publishToRemote(projectId, publishUrl, companyId),
    onSuccess: async (result) => {
      if (result.status === "success") {
        pushToast({ title: "Published to remote", tone: "success" });
        setPublishUrl("");
        await refreshAll();
      } else {
        pushToast({ title: result.message ?? "Failed to publish", tone: "error" });
      }
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to publish to remote",
        tone: "error",
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: (input: { path: string; content: string }) => projectsApi.saveFileContent(projectId, input, companyId),
    onSuccess: async (detail) => {
      setEditorValue(detail.textContent ?? "");
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.fileContent(projectId, detail.path, companyId) });
      pushToast({ title: `Saved ${detail.name}`, tone: "success" });
      setShowReloadHint(false);
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to save file",
        tone: "error",
      });
    },
  });

  const createPath = useMutation({
    mutationFn: async () => {
      if (createPathOpen === "file") {
        return await projectsApi.createFile(projectId, { path: pathDraft }, companyId);
      }
      if (createPathOpen === "folder") {
        return await projectsApi.createFolder(projectId, { path: pathDraft }, companyId);
      }
      if (createPathOpen === "rename" && actionTargetPath) {
        return await projectsApi.renamePath(projectId, { path: actionTargetPath, nextPath: pathDraft }, companyId);
      }
      if (createPathOpen === "delete" && actionTargetPath) {
        return await projectsApi.deletePath(projectId, actionTargetPath, companyId);
      }
      return null;
    },
    onSuccess: async () => {
      if (createPathOpen === "delete" && actionTargetPath && selectedPathRef.current === actionTargetPath) {
        setSelectedPath(null);
      }
      if (createPathOpen === "rename" && actionTargetPath && selectedPathRef.current === actionTargetPath) {
        setSelectedPath(pathDraft);
      }
      setCreatePathOpen(null);
      setActionTargetPath(null);
      setPathDraft("");
      await refreshAll();
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Path operation failed",
        tone: "error",
      });
    },
  });

  const filteredLocalBranches = useMemo(
    () => filterBranches((summary?.branches ?? []).filter((b) => b.kind === "local"), branchSearch),
    [branchSearch, summary?.branches],
  );

  const filteredRemoteBranches = useMemo(
    () => filterBranches((summary?.branches ?? []).filter((b) => b.kind === "remote"), branchSearch),
    [branchSearch, summary?.branches],
  );

  const selectedFile = selectedFileQuery.data ?? null;
  const fileDirty = selectedFile?.textContent != null && editorValue !== selectedFile.textContent;
  const canEditSelectedFile = selectedFile?.textContent != null && selectedFile.previewType !== "json";
  const treePaneColumns = compactTreePane
    ? "lg:grid-cols-[128px_minmax(0,1fr)]"
    : "lg:grid-cols-[320px_minmax(0,1fr)]";

  const toggleDir = async (dirPath: string) => {
    const nextExpanded = new Set(expandedDirs);
    if (nextExpanded.has(dirPath)) nextExpanded.delete(dirPath);
    else nextExpanded.add(dirPath);
    setExpandedDirs(nextExpanded);
    if (!entriesByDir[dirPath]) {
      await loadDirectory(dirPath);
    }
  };

  const openPathDialog = useCallback((mode: "file" | "folder" | "rename" | "delete", targetPath?: string | null, targetKind?: "file" | "dir" | null) => {
    const resolvedPath = targetPath ?? selectedPathRef.current;
    const resolvedKind = targetKind ?? (resolvedPath ? "file" : null);
    setActionTargetPath(resolvedPath ?? null);
    setCreatePathOpen(mode);
    if (mode === "rename" && resolvedPath) setPathDraft(resolvedPath);
    else if ((mode === "file" || mode === "folder") && resolvedPath) {
      setPathDraft(resolvedKind === "dir" ? resolvedPath : parentDir(resolvedPath));
    }
    else setPathDraft("");
  }, []);

  const wrapNodeWithContextMenu = useCallback((node: FileTreeNode, row: ReactNode) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {node.kind === "dir" ? (
          <>
            <ContextMenuItem
              onSelect={(event) => {
                event.stopPropagation();
                openPathDialog("file", node.path, "dir");
              }}
            >
              New file
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={(event) => {
                event.stopPropagation();
                openPathDialog("folder", node.path, "dir");
              }}
            >
              New folder
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation();
            openPathDialog("rename", node.path, node.kind);
          }}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.stopPropagation();
            openPathDialog("delete", node.path, node.kind);
          }}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ), [openPathDialog]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!summary) return null;

  if (!summary.available) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        This project does not currently have a usable local workspace to browse.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showReloadHint ? (
        <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="flex items-center gap-2 text-amber-100">
            <AlertCircle className="h-4 w-4" />
            Files may have changed outside the UI.
          </div>
          <Button size="sm" variant="outline" onClick={() => void refreshAll()}>
            Reload
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
        <Button variant="outline" size="sm" onClick={() => setBranchDialogOpen(true)}>
          <GitBranch className="h-4 w-4" />
          {summary.currentBranch ?? "No branch"}
        </Button>
        {summary.hasRemote ? (
          <>
            <Button variant="outline" size="sm" onClick={() => syncRepo.mutate()} disabled={syncRepo.isPending}>
              <RefreshCw className={`h-4 w-4 ${syncRepo.isPending ? "animate-spin" : ""}`} />
              Git Sync
            </Button>
            <Button variant="outline" size="sm" onClick={() => syncBranches.mutate()} disabled={syncBranches.isPending}>
              <GitMerge className={`h-4 w-4 ${syncBranches.isPending ? "animate-spin" : ""}`} />
              Branch Sync
            </Button>
          </>
        ) : (
          <div className="flex flex-1 items-center gap-2">
            <Input
              placeholder="https://github.com/org/repo"
              value={publishUrl}
              onChange={(e) => setPublishUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && publishUrl) publishToRemote.mutate(); }}
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              onClick={() => publishToRemote.mutate()}
              disabled={!publishUrl.trim() || publishToRemote.isPending}
            >
              {publishToRemote.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              Publish
            </Button>
          </div>
        )}
      </div>

      <div className={`grid gap-4 ${treePaneColumns}`}>
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2" onClick={() => void refreshAll()}>
                    <FolderTree className="h-4 w-4" />
                    Files
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>
                  Refresh tree
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="ml-auto flex items-center gap-1">
              {!compactTreePane ? (
                <>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openPathDialog("file")}>
                    <FilePlus2 className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openPathDialog("folder")}>
                    <FolderPlus className="h-4 w-4" />
                  </Button>
                </>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setCompactTreePane((current) => !current)}
                title={compactTreePane ? "Expand tree pane" : "Compact tree pane"}
              >
                {compactTreePane ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground px-2">
            <label className="flex items-center gap-2 cursor-pointer" title="Show ignored folders">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={(event) => {
                  setShowIgnored(event.target.checked);
                  setEntriesByDir({});
                  entriesByDirRef.current = {};
                  setShowReloadHint(false);
                }}
              />
              {!compactTreePane ? "Show ignored folders" : null}
            </label>
            {summary.rootPath ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1">
                      {!compactTreePane ? <span className="cursor-default">Folder path</span> : null}
                      <CopyText text={summary.rootPath} copiedLabel="Path copied">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={4} className="max-w-md break-all font-mono">
                    {summary.rootPath}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
          <div className="max-h-[70vh] overflow-auto">
            <PackageFileTree
              nodes={fileTree}
              selectedFile={selectedPath}
              expandedDirs={expandedDirs}
              onToggleDir={(dirPath) => { void toggleDir(dirPath); }}
              onSelectFile={(nextPath) => setSelectedPath(nextPath)}
              wrapDirRow={wrapNodeWithContextMenu}
              wrapFileRow={(_node, _checked, row) => wrapNodeWithContextMenu(_node, row)}
              showCheckboxes={false}
            />
            {loadingDirs.has("") ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading files...</p> : null}
          </div>
        </div>

        <div className="rounded-lg border border-border p-4 space-y-4 min-w-0">
          {selectedPath ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm" title={selectedPath}>{selectedPath}</p>
                {selectedFile ? (
                  <p className="text-xs text-muted-foreground">
                    {selectedFile.previewType} · {selectedFile.size} bytes
                  </p>
                ) : null}
              </div>
              {selectedFile?.previewType === "markdown" ? (
                <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5">
                  <Button
                    size="sm"
                    variant={markdownViewMode === "preview" ? "secondary" : "ghost"}
                    className="h-8"
                    onClick={() => setMarkdownViewMode("preview")}
                  >
                    Preview
                  </Button>
                  <Button
                    size="sm"
                    variant={markdownViewMode === "source" ? "secondary" : "ghost"}
                    className="h-8"
                    onClick={() => setMarkdownViewMode("source")}
                  >
                    Source
                  </Button>
                </div>
              ) : null}
              {canEditSelectedFile ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => saveFile.mutate({ path: selectedFile.path, content: editorValue })}
                  disabled={!fileDirty || saveFile.isPending}
                >
                  <Save className="h-4 w-4" />
                  Save
                </Button>
              ) : null}
            </div>
          ) : null}

          {!selectedPath ? (
            <p className="text-sm text-muted-foreground">Select a file to preview it.</p>
          ) : selectedFileQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading file...</p>
          ) : selectedFileQuery.error ? (
            <p className="text-sm text-destructive">{(selectedFileQuery.error as Error).message}</p>
          ) : selectedFile?.previewType === "image" && selectedFile.base64Content ? (
            <img
              src={`data:${selectedFile.mimeType ?? "image/png"};base64,${selectedFile.base64Content}`}
              alt={selectedFile.name}
              className="max-h-[70vh] max-w-full object-contain rounded-lg border border-border"
            />
          ) : selectedFile?.previewType === "markdown" && markdownViewMode === "preview" ? (
            <div className="rounded-lg border border-border p-4">
              <MarkdownBody>{editorValue}</MarkdownBody>
            </div>
          ) : selectedFile?.previewType === "binary" ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
              Binary files are not previewable yet.
            </div>
          ) : selectedFile?.textContent != null ? (
            <ProjectCodeEditor
              value={editorValue}
              readOnly={selectedFile.previewType === "json"}
              language={selectedFile.language}
              onChange={setEditorValue}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
              No preview available.
            </div>
          )}
        </div>
      </div>

      <Dialog open={branchDialogOpen} onOpenChange={(open) => { setBranchDialogOpen(open); if (!open) setBranchSearch(""); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Switch branch</DialogTitle>
            <DialogDescription>
              Local and remote branches. Selecting a remote branch creates a local tracking branch automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Command className="rounded-md border flex-1">
                <CommandInput placeholder="Search branches..." value={branchSearch} onValueChange={setBranchSearch} />
                <CommandList>
                  <CommandEmpty>No branches found.</CommandEmpty>
                  {filteredLocalBranches.length > 0 && (
                    <CommandGroup heading="Local">
                      {filteredLocalBranches.map((branch) => (
                        <CommandItem key={`local:${branch.name}`} onSelect={() => switchBranch.mutate({ branch: branch.name })}>
                          <GitBranch className="h-4 w-4 shrink-0" />
                          <span className={`flex-1 ${branch.current ? "font-semibold" : ""}`}>{branch.name}</span>
                          {branch.tracking ? <span className="text-xs text-muted-foreground truncate max-w-[120px]">→ {branch.tracking}</span> : null}
                          {branch.current ? <Check className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {filteredRemoteBranches.length > 0 && (
                    <CommandGroup heading="Remote">
                      {filteredRemoteBranches.map((branch) => (
                        <CommandItem key={`remote:${branch.name}`} onSelect={() => switchBranch.mutate({ branch: branch.name })}>
                          <Cloud className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{branch.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
              <Button variant="outline" size="sm" onClick={() => void refetch()} className="self-start mt-1">
                Refresh
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={createBranchName}
                onChange={(event) => setCreateBranchName(event.target.value)}
                placeholder="New branch name"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && createBranchName.trim() && !createBranch.isPending) {
                    createBranch.mutate(createBranchName);
                  }
                }}
              />
              <Button onClick={() => createBranch.mutate(createBranchName)} disabled={!createBranchName.trim() || createBranch.isPending}>
                Create branch
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dirtyBranchTarget !== null} onOpenChange={(open) => { if (!open) setDirtyBranchTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Working tree has local changes</DialogTitle>
            <DialogDescription>
              Switching to <code className="font-mono">{dirtyBranchTarget}</code> would move or lose uncommitted changes. Choose how to continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDirtyBranchTarget(null)}>Cancel</Button>
            <Button
              variant="outline"
              onClick={() => dirtyBranchTarget && switchBranch.mutate({ branch: dirtyBranchTarget, mode: "autostash" })}
            >
              Switch with autostash
            </Button>
            <Button
              variant="destructive"
              onClick={() => dirtyBranchTarget && switchBranch.mutate({ branch: dirtyBranchTarget, mode: "discard" })}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createPathOpen !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatePathOpen(null);
            setActionTargetPath(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createPathOpen === "file" ? "New file" : createPathOpen === "folder" ? "New folder" : createPathOpen === "rename" ? "Rename path" : "Delete path"}
            </DialogTitle>
            <DialogDescription>
              {createPathOpen === "delete" ? "This removes the selected path from the project workspace." : "Provide the project-relative path."}
            </DialogDescription>
          </DialogHeader>
          {createPathOpen === "delete" ? (
            <p className="text-sm font-mono">{actionTargetPath}</p>
          ) : (
            <Input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} placeholder="relative/path" />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreatePathOpen(null);
                setActionTargetPath(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant={createPathOpen === "delete" ? "destructive" : "default"}
              onClick={() => createPath.mutate()}
              disabled={createPath.isPending || (createPathOpen !== "delete" && !pathDraft.trim())}
            >
              {createPathOpen === "delete" ? "Delete" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={branchSyncDialogOpen} onOpenChange={setBranchSyncDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Branch Sync Results</DialogTitle>
            <DialogDescription>
              {branchSyncResult?.message ?? "All branches have been reconciled with origin."}
            </DialogDescription>
          </DialogHeader>
          {branchSyncResult && (
            <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
              {branchSyncResult.details.some((d) => d.action === "remote_deleted_local_remains") && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-1 mb-3">
                  <p className="font-medium text-amber-200 flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" />
                    Some branches have deleted upstreams
                  </p>
                  <p className="text-amber-100/80 text-xs">
                    These local branches tracked a remote branch that has since been deleted. Delete them manually with{" "}
                    <code className="font-mono">git branch -d &lt;name&gt;</code> when ready.
                  </p>
                </div>
              )}
              {branchSyncResult.details.map((detail) => (
                <BranchSyncDetailRow key={detail.branchName} detail={detail} />
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchSyncDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
