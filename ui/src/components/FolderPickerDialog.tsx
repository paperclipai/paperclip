import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Folder,
  ChevronRight,
  Home,
  ArrowLeft,
  Eye,
  EyeOff,
  Loader2,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

async function browsePath(
  dirPath: string,
  showHidden: boolean,
): Promise<FsBrowseResult> {
  const params = new URLSearchParams({
    path: dirPath,
    showHidden: String(showHidden),
  });
  const res = await fetch(`/api/fs/browse?${params}`);
  if (!res.ok) {
    const { error } = await res
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new Error(error ?? "Failed to browse directory");
  }
  return res.json();
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: FolderPickerDialogProps) {
  const [current, setCurrent] = useState<FsBrowseResult | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    async (toPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await browsePath(toPath, showHidden);
        setCurrent(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to open folder");
      } finally {
        setLoading(false);
      }
    },
    [showHidden],
  );

  // Load initial path when dialog opens
  useEffect(() => {
    if (!open) return;
    navigate(initialPath || "~");
  }, [open, initialPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-browse when showHidden changes
  useEffect(() => {
    if (!open || !current) return;
    navigate(current.path);
  }, [showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleConfirm() {
    if (current?.path) {
      onSelect(current.path);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Choose a folder</DialogTitle>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            title="Go up"
            disabled={!current?.parent || loading}
            onClick={() => current?.parent && navigate(current.parent)}
            className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent/50 disabled:opacity-40 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Home directory"
            disabled={loading}
            onClick={() => navigate("~")}
            className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent/50 disabled:opacity-40 transition-colors"
          >
            <Home className="h-4 w-4" />
          </button>

          {/* Current path breadcrumb */}
          <div className="flex-1 overflow-x-auto scrollbar-none rounded-md border border-border bg-muted/30 px-2 py-1 text-xs font-mono text-muted-foreground whitespace-nowrap">
            {current?.path ?? "…"}
          </div>

          <button
            type="button"
            title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            onClick={() => setShowHidden((v) => !v)}
            className={cn(
              "inline-flex items-center justify-center rounded p-1 transition-colors",
              showHidden
                ? "text-foreground bg-accent"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {showHidden ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Directory listing */}
        <div className="h-64 overflow-y-auto scrollbar-none rounded-md border border-border">
          {loading && (
            <div className="flex items-center justify-center h-full py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {error && !loading && (
            <div className="flex items-center justify-center h-full py-8 text-sm text-destructive px-4 text-center">
              {error}
            </div>
          )}

          {!loading && !error && current && (
            <div className="py-1">
              {current.entries.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Empty folder
                </p>
              )}
              {current.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    if (entry.isDirectory) navigate(entry.path);
                  }}
                  disabled={!entry.isDirectory}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors",
                    entry.isDirectory
                      ? "hover:bg-accent/50 cursor-pointer"
                      : "opacity-40 cursor-default",
                  )}
                >
                  {entry.isDirectory ? (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate text-left">{entry.name}</span>
                  {entry.isDirectory && (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!current?.path} onClick={handleConfirm}>
            Select this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
