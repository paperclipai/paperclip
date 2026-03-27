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
  Loader2,
  Save,
  X,
  Folder,
  FileText,
  ChevronLeft,
  FolderOpen,
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
}: FileBrowserProps) {

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workspaceFiles.list(workspaceId, currentDir), showHidden],
    queryFn: () => workspaceFilesApi.list(companyId, workspaceId, currentDir, showHidden),
    retry: false,
  });

  const files = data?.files ?? [];

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
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => handleNavigate(entry)}
                  className="flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors rounded-sm"
                >
                  {entry.isDirectory ? (
                    <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
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
  /** When set, skip the browser and open the editor directly to this file. */
  initialFile?: string | null;
}

export function WorkspaceFileBrowser({
  companyId,
  workspaceId,
  onClose,
  onSaved,
  initialFile,
}: WorkspaceFileBrowserProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [browserDir, setBrowserDir] = useState(".");
  const [browserShowHidden, setBrowserShowHidden] = useState(false);
  // Track whether we opened directly to a file (no browser context to go back to)
  const openedDirectly = useRef(!!initialFile);

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

  // If we reach here, the browser is shown — user navigated back from editor
  openedDirectly.current = false;

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
    />
  );
}
