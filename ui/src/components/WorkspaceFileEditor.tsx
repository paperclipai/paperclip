import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  workspaceFilesApi,
  type WorkspaceFileEntry,
} from "../api/workspace-files";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  Save,
  X,
  Folder,
  FileText,
  ChevronLeft,
  FolderOpen,
  RefreshCw,
  Copy,
  ArrowRightLeft,
  Trash2,
} from "lucide-react";
import { cn } from "../lib/utils";

// ─── File Browser ────────────────────────────────────────────────────────────

interface FileBrowserProps {
  companyId: string;
  workspaceId: string;
  currentDir: string;
  showHidden: boolean;
  onCurrentDirChange: (dir: string) => void;
  onShowHiddenChange: (show: boolean) => void;
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}

function FileBrowser({
  companyId,
  workspaceId,
  currentDir,
  showHidden,
  onCurrentDirChange: setCurrentDir,
  onShowHiddenChange: setShowHidden,
  onSelectFile,
  onClose,
  onError,
}: FileBrowserProps) {
  const queryClient = useQueryClient();
  const [promptAction, setPromptAction] = useState<{
    kind: "move" | "copy";
    entry: WorkspaceFileEntry;
  } | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workspaceFiles.list(workspaceId, currentDir), showHidden],
    queryFn: () => workspaceFilesApi.list(companyId, workspaceId, currentDir, showHidden),
    retry: false,
  });

  const files = data?.files ?? [];

  const invalidateDir = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.workspaceFiles.list(workspaceId, currentDir),
    });
  }, [queryClient, workspaceId, currentDir]);

  const handleNavigate = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (entry.isDirectory) {
        setCurrentDir(entry.path);
      } else {
        onSelectFile(entry.path);
      }
    },
    [setCurrentDir, onSelectFile],
  );

  const handleBack = useCallback(() => {
    if (currentDir === ".") return;
    const parts = currentDir.split("/");
    parts.pop();
    setCurrentDir(parts.length === 0 ? "." : parts.join("/"));
  }, [currentDir, setCurrentDir]);

  const handleDelete = useCallback(
    async (entry: WorkspaceFileEntry) => {
      const label = entry.isDirectory ? `Delete folder "${entry.name}" and all its contents` : `Delete "${entry.name}"`;
      if (!window.confirm(`${label}? This cannot be undone.`)) return;
      setActionBusy(true);
      try {
        await workspaceFilesApi.remove(companyId, workspaceId, entry.path, entry.isDirectory);
        invalidateDir();
      } catch {
        onError?.("Failed to delete.");
      } finally {
        setActionBusy(false);
      }
    },
    [companyId, workspaceId, invalidateDir, onError],
  );

  const handleMoveOrCopy = useCallback(async () => {
    if (!promptAction || !promptValue.trim()) return;
    setActionBusy(true);
    try {
      const dest = promptValue.trim();
      if (promptAction.kind === "copy") {
        await workspaceFilesApi.copy(companyId, workspaceId, promptAction.entry.path, dest);
      } else {
        await workspaceFilesApi.move(companyId, workspaceId, promptAction.entry.path, dest);
      }
      invalidateDir();
      setPromptAction(null);
      setPromptValue("");
    } catch {
      onError?.(`Failed to ${promptAction.kind}.`);
    } finally {
      setActionBusy(false);
    }
  }, [companyId, workspaceId, promptAction, promptValue, invalidateDir, onError]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Browse Workspace Files
          </DialogTitle>
          <DialogDescription>
            Select a file to view or edit.
          </DialogDescription>
        </DialogHeader>

        {/* Move/copy destination prompt */}
        {promptAction && (
          <div className="flex items-center gap-2 px-1 py-2 border-b border-border">
            <span className="text-xs text-muted-foreground shrink-0 capitalize">{promptAction.kind}:</span>
            <input
              autoFocus
              className="font-mono text-xs bg-transparent border-b border-foreground/30 focus:border-foreground focus:outline-none flex-1 min-w-0"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder="Destination path..."
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleMoveOrCopy(); }
                if (e.key === "Escape") { setPromptAction(null); setPromptValue(""); }
              }}
            />
            <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={handleMoveOrCopy} disabled={actionBusy || !promptValue.trim()}>
              {actionBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Go"}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => { setPromptAction(null); setPromptValue(""); }}>
              Cancel
            </Button>
          </div>
        )}

        {/* Current path + back button */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground border-b border-border pb-2">
          {currentDir !== "." && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleBack}
              className="shrink-0"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          )}
          <input
            className="font-mono text-xs bg-transparent border-b border-transparent hover:border-muted-foreground/30 focus:border-foreground focus:outline-none flex-1 min-w-0"
            defaultValue={`/${currentDir === "." ? "" : currentDir}`}
            key={currentDir}
            placeholder="/ (press Enter to navigate)"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const raw = (e.target as HTMLInputElement).value;
                const val = raw.replace(/^\/+/, "").replace(/\/+$/, "");
                setCurrentDir(val || ".");
              }
            }}
          />
          <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="rounded border-border"
            />
            Show hidden
          </label>
        </div>

        {/* File list */}
        <ScrollArea className="flex-1 min-h-0 max-h-[50vh]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              Failed to list directory. The workspace may not have a local path.
            </div>
          ) : files.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              Empty directory.
            </div>
          ) : (
            <div className="flex flex-col">
              {files.map((entry) => (
                <div
                  key={entry.path}
                  className="group flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors rounded-sm"
                >
                  <button
                    type="button"
                    onClick={() => handleNavigate(entry)}
                    className="flex items-center gap-2.5 min-w-0 flex-1"
                  >
                    {entry.isDirectory ? (
                      <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                  <span className="flex items-center gap-0.5 shrink-0">
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                          onClick={(e) => { e.stopPropagation(); setPromptAction({ kind: "move", entry }); setPromptValue(entry.path); }}
                          disabled={actionBusy}
                        >
                          <ArrowRightLeft className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Move</TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                          onClick={(e) => { e.stopPropagation(); setPromptAction({ kind: "copy", entry }); setPromptValue(entry.path); }}
                          disabled={actionBusy}
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Copy</TooltipContent>
                    </Tooltip>
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          onClick={(e) => { e.stopPropagation(); handleDelete(entry); }}
                          disabled={actionBusy}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Delete</TooltipContent>
                    </Tooltip>
                  </span>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── File Editor ─────────────────────────────────────────────────────────────

interface WorkspaceFileEditorProps {
  companyId: string;
  workspaceId: string;
  filePath: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function WorkspaceFileEditor({
  companyId,
  workspaceId,
  filePath,
  onClose,
  onSaved,
}: WorkspaceFileEditorProps) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    data: fileData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.workspaceFiles.read(workspaceId, filePath),
    queryFn: () => workspaceFilesApi.read(companyId, workspaceId, filePath),
    retry: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (fileData?.content != null && !isDirty) {
      setContent(fileData.content);
    }
  }, [fileData, isDirty]);

  const saveMutation = useMutation({
    mutationFn: () =>
      workspaceFilesApi.write(companyId, workspaceId, filePath, content),
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFiles.read(workspaceId, filePath),
      });
      onSaved?.();
    },
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saveMutation.isPending) {
          saveMutation.mutate();
        }
      }
    },
    [isDirty, saveMutation.isPending, saveMutation.mutate],
  );

  const lineCount = content.split("\n").length;

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [content, wordWrap]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (isDirty && !window.confirm("You have unsaved changes. Discard?")) return;
          onClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-4xl max-h-[90vh] flex flex-col p-0 gap-0"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-mono truncate">{filePath}</span>
            {isDirty && (
              <span className="text-xs text-amber-500 shrink-0">(modified)</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={wordWrap}
                onChange={(e) => setWordWrap(e.target.checked)}
                className="rounded border-border"
              />
              Wrap
            </label>
            {saveMutation.isError && (
              <span className="text-xs text-destructive">Save failed</span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (isDirty && !window.confirm("Reload will discard unsaved changes. Continue?")) return;
                setIsDirty(false);
                refetch();
              }}
              title="Reload file from disk"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={isDirty ? "default" : "outline"}
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              Save
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (isDirty && !window.confirm("You have unsaved changes. Discard?")) return;
                onClose();
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Editor body */}
        <div className="flex-1 min-h-0 overflow-auto" onKeyDown={handleKeyDown}>
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 gap-2">
              <p className="text-sm text-muted-foreground">
                Failed to load file.
              </p>
              <p className="text-xs text-muted-foreground/60">
                The file may not exist or the workspace path may be unavailable.
              </p>
            </div>
          ) : (
            <div className="flex min-h-full">
              {/* Line numbers */}
              <div
                className="select-none text-right pr-3 pl-3 py-3 text-xs font-mono text-muted-foreground/50 bg-muted/30 border-r border-border shrink-0 leading-[1.5rem]"
                aria-hidden="true"
              >
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setIsDirty(true);
                }}
                spellCheck={false}
                className={cn(
                  "flex-1 resize-none bg-transparent p-3 text-sm font-mono outline-none",
                  "leading-[1.5rem] tab-size-2",
                  wordWrap ? "whitespace-pre-wrap break-words overflow-hidden" : "whitespace-pre overflow-hidden",
                )}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Public wrapper that shows browser first, then editor ────────────────────

interface WorkspaceFileBrowserProps {
  companyId: string;
  workspaceId: string;
  onClose: () => void;
  onSaved?: () => void;
  onError?: (message: string) => void;
  initialFile?: string | null;
  initialDir?: string | null;
}

export function WorkspaceFileBrowser({
  companyId,
  workspaceId,
  onClose,
  onSaved,
  onError,
  initialFile,
  initialDir,
}: WorkspaceFileBrowserProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [browserDir, setBrowserDir] = useState(initialDir ?? ".");
  const [browserShowHidden, setBrowserShowHidden] = useState(false);
  const openedDirectly = useRef(!!initialFile);

  useEffect(() => {
    if (!selectedFile) openedDirectly.current = false;
  }, [selectedFile]);

  if (selectedFile) {
    return (
      <WorkspaceFileEditor
        companyId={companyId}
        workspaceId={workspaceId}
        filePath={selectedFile}
        onClose={() => {
          if (openedDirectly.current) {
            // Opened via direct file link — close the whole modal
            onClose();
          } else {
            // Opened via browser — go back to browser
            setSelectedFile(null);
          }
        }}
        onSaved={onSaved}
      />
    );
  }

  return (
    <FileBrowser
      companyId={companyId}
      workspaceId={workspaceId}
      currentDir={browserDir}
      showHidden={browserShowHidden}
      onCurrentDirChange={setBrowserDir}
      onShowHiddenChange={setBrowserShowHidden}
      onSelectFile={setSelectedFile}
      onClose={onClose}
      onError={onError}
    />
  );
}
