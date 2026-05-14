import { useState, useEffect, useCallback } from "react";
import { workspaceApi, type WorkspaceBrowseResult } from "../api/workspace";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ArrowUp,
  Home,
  Loader2,
  FolderGit2,
} from "lucide-react";

interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}

export function FolderPicker({ open, onOpenChange, onSelect }: FolderPickerProps) {
  const [browseResult, setBrowseResult] = useState<WorkspaceBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    try {
      const result = await workspaceApi.browse(path);
      setBrowseResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !browseResult) {
      browse();
    }
  }, [open, browseResult, browse]);

  function handleNavigate(dir: string) {
    const target = browseResult ? `${browseResult.path}/${dir}` : dir;
    browse(target);
  }

  function handleUp() {
    if (browseResult?.parent) {
      browse(browseResult.parent);
    }
  }

  function handleHome() {
    browse("~");
  }

  function handleSelect() {
    if (!browseResult) return;
    const path = selectedEntry
      ? `${browseResult.path}/${selectedEntry}`
      : browseResult.path;
    onSelect(path);
    onOpenChange(false);
  }

  function handleDoubleClick(dir: string) {
    handleNavigate(dir);
  }

  const pathSegments = browseResult?.path.split("/").filter(Boolean) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Select project folder</DialogTitle>
        </DialogHeader>

        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-0.5 px-1 py-1.5 border border-border rounded-md overflow-x-auto text-xs min-h-[32px]">
          <button
            onClick={handleHome}
            className="shrink-0 p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            title="Home"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          {browseResult?.parent && (
            <button
              onClick={handleUp}
              className="shrink-0 p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
              title="Up"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
          <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
          {pathSegments.map((segment, i) => (
            <span key={i} className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => browse("/" + pathSegments.slice(0, i + 1).join("/"))}
                className={cn(
                  "px-1 py-0.5 rounded hover:bg-accent/50 transition-colors truncate max-w-[120px]",
                  i === pathSegments.length - 1
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                )}
              >
                {segment}
              </button>
              {i < pathSegments.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
              )}
            </span>
          ))}
        </div>

        {/* Directory listing */}
        <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto max-h-[350px]">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-xs">Loading...</span>
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-xs text-destructive text-center">{error}</div>
          )}

          {!loading && !error && browseResult && browseResult.entries.length === 0 && (
            <div className="px-3 py-8 text-xs text-muted-foreground text-center">
              No subdirectories
            </div>
          )}

          {!loading && !error && browseResult && browseResult.entries.map((entry) => (
            <button
              key={entry}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left transition-colors",
                selectedEntry === entry
                  ? "bg-accent text-foreground"
                  : "hover:bg-accent/50"
              )}
              onClick={() => setSelectedEntry(selectedEntry === entry ? null : entry)}
              onDoubleClick={() => handleDoubleClick(entry)}
            >
              <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{entry}</span>
            </button>
          ))}
        </div>

        {/* Current selection indicator */}
        {browseResult && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            {browseResult.isProject ? (
              <FolderGit2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate font-mono">
              {selectedEntry
                ? `${browseResult.path}/${selectedEntry}`
                : browseResult.path}
            </span>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!browseResult}
            onClick={handleSelect}
          >
            {selectedEntry ? "Select folder" : "Select current folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
