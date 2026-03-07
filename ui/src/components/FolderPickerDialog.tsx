import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderOpen, Loader2, ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fsApi } from "../api/fs";
import { cn } from "../lib/utils";

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: FolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
  const [showHidden, setShowHidden] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["fs-browse", currentPath ?? "__home__", showHidden],
    queryFn: () => fsApi.browse(currentPath, showHidden),
    enabled: open,
    staleTime: 10_000,
  });

  function handleSelect() {
    if (data?.path) {
      onSelect(data.path);
      onOpenChange(false);
    }
  }

  function handleNavigate(path: string) {
    setCurrentPath(path);
  }

  function handleBack() {
    if (data?.parent) {
      setCurrentPath(data.parent);
    }
  }

  // Reset to initial when dialog opens/closes
  function handleOpenChange(next: boolean) {
    if (!next) {
      setCurrentPath(initialPath);
      setShowHidden(false);
    }
    onOpenChange(next);
  }

  const pathSegments = (data?.path ?? "").split("/").filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-sm font-medium">Choose a folder</DialogTitle>
        </DialogHeader>

        {/* Breadcrumb */}
        <div className="px-4 pb-2 flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto whitespace-nowrap">
          <button
            className="hover:text-foreground transition-colors shrink-0"
            onClick={() => setCurrentPath("/")}
          >
            /
          </button>
          {pathSegments.map((seg, i) => {
            const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
            return (
              <span key={segPath} className="flex items-center gap-1 shrink-0">
                <ChevronRight className="h-3 w-3" />
                <button
                  className={cn(
                    "hover:text-foreground transition-colors",
                    i === pathSegments.length - 1 && "text-foreground font-medium",
                  )}
                  onClick={() => setCurrentPath(segPath)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        {/* Directory listing */}
        <div className="border-t border-border mx-4" />
        <div className="mx-4 my-2 h-56 overflow-y-auto rounded-md border border-border">
          {isLoading && (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          )}
          {isError && (
            <div className="flex items-center justify-center h-full text-destructive text-xs px-4 text-center">
              Could not read directory. Check that the path exists and is accessible.
            </div>
          )}
          {!isLoading && !isError && data && (
            <>
              {data.parent && (
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-accent/50 transition-colors text-muted-foreground border-b border-border"
                  onClick={handleBack}
                >
                  <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">..</span>
                </button>
              )}
              {data.entries.length === 0 && (
                <div className="flex items-center justify-center h-full text-muted-foreground text-xs py-8">
                  No subdirectories
                </div>
              )}
              {data.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-accent/50 transition-colors"
                  onClick={() => handleNavigate(entry.path)}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                  <ChevronRight className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
                </button>
              ))}
            </>
          )}
        </div>

        {/* Current selection + actions */}
        <div className="px-4 pb-4 pt-2 space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-mono text-muted-foreground min-h-[28px]">
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{data?.path ?? "Loading…"}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <Checkbox
                id="show-hidden"
                checked={showHidden}
                onCheckedChange={(checked) => setShowHidden(checked === true)}
              />
              Show hidden folders
            </label>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!data?.path} onClick={handleSelect}>
                Select this folder
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
