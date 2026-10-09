import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatExecutionDefaults as Defaults, TaskWorkspaceSelection } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";

function selectionKey(value: TaskWorkspaceSelection | null | undefined): string {
  if (value === undefined) return "inherit";
  if (value === null) return "clear";
  if (value.kind === "task_directory") return "task";
  if (value.kind === "existing") return `existing:${value.workspaceId}`;
  return `source:${value.projectWorkspaceId}:${value.mode}`;
}

/** The same optional editor is used by the connection and individual destinations. */
export function ChatExecutionDefaults({ companyId, value, resource = false, onSave }: {
  companyId: string;
  value: Defaults | null | undefined;
  resource?: boolean;
  onSave: (defaults: Defaults | null) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Defaults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });
  const workspaces = useQuery({
    queryKey: ["channel-workspace-choices", companyId],
    queryFn: () => executionWorkspacesApi.listSummaries(companyId, { status: "active" }),
  });
  const current = draft ?? value ?? {};
  const projectValue = current.projectId === undefined ? "inherit" : current.projectId ?? "none";
  const workspaceValue = selectionKey(current.workspace);
  const choices = new Map<string, TaskWorkspaceSelection>();
  choices.set("task", { kind: "task_directory" });
  for (const project of projects.data ?? []) {
    for (const source of project.workspaces ?? []) {
      for (const mode of ["managed_isolated", "shared"] as const) {
        choices.set(`source:${source.id}:${mode}`, { kind: "configured_source", projectWorkspaceId: source.id, mode });
      }
    }
  }
  for (const workspace of workspaces.data ?? []) {
    choices.set(`existing:${workspace.id}`, { kind: "existing", workspaceId: workspace.id });
  }
  const dirty = JSON.stringify(current) !== JSON.stringify(value ?? {});
  const change = (next: Defaults) => { setDraft(next); setSaved(false); setError(null); };
  return <form className="space-y-3" aria-labelledby={`${id}-title`} onSubmit={async (event) => {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true); setError(null); setSaved(false);
    try { await onSave(Object.keys(current).length ? current : null); setDraft(null); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t save task defaults. Try again."); }
    finally { setPending(false); }
  }}>
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-sm font-semibold">Task defaults</h3>
      <p className="text-sm text-muted-foreground">Applies to new conversations. Existing tasks keep their files and project.</p>
    </div>
    {(projects.isError || workspaces.isError) && <p role="alert" className="text-sm text-destructive">Couldn’t load available projects or workspaces. <button type="button" className="underline" onClick={() => { void projects.refetch(); void workspaces.refetch(); }}>Try again</button></p>}
    <div className="space-y-2">
      <label htmlFor={`${id}-project`} className="text-sm font-medium">Project</label>
      <NativeSelect id={`${id}-project`} value={projectValue} disabled={pending || projects.isPending} onChange={(event) => {
        const { projectId: _previous, ...rest } = current;
        change(event.target.value === "inherit" ? rest : { ...rest, projectId: event.target.value === "none" ? null : event.target.value });
      }}>
        <option value="inherit">{resource ? "Use connection defaults" : "Use task defaults"}</option>
        <option value="none">No project</option>
        {current.projectId && !projects.data?.some((project) => project.id === current.projectId) && <option value={current.projectId}>Saved project (unavailable)</option>}
        {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </NativeSelect>
    </div>
    <div className="space-y-2">
      <label htmlFor={`${id}-workspace`} className="text-sm font-medium">Workspace</label>
      <NativeSelect id={`${id}-workspace`} value={workspaceValue} disabled={pending || projects.isPending || workspaces.isPending} onChange={(event) => {
        const key = event.target.value;
        const { workspace: _previous, ...rest } = current;
        if (key === "inherit") change(rest);
        else if (key === "clear") change({ ...rest, workspace: null });
        else { const workspace = choices.get(key); if (workspace) change({ ...rest, workspace }); }
      }}>
        <option value="inherit">{resource ? "Use connection defaults" : "Use project or task defaults"}</option>
        {resource && <option value="clear">Use project or task defaults</option>}
        {!resource && workspaceValue === "clear" && <option value="clear">Use project or task defaults</option>}
        <option value="task">Task files — separate folder</option>
        {current.workspace && !choices.has(workspaceValue) && <option value={workspaceValue}>Saved workspace (unavailable)</option>}
        {(projects.data ?? []).filter((project) => project.workspaces?.length).map((project) => <optgroup key={project.id} label={project.name}>
          {project.workspaces.flatMap((source) => [
            <option key={`${source.id}:isolated`} value={`source:${source.id}:managed_isolated`}>{source.name} — isolated checkout</option>,
            <option key={`${source.id}:shared`} value={`source:${source.id}:shared`}>{source.name} — shared folder</option>,
          ])}
        </optgroup>)}
        {(workspaces.data?.length ?? 0) > 0 && <optgroup label="Existing workspaces">{workspaces.data!.map((workspace) => <option key={workspace.id} value={`existing:${workspace.id}`}>{workspace.name}</option>)}</optgroup>}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">Project and workspace access is checked for each task. A shared folder must also be allowed by the agent’s execution policy.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-3">
      <div>{dirty ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); }}>Cancel</Button> : saved ? <span role="status" className="text-sm text-muted-foreground">Saved for new tasks.</span> : null}</div>
      <Button type="submit" disabled={!dirty || pending}>{pending ? "Saving…" : "Save defaults"}</Button>
    </div>
  </form>;
}
