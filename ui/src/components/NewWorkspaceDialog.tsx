import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, Github, Plus, X } from "lucide-react";
import { cn } from "../lib/utils";

interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  companyId: string;
  primaryWorkspaceId?: string | null;
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  projectId,
  companyId,
  primaryWorkspaceId,
}: NewWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"local" | "repo" | null>(null);
  const [cwd, setCwd] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.createWorkspace(projectId, data, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setName("");
    setMode(null);
    setCwd("");
    setRepoUrl("");
    setError(null);
  }

  function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (mode === "local") {
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd || !trimmedCwd.startsWith("/")) {
        setError("Local folder must be a full absolute path.");
        return;
      }
      createWorkspace.mutate({
        name: trimmedName,
        cwd: trimmedCwd,
        isPrimary: false,
      });
    } else if (mode === "repo") {
      const trimmedRepo = repoUrl.trim();
      if (!trimmedRepo || !trimmedRepo.startsWith("http")) {
        setError("Repo URL must be a valid URL.");
        return;
      }
      createWorkspace.mutate({
        name: trimmedName,
        repoUrl: trimmedRepo,
        isPrimary: false,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) { reset(); onOpenChange(false); } }}>
      <DialogContent className="p-0 gap-0 sm:max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Plus className="h-3.5 w-3.5" />
            <span>Add workspace</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); onOpenChange(false); }}
          >
            <X className="text-lg leading-none" />
          </Button>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Workspace name (e.g. web, mobile)"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            autoFocus
          />
        </div>

        {/* Mode selection */}
        <div className="px-4 pb-2 space-y-4">
          {!mode ? (
            <div className="grid grid-cols-2 gap-3">
              <button
                className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors text-left"
                onClick={() => setMode("local")}
              >
                <FolderOpen className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">Local folder</div>
                  <div className="text-xs text-muted-foreground">Absolute path on disk</div>
                </div>
              </button>
              <button
                className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors text-left"
                onClick={() => setMode("repo")}
              >
                <Github className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">Git repo</div>
                  <div className="text-xs text-muted-foreground">Clone from remote URL</div>
                </div>
              </button>
            </div>
          ) : (
            <>
              {/* Local folder input */}
              {mode === "local" && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Local folder path</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-ring placeholder:text-muted-foreground/50"
                    placeholder="/absolute/path/to/workspace"
                    value={cwd}
                    onChange={(e) => { setCwd(e.target.value); setError(null); }}
                  />
                </div>
              )}

              {/* Repo URL input */}
              {mode === "repo" && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Git remote URL</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-ring placeholder:text-muted-foreground/50"
                    placeholder="https://github.com/org/repo.git"
                    value={repoUrl}
                    onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
                  />
                </div>
              )}

              {/* Change mode / Cancel buttons */}
              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-xs text-muted-foreground"
                  onClick={() => { setMode(null); setError(null); }}
                >
                  Change type
                </Button>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to create workspace.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { reset(); onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              !name.trim() ||
              createWorkspace.isPending ||
              (mode === "local" && !cwd.trim()) ||
              (mode === "repo" && !repoUrl.trim())
            }
            onClick={handleSubmit}
          >
            {createWorkspace.isPending ? "Creating…" : primaryWorkspaceId ? "Add workspace" : "Create workspace"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
