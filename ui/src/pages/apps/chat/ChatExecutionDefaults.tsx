import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useEffect, useId, useState } from "react";
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

export function ChatExecutionDefaults({ companyId, value, resource = false, onSave }: {
  companyId: string;
  value: Defaults | null | undefined;
  resource?: boolean;
  onSave: (defaults: Defaults | null) => Promise<void>;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const [draft, setDraft] = useState<Defaults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ raw: string } | { fallback: true } | null>(null);
  const [savedFrom, setSavedFrom] = useState<string | null>(null);
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });
  const workspaces = useQuery({
    queryKey: ["channel-workspace-choices", companyId],
    queryFn: () => executionWorkspacesApi.listSummaries(companyId, { selectableForTask: true }),
  });
  const current = draft ?? value ?? {};
  const valueKey = JSON.stringify(value ?? {});
  const saved = savedFrom !== null;
  // Keep the accepted selections until the parent publishes refreshed defaults.
  useEffect(() => {
    if (savedFrom !== null && savedFrom !== valueKey) setDraft(null);
  }, [savedFrom, valueKey]);
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
  const dirty = !saved && JSON.stringify(current) !== valueKey;
  const change = (next: Defaults) => { setDraft(next); setSavedFrom(null); setError(null); };
  return <form className="space-y-3" aria-labelledby={`${id}-title`} onSubmit={async (event) => {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true); setError(null); setSavedFrom(null);
    try { await onSave(Object.keys(current).length ? current : null); setSavedFrom(valueKey); }
    catch (cause) { setError(cause instanceof Error ? { raw: cause.message } : { fallback: true }); }
    finally { setPending(false); }
  }}>
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-sm font-semibold">{t("task_defaults_e0ead87")}</h3>
      <p className="text-sm text-muted-foreground">{t("applies_to_new_conversations_existing_tasks_keep_f5b341e")}</p>
    </div>
    {(projects.isError || workspaces.isError) && <p role="alert" className="text-sm text-destructive">{t("couldn_t_load_available_projects_or_workspaces_102c754")}<button type="button" className="underline" onClick={() => { void projects.refetch(); void workspaces.refetch(); }}>{t("try_again_042c862")}</button></p>}
    <div className="space-y-2">
      <label htmlFor={`${id}-project`} className="text-sm font-medium">{t("project_f6f4da8")}</label>
      <NativeSelect id={`${id}-project`} value={projectValue} disabled={pending || projects.isPending} onChange={(event) => {
        const { projectId: _previous, ...rest } = current;
        change(event.target.value === "inherit" ? rest : { ...rest, projectId: event.target.value === "none" ? null : event.target.value });
      }}>
        <option value="inherit">{resource ? t("use_connection_defaults_6c89879") : t("use_task_defaults_06ef17e")}</option>
        <option value="none">{t("no_project_c326b75")}</option>
        {current.projectId && !projects.data?.some((project) => project.id === current.projectId) && <option value={current.projectId}>{t("saved_project_unavailable_df40906")}</option>}
        {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </NativeSelect>
    </div>
    <div className="space-y-2">
      <label htmlFor={`${id}-workspace`} className="text-sm font-medium">{t("workspace_4ca0a75")}</label>
      <NativeSelect id={`${id}-workspace`} value={workspaceValue} disabled={pending || projects.isPending || workspaces.isPending} onChange={(event) => {
        const key = event.target.value;
        const { workspace: _previous, ...rest } = current;
        if (key === "inherit") change(rest);
        else if (key === "clear") change({ ...rest, workspace: null });
        else { const workspace = choices.get(key); if (workspace) change({ ...rest, workspace }); }
      }}>
        <option value="inherit">{resource ? t("use_connection_defaults_6c89879") : t("use_project_or_task_defaults_ddf6d99")}</option>
        {resource && <option value="clear">{t("use_project_or_task_defaults_ddf6d99")}</option>}
        {!resource && workspaceValue === "clear" && <option value="clear">{t("use_project_or_task_defaults_ddf6d99")}</option>}
        <option value="task">{t("task_files_separate_folder_6de11be")}</option>
        {current.workspace && !choices.has(workspaceValue) && <option value={workspaceValue}>{t("saved_workspace_unavailable_a26fa3d")}</option>}
        {(projects.data ?? []).filter((project) => project.workspaces?.length).map((project) => <optgroup key={project.id} label={project.name}>
          {project.workspaces.flatMap((source) => [
            <option key={`${source.id}:isolated`} value={`source:${source.id}:managed_isolated`}>{t("isolated_checkout_9951f40", { name: source.name })}</option>,
            <option key={`${source.id}:shared`} value={`source:${source.id}:shared`}>{t("shared_folder_5a8b4e6", { name: source.name })}</option>,
          ])}
        </optgroup>)}
        {(workspaces.data?.length ?? 0) > 0 && <optgroup label={t("existing_workspaces_95fbd6d")}>{workspaces.data!.map((workspace) => <option key={workspace.id} value={`existing:${workspace.id}`}>{workspace.name}</option>)}</optgroup>}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t("project_and_workspace_access_is_checked_for_7ecbc39")}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{"raw" in error ? error.raw : finalPagesT("final-pages:Couldn_t_save_task_defaults_Try_again_590d88")}</p>}
    <div className="flex items-center justify-between gap-3">
      <div>{dirty ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); }}>{t("cancel_77dfd21")}</Button> : saved ? <span role="status" className="text-sm text-muted-foreground">{t("saved_for_new_tasks_25fe0b8")}</span> : null}</div>
      <Button type="submit" disabled={!dirty || pending}>{pending ? t("saving_56a2285") : t("save_defaults_90df04c")}</Button>
    </div>
  </form>;
}
