import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { Link } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Preserve manual URL editing for workspaces created before the GitHub picker. */
export function LegacyProjectRepository({ workspace, projectRef }: { workspace: ProjectWorkspace; projectRef: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const repoUrl = draft?.trim() || null;
      if (!repoUrl && !workspace.cwd && !workspace.remoteWorkspaceRef) return projectsApi.removeWorkspace(workspace.projectId, workspace.id);
      return projectsApi.updateWorkspace(workspace.projectId, workspace.id, { repoUrl });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(workspace.companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(workspace.projectId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(projectRef) });
      setDraft(null);
    },
  });
  return <div className="flex min-w-0 flex-col gap-2">
    <span className="text-xs text-muted-foreground">Existing repo URL</span>
    {draft === null ? <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <Link className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-all text-sm">{workspace.repoUrl}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(workspace.repoUrl ?? "")}>Edit</Button>
    </div> : <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(); }}>
      <Input aria-label="Existing repo URL" type="url" value={draft} disabled={save.isPending} onChange={(event) => setDraft(event.target.value)} />
      {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={save.isPending}>Save URL</Button></div>
    </form>}
  </div>;
}
