import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GitStatusEntry, GitStatusResponse, ProjectFileDetail, ProjectFilesBranch, ProjectFilesBranchSyncDetail, ProjectFilesBranchSyncResult, ProjectFilesTreeEntry } from "@paperclipai/shared";
import { AlertCircle, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, CheckCircle2, ChevronLeft, ChevronRight, Cloud, Copy, FilePlus2, FolderPlus, FolderTree, GitBranch, GitCommitHorizontal, GitMerge, Loader2, Minus, Plus, RefreshCw, RotateCcw, Save, Trash2, UploadCloud, XCircle, XIcon } from "lucide-react";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  local_auto_deleted: { icon: <XCircle className="h-4 w-4" />, label: "Local branch deleted (remote was gone)", textColor: "text-muted-foreground" },
  remote_deleted_local_remains: { icon: <AlertTriangle className="h-4 w-4" />, label: "Remote deleted — could not auto-delete local", textColor: "text-amber-400" },
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

const GIT_STATUS_LABEL: Record<string, { letter: string; color: string }> = {
  M: { letter: "M", color: "text-yellow-400" },
  A: { letter: "A", color: "text-green-400" },
  D: { letter: "D", color: "text-red-400" },
  R: { letter: "R", color: "text-purple-400" },
  "?": { letter: "U", color: "text-blue-400" },
  C: { letter: "C", color: "text-green-300" },
};

function gitStatusBadge(status: string) {
  const cfg = GIT_STATUS_LABEL[status] ?? { letter: status, color: "text-muted-foreground" };
  return (
    <span className={`shrink-0 font-mono text-[10px] font-semibold ${cfg.color}`}>{cfg.letter}</span>
  );
}

function GitFileRow({
  entry,
  staged,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  entry: GitStatusEntry;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const statusLetter = staged ? entry.indexStatus : (entry.isUntracked ? "?" : entry.workingStatus);
  const fileName = entry.path.split("/").pop() ?? entry.path;
  const dirPart = entry.path !== fileName ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  return (
    <div
      className={`group flex items-center gap-1 rounded px-2 py-1 text-sm cursor-pointer hover:bg-accent/30 ${selected ? "bg-accent/20 text-foreground" : "text-muted-foreground"}`}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.path}>
        {fileName}
        {dirPart ? <span className="ml-1 text-[10px] opacity-50">{dirPart}</span> : null}
      </span>
      {gitStatusBadge(statusLetter)}
      {staged && onUnstage ? (
        <button
          type="button"
          title="Unstage"
          className="ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onUnstage(); }}
        >
          <Minus className="h-3 w-3" />
        </button>
      ) : null}
      {!staged && onStage ? (
        <button
          type="button"
          title="Stage"
          className="ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onStage(); }}
        >
          <Plus className="h-3 w-3" />
        </button>
      ) : null}
      {onDiscard ? (
        <button
          type="button"
          title={entry.isUntracked ? "Delete file" : "Discard changes"}
          className="ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onDiscard(); }}
        >
          {entry.isUntracked ? <Trash2 className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
        </button>
      ) : null}
    </div>
  );
}

function GitSectionHeader({
  label,
  count,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: {
  label: string;
  count: number;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
  onDiscardAll?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="flex-1">{label} <span className="font-normal opacity-60">({count})</span></span>
      {onStageAll ? (
        <button type="button" title="Stage all" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={onStageAll}>
          <Plus className="h-3 w-3" />
        </button>
      ) : null}
      {onUnstageAll ? (
        <button type="button" title="Unstage all" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={onUnstageAll}>
          <Minus className="h-3 w-3" />
        </button>
      ) : null}
      {onDiscardAll ? (
        <button type="button" title="Discard all" className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive" onClick={onDiscardAll}>
          <RotateCcw className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function DiffViewer({ diff, path }: { diff: string; path: string }) {
  if (!diff) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        No diff available for this file.
      </div>
    );
  }
  const lines = diff.split("\n");
  return (
    <div className="rounded-lg border border-border overflow-auto max-h-[70vh]">
      <div className="px-3 py-2 border-b border-border text-xs font-mono text-muted-foreground bg-muted/30">
        {path}
      </div>
      <pre className="text-xs font-mono leading-5 p-3 min-w-0">
        {lines.map((line, i) => {
          let cls = "text-muted-foreground";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-400 bg-green-400/10";
          else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400 bg-red-400/10";
          else if (line.startsWith("@@")) cls = "text-blue-400";
          else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) cls = "text-muted-foreground opacity-60";
          return (
            <div key={i} className={`${cls} block whitespace-pre`}>{line || " "}</div>
          );
        })}
      </pre>
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
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<string | null>(null);
  const [deleteBranchConfirmed, setDeleteBranchConfirmed] = useState(false);
  const [branchSyncDialogOpen, setBranchSyncDialogOpen] = useState(false);
  const [branchSyncResult, setBranchSyncResult] = useState<ProjectFilesBranchSyncResult | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [showReloadHint, setShowReloadHint] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [markdownViewMode, setMarkdownViewMode] = useState<"preview" | "source">("preview");
  const [compactTreePane, setCompactTreePane] = useState(false);
  const [gitViewActive, setGitViewActive] = useState(false);
  const [gitSelectedFile, setGitSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [discardConfirmPaths, setDiscardConfirmPaths] = useState<string[] | null>(null);
  const entriesByDirRef = useRef<TreeCache>({});
  const selectedPathRef = useRef<string | null>(null);
  const loadingDirKeysRef = useRef<Set<string>>(new Set());
  const watchInFlightRef = useRef(false);

  const { data: summary, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.projects.filesSummary(projectId, companyId),
    queryFn: () => projectsApi.filesSummary(projectId, companyId),
    enabled: Boolean(projectId && companyId),
  });

  const gitStatusQuery = useQuery({
    queryKey: queryKeys.projects.gitStatus(projectId, companyId),
    queryFn: () => projectsApi.gitStatus(projectId, companyId),
    enabled: Boolean(projectId && companyId && summary?.gitEnabled),
    refetchInterval: gitViewActive ? 4000 : false,
  });

  const gitDiffQuery = useQuery({
    queryKey: gitSelectedFile
      ? queryKeys.projects.fileDiff(projectId, gitSelectedFile.path, gitSelectedFile.staged, companyId)
      : ["projects", "file-diff", "none"],
    queryFn: () => projectsApi.fileDiff(projectId, gitSelectedFile!.path, gitSelectedFile!.staged, companyId),
    enabled: Boolean(gitSelectedFile),
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

  const deleteBranch = useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      projectsApi.deleteBranch(projectId, name, force ?? false, companyId),
    onSuccess: async () => {
      setDeleteBranchTarget(null);
      setDeleteBranchConfirmed(false);
      await refreshAll();
    },
    onError: (mutationError) => {
      pushToast({
        title: mutationError instanceof Error ? mutationError.message : "Failed to delete branch",
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

  const discardFiles = useMutation({
    mutationFn: (paths: string[]) => projectsApi.discardFiles(projectId, { paths }, companyId),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.projects.gitStatus(projectId, companyId), data);
      setDiscardConfirmPaths(null);
      if (gitSelectedFile && !data.entries.some((e) => e.path === gitSelectedFile.path)) {
        setGitSelectedFile(null);
      }
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Discard failed", tone: "error" }),
  });

  const stageFiles = useMutation({
    mutationFn: (paths: string[]) => projectsApi.stageFiles(projectId, { paths }, companyId),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.projects.gitStatus(projectId, companyId), data);
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Stage failed", tone: "error" }),
  });

  const unstageFiles = useMutation({
    mutationFn: (paths: string[]) => projectsApi.unstageFiles(projectId, { paths }, companyId),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.projects.gitStatus(projectId, companyId), data);
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Unstage failed", tone: "error" }),
  });

  const commitStaged = useMutation({
    mutationFn: (message: string) => projectsApi.commitStaged(projectId, { message }, companyId),
    onSuccess: async (result) => {
      if (result.status === "success") {
        pushToast({ title: `Committed${result.sha ? ` (${result.sha})` : ""}`, tone: "success" });
        setCommitMessage("");
        setGitSelectedFile(null);
        await queryClient.invalidateQueries({ queryKey: queryKeys.projects.gitStatus(projectId, companyId) });
        await refetch();
      } else if (result.status === "nothing_to_commit") {
        pushToast({ title: "Nothing to commit", tone: "error" });
      } else {
        pushToast({ title: result.message ?? "Commit failed", tone: "error" });
      }
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Commit failed", tone: "error" }),
  });

  const pushFiles = useMutation({
    mutationFn: () => projectsApi.pushFiles(projectId, companyId),
    onSuccess: async (result) => {
      if (result.status === "success") {
        pushToast({ title: "Pushed to remote", tone: "success" });
        await refetch();
      } else {
        pushToast({ title: result.message ?? "Push failed", tone: "error" });
      }
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Push failed", tone: "error" }),
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

  const gitEntries: GitStatusResponse["entries"] = gitStatusQuery.data?.entries ?? [];
  const stagedEntries = gitEntries.filter((e) => e.isStaged);
  const unstagedEntries = gitEntries.filter((e) => !e.isUntracked && e.isUnstaged && !e.isStaged);
  const untrackedEntries = gitEntries.filter((e) => e.isUntracked);

  const fileStatusMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of gitEntries) {
      if (entry.isUntracked) { map[entry.path] = "?"; }
      else if (entry.isStaged) { map[entry.path] = entry.indexStatus; }
      else if (entry.isUnstaged) { map[entry.path] = entry.workingStatus; }
    }
    return map;
  }, [gitEntries]);

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
            <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant={gitViewActive ? "ghost" : "secondary"}
                      className="h-7 gap-1.5 px-2 text-xs"
                      onClick={() => setGitViewActive(false)}
                    >
                      <FolderTree className="h-3.5 w-3.5" />
                      {!compactTreePane ? "Files" : null}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={4}>File explorer</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant={gitViewActive ? "secondary" : "ghost"}
                      className="h-7 gap-1.5 px-2 text-xs"
                      onClick={() => { setGitViewActive(true); void gitStatusQuery.refetch(); }}
                      disabled={!summary.gitEnabled}
                    >
                      <GitCommitHorizontal className="h-3.5 w-3.5" />
                      {!compactTreePane ? (
                        <span className="flex items-center gap-1">
                          Source Control
                          {gitEntries.length > 0 ? (
                            <span className="rounded-full bg-primary/20 px-1.5 py-0 text-[10px] font-semibold text-primary">
                              {gitEntries.length}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={4}>{summary.gitEnabled ? "Source control" : "Git not available"}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="ml-auto flex items-center gap-1">
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

          {!gitViewActive && !compactTreePane ? (
            <div className="flex items-center gap-1 border-b border-border pb-2">
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => openPathDialog("file")}>
                <FilePlus2 className="h-3.5 w-3.5" />
                New file
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => openPathDialog("folder")}>
                <FolderPlus className="h-3.5 w-3.5" />
                New folder
              </Button>
            </div>
          ) : null}

          {gitViewActive ? (
            <div className="space-y-2">
              {gitStatusQuery.isLoading ? (
                <p className="px-2 py-4 text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes...
                </p>
              ) : gitEntries.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">No changes</p>
              ) : (
                <div className="max-h-[45vh] overflow-auto space-y-1">
                  {stagedEntries.length > 0 ? (
                    <div>
                      <GitSectionHeader
                        label="Staged"
                        count={stagedEntries.length}
                        onUnstageAll={() => unstageFiles.mutate(stagedEntries.map((e) => e.path))}
                        onDiscardAll={() => setDiscardConfirmPaths(stagedEntries.map((e) => e.path))}
                      />
                      {stagedEntries.map((entry) => (
                        <GitFileRow
                          key={`staged:${entry.path}`}
                          entry={entry}
                          staged
                          selected={gitSelectedFile?.path === entry.path && gitSelectedFile?.staged === true}
                          onSelect={() => setGitSelectedFile({ path: entry.path, staged: true })}
                          onUnstage={() => unstageFiles.mutate([entry.path])}
                          onDiscard={() => setDiscardConfirmPaths([entry.path])}
                        />
                      ))}
                    </div>
                  ) : null}

                  {unstagedEntries.length > 0 ? (
                    <div>
                      <GitSectionHeader
                        label="Changes"
                        count={unstagedEntries.length}
                        onStageAll={() => stageFiles.mutate(unstagedEntries.map((e) => e.path))}
                        onDiscardAll={() => setDiscardConfirmPaths(unstagedEntries.map((e) => e.path))}
                      />
                      {unstagedEntries.map((entry) => (
                        <GitFileRow
                          key={`unstaged:${entry.path}`}
                          entry={entry}
                          staged={false}
                          selected={gitSelectedFile?.path === entry.path && gitSelectedFile?.staged === false}
                          onSelect={() => setGitSelectedFile({ path: entry.path, staged: false })}
                          onStage={() => stageFiles.mutate([entry.path])}
                          onDiscard={() => setDiscardConfirmPaths([entry.path])}
                        />
                      ))}
                    </div>
                  ) : null}

                  {untrackedEntries.length > 0 ? (
                    <div>
                      <GitSectionHeader
                        label="Untracked"
                        count={untrackedEntries.length}
                        onStageAll={() => stageFiles.mutate(untrackedEntries.map((e) => e.path))}
                        onDiscardAll={() => setDiscardConfirmPaths(untrackedEntries.map((e) => e.path))}
                      />
                      {untrackedEntries.map((entry) => (
                        <GitFileRow
                          key={`untracked:${entry.path}`}
                          entry={entry}
                          staged={false}
                          selected={gitSelectedFile?.path === entry.path && gitSelectedFile?.staged === false}
                          onSelect={() => setGitSelectedFile({ path: entry.path, staged: false })}
                          onStage={() => stageFiles.mutate([entry.path])}
                          onDiscard={() => setDiscardConfirmPaths([entry.path])}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )}

              <div className="space-y-2 border-t border-border pt-2">
                {!compactTreePane ? (
                  <textarea
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    rows={3}
                    placeholder="Commit message..."
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commitMessage.trim() && stagedEntries.length > 0) {
                        commitStaged.mutate(commitMessage);
                      }
                    }}
                  />
                ) : null}
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    className="flex-1 min-w-0"
                    onClick={() => commitStaged.mutate(commitMessage)}
                    disabled={!commitMessage.trim() || stagedEntries.length === 0 || commitStaged.isPending}
                    title="Commit staged changes"
                  >
                    {commitStaged.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                    {!compactTreePane ? "Commit" : null}
                  </Button>
                  {summary.hasRemote ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => pushFiles.mutate()}
                      disabled={pushFiles.isPending}
                      title="Push to remote"
                      className="shrink-0"
                    >
                      {pushFiles.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ArrowUpFromLine className="h-3.5 w-3.5" />
                      )}
                      {!compactTreePane ? (
                        <>
                          Push
                          {summary.aheadBehind?.ahead ? (
                            <span className="ml-1 text-xs opacity-70">↑{summary.aheadBehind.ahead}</span>
                          ) : null}
                        </>
                      ) : summary.aheadBehind?.ahead ? (
                        <span className="text-[10px] opacity-70">↑{summary.aheadBehind.ahead}</span>
                      ) : null}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <>
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
                  fileStatusMap={fileStatusMap}
                  showCheckboxes={false}
                />
                {loadingDirs.has("") ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading files...</p> : null}
              </div>
            </>
          )}
        </div>

        <div className="rounded-lg border border-border p-4 space-y-4 min-w-0">
          {gitViewActive && gitSelectedFile ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <p className="truncate font-mono text-sm flex-1" title={gitSelectedFile.path}>{gitSelectedFile.path}</p>
                <span className="shrink-0 text-xs text-muted-foreground">{gitSelectedFile.staged ? "staged" : "working tree"}</span>
              </div>
              {gitDiffQuery.isLoading ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading diff...</p>
              ) : (
                <DiffViewer diff={gitDiffQuery.data?.diff ?? ""} path={gitSelectedFile.path} />
              )}
            </>
          ) : gitViewActive ? (
            <p className="text-sm text-muted-foreground">Select a changed file to view its diff.</p>
          ) : null}

          {!gitViewActive && selectedPath ? (
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

          {!gitViewActive ? (!selectedPath ? (
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
          )) : null}
        </div>
      </div>

      <Dialog open={branchDialogOpen} onOpenChange={(open) => { setBranchDialogOpen(open); if (!open) setBranchSearch(""); }}>
        <DialogContent className="sm:max-w-xl p-0 gap-0 overflow-hidden" showCloseButton={false}>
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b border-border">
            <div>
              <DialogTitle className="text-base">Branches</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Select to switch · remote branches create a local tracking copy
              </DialogDescription>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void refetch()} disabled={syncBranches.isPending}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={4}>Refresh branch list</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {summary?.hasRemote ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 relative"
                        onClick={() => syncBranches.mutate()}
                        disabled={syncBranches.isPending}
                      >
                        <GitMerge className="h-4 w-4" />
                        {syncBranches.isPending ? (
                          <span className="absolute inset-0 flex items-center justify-center rounded-md bg-background/80">
                            <Loader2 className="h-4 w-4 animate-spin" />
                          </span>
                        ) : null}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={4}>Sync all branches with remote</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DialogClose asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <XIcon className="h-4 w-4" />
                      </Button>
                    </DialogClose>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={4}>Close</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Search + branch list */}
          <Command className="rounded-none border-none">
            <div className="px-3 pt-3 pb-1">
              <CommandInput placeholder="Search branches..." value={branchSearch} onValueChange={setBranchSearch} className="h-8" />
            </div>
            <CommandList className="max-h-64 px-1 pb-2">
              <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">No branches found.</CommandEmpty>
              {filteredLocalBranches.length > 0 && (
                <CommandGroup heading="Local">
                  {filteredLocalBranches.map((branch) => (
                    <ContextMenu key={`local:${branch.name}`}>
                      <ContextMenuTrigger asChild>
                        <CommandItem
                          onSelect={() => switchBranch.mutate({ branch: branch.name })}
                          className="rounded-md group"
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className={`flex-1 truncate text-sm ${branch.current ? "font-semibold" : ""}`}>{branch.name}</span>
                          {branch.tracking ? (
                            <span className="text-xs text-muted-foreground/60 truncate max-w-[100px] shrink-0">
                              {branch.tracking.replace("origin/", "↑ ")}
                            </span>
                          ) : null}
                          {branch.current ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <button
                              type="button"
                              className="ml-1 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-destructive transition-opacity"
                              onClick={(e) => { e.stopPropagation(); setDeleteBranchTarget(branch.name); setDeleteBranchConfirmed(false); }}
                              tabIndex={-1}
                            >
                              <XIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </CommandItem>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => { setDeleteBranchTarget(branch.name); setDeleteBranchConfirmed(false); }}
                          disabled={branch.current}
                        >
                          Delete branch
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </CommandGroup>
              )}
              {filteredRemoteBranches.length > 0 && (
                <CommandGroup heading="Remote">
                  {filteredRemoteBranches.map((branch) => (
                    <CommandItem
                      key={`remote:${branch.name}`}
                      onSelect={() => switchBranch.mutate({ branch: branch.name })}
                      className="rounded-md"
                    >
                      <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-sm">{branch.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>

          {/* Create branch footer */}
          <div className="flex items-center gap-2 px-3 py-3 border-t border-border bg-muted/30">
            <Input
              value={createBranchName}
              onChange={(event) => setCreateBranchName(event.target.value)}
              placeholder="New branch name"
              className="h-8 text-sm"
              onKeyDown={(event) => {
                if (event.key === "Enter" && createBranchName.trim() && !createBranch.isPending) {
                  createBranch.mutate(createBranchName);
                }
              }}
            />
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => createBranch.mutate(createBranchName)}
              disabled={!createBranchName.trim() || createBranch.isPending}
            >
              {createBranch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
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

      <Dialog
        open={deleteBranchTarget !== null}
        onOpenChange={(open) => { if (!open) { setDeleteBranchTarget(null); setDeleteBranchConfirmed(false); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete branch</DialogTitle>
            <DialogDescription>
              {deleteBranchConfirmed
                ? <>Are you <strong>absolutely sure</strong>? This cannot be undone.</>
                : <>Delete local branch <code className="font-mono">{deleteBranchTarget}</code>? This only removes it locally.</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteBranchTarget(null); setDeleteBranchConfirmed(false); }}>
              Cancel
            </Button>
            {deleteBranchConfirmed ? (
              <Button
                variant="destructive"
                disabled={deleteBranch.isPending}
                onClick={() => deleteBranchTarget && deleteBranch.mutate({ name: deleteBranchTarget })}
              >
                {deleteBranch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Yes, delete it
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => setDeleteBranchConfirmed(true)}>
                Delete
              </Button>
            )}
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
                    Some branches could not be auto-deleted
                  </p>
                  <p className="text-amber-100/80 text-xs">
                    These local branches have a deleted upstream but could not be removed automatically (current branch or unmerged commits). Delete manually with{" "}
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

      <Dialog open={discardConfirmPaths !== null} onOpenChange={(open) => { if (!open) setDiscardConfirmPaths(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {discardConfirmPaths?.length === 1
                ? `This will permanently discard changes to "${discardConfirmPaths[0]}". This cannot be undone.`
                : `This will permanently discard changes to ${discardConfirmPaths?.length ?? 0} files. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardConfirmPaths(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => discardConfirmPaths && discardFiles.mutate(discardConfirmPaths)}
              disabled={discardFiles.isPending}
            >
              {discardFiles.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
