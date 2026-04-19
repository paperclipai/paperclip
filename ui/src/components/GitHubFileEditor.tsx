import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { githubFilesApi, isConflictError, type GitHubFile, type GitHubTreeEntry } from "../api/github-files";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";
import { LazyFileEditor } from "./LazyFileEditor";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { AlertTriangle, ChevronRight, File, Folder, GitCommit, Loader2, RefreshCw, Save, X } from "lucide-react";

interface GitHubFileEditorProps {
  projectId: string;
}

export function GitHubFileEditor({ projectId }: GitHubFileEditorProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [fileSha, setFileSha] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // Fetch directory listing
  const {
    data: tree,
    isLoading: treeLoading,
    error: treeError,
  } = useQuery({
    queryKey: queryKeys.githubFiles.tree(projectId, currentPath),
    queryFn: () => githubFilesApi.listFiles(projectId, currentPath || undefined),
    enabled: !!projectId,
  });

  // Fetch selected file content
  const {
    data: fileData,
    isLoading: fileLoading,
    error: fileError,
  } = useQuery({
    queryKey: queryKeys.githubFiles.file(projectId, selectedFile ?? ""),
    queryFn: () => githubFilesApi.getFile(projectId, selectedFile!),
    enabled: !!projectId && !!selectedFile,
  });

  // When file data loads, set the SHA for conflict detection
  useEffect(() => {
    if (fileData) {
      setFileSha(fileData.sha);
      setEditedContent(null);
      setConflictError(false);
      setCommitMessage("");
    }
  }, [fileData]);

  const hasChanges = editedContent !== null && editedContent !== fileData?.content;

  // Save file mutation
  const saveFile = useMutation({
    mutationFn: async () => {
      if (!selectedFile || editedContent === null) return;
      return githubFilesApi.putFile(projectId, selectedFile, {
        content: editedContent,
        message: commitMessage.trim() || `Update ${selectedFile}`,
        sha: fileSha ?? undefined,
      });
    },
    onSuccess: (result) => {
      if (!result) return;
      setFileSha(result.sha);
      setEditedContent(null);
      setConflictError(false);
      setCommitMessage("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.githubFiles.file(projectId, selectedFile!),
      });
      pushToast({ title: "File saved to GitHub", tone: "success" });
    },
    onError: (error) => {
      if (isConflictError(error)) {
        setConflictError(true);
        pushToast({
          title: "Version conflict — file was modified externally",
          tone: "error",
        });
      } else {
        pushToast({
          title: error instanceof Error ? error.message : "Failed to save file",
          tone: "error",
        });
      }
    },
  });

  const handleNavigate = useCallback((entry: GitHubTreeEntry) => {
    if (entry.type === "dir") {
      setCurrentPath(entry.path);
      setSelectedFile(null);
      setEditedContent(null);
    } else {
      setSelectedFile(entry.path);
    }
  }, []);

  const handleNavigateUp = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
    setSelectedFile(null);
    setEditedContent(null);
  }, [currentPath]);

  const handleReload = useCallback(() => {
    if (selectedFile) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.githubFiles.file(projectId, selectedFile),
      });
    }
    setConflictError(false);
    setEditedContent(null);
  }, [selectedFile, projectId, queryClient]);

  const handleSave = useCallback(() => {
    if (!hasChanges) return;
    saveFile.mutate();
  }, [hasChanges, saveFile]);

  // Breadcrumb segments
  const pathParts = currentPath ? currentPath.split("/") : [];

  return (
    <div className="space-y-3">
      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <button
          type="button"
          className="hover:text-foreground transition-colors font-medium"
          onClick={() => {
            setCurrentPath("");
            setSelectedFile(null);
            setEditedContent(null);
          }}
        >
          root
        </button>
        {pathParts.map((part, i) => {
          const path = pathParts.slice(0, i + 1).join("/");
          return (
            <span key={path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 shrink-0" />
              <button
                type="button"
                className="hover:text-foreground transition-colors"
                onClick={() => {
                  setCurrentPath(path);
                  setSelectedFile(null);
                  setEditedContent(null);
                }}
              >
                {part}
              </button>
            </span>
          );
        })}
        {selectedFile && (
          <>
            <ChevronRight className="h-3 w-3 shrink-0" />
            <span className="text-foreground font-medium">{selectedFile.split("/").pop()}</span>
          </>
        )}
      </div>

      {/* File tree (when no file selected) */}
      {!selectedFile && (
        <div className="rounded-lg border border-border divide-y divide-border">
          {currentPath && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
              onClick={handleNavigateUp}
            >
              <Folder className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">..</span>
            </button>
          )}
          {treeLoading && (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading files...
            </div>
          )}
          {treeError && (
            <div className="px-3 py-4 text-sm text-destructive">
              {treeError instanceof Error ? treeError.message : "Failed to load files"}
            </div>
          )}
          {tree
            ?.sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent/20 transition-colors text-left"
                onClick={() => handleNavigate(entry)}
              >
                {entry.type === "dir" ? (
                  <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                ) : (
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
                {entry.type === "file" && entry.size > 0 && (
                  <span className="ml-auto text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {entry.size < 1024 ? `${entry.size} B` : `${(entry.size / 1024).toFixed(1)} KB`}
                  </span>
                )}
              </button>
            ))}
          {tree && tree.length === 0 && !treeLoading && (
            <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory</div>
          )}
        </div>
      )}

      {/* File editor */}
      {selectedFile && (
        <div className="space-y-3">
          {/* Conflict warning */}
          {conflictError && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                Version conflict: the file was modified since you loaded it. Reload to get the latest version.
              </span>
              <Button variant="outline" size="sm" onClick={handleReload} className="shrink-0 gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                Reload
              </Button>
            </div>
          )}

          {fileLoading && (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading file...
            </div>
          )}
          {fileError && (
            <div className="py-4 text-sm text-destructive">
              {fileError instanceof Error ? fileError.message : "Failed to load file"}
            </div>
          )}

          {fileData && (
            <>
              <div className="rounded-lg border border-border overflow-hidden">
                <LazyFileEditor
                  filename={selectedFile}
                  value={editedContent ?? fileData.content}
                  onChange={setEditedContent}
                  className="min-h-[300px] max-h-[500px] [&_.cm-editor]:min-h-[300px] [&_.cm-scroller]:overflow-auto"
                />
              </div>

              {/* Commit message + save */}
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-1.5">
                  <label
                    htmlFor="commit-message"
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                  >
                    <GitCommit className="h-3.5 w-3.5" />
                    Commit message
                  </label>
                  <input
                    id="commit-message"
                    type="text"
                    placeholder={`Update ${selectedFile.split("/").pop()}`}
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedFile(null);
                      setEditedContent(null);
                      setCommitMessage("");
                      setConflictError(false);
                    }}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Close
                  </Button>
                  <Button
                    size="sm"
                    disabled={!hasChanges || saveFile.isPending || conflictError}
                    onClick={handleSave}
                    className="gap-1.5"
                  >
                    {saveFile.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Confirm Changes
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
