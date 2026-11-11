import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, type ProjectRepository } from "@paperclipai/shared";
import { X } from "lucide-react";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi } from "../api/projects";
import { describeError } from "../api/errors";
import { queryKeys } from "../lib/queryKeys";
import { trackRecentProject } from "../lib/recent-projects";
import { ProjectTile } from "./ProjectTile";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { QueryErrorState, useQueryView } from "./QueryView";
import { NativeSelect } from "./ui/select";
import { Button } from "./ui/button";
import { ProjectRepositoryInput, repositoryOptionsKey } from "./ProjectRepositoryInput";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId && newProjectOpen
    ? <NewProjectForm key={selectedCompanyId} companyId={selectedCompanyId} onClose={closeNewProject} /> : null;
}

export function NewProjectForm({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [color] = useState(() => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!);
  const [repos, setRepos] = useState<ProjectRepository[]>([]);
  const [connecting, setConnecting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const environments = useQuery({ queryKey: queryKeys.projects.environments(companyId), queryFn: () => projectsApi.environmentOptions(companyId), gcTime: 0 });
  const environmentView = useQueryView(environments);
  const options = environmentView.data;
  const environmentId = selectedEnvironmentId ?? options?.defaultEnvironmentId;
  const selectedGroup = options?.groups.find(group => group.environments.some(environment => environment.id === environmentId));
  const environmentReady = Boolean(environmentView.kind !== "error" && options && (!options.error || selectedGroup) && (!options.groups.length || selectedGroup));

  const create = useMutation({
    mutationFn: () => projectsApi.create(companyId, { name: name.trim(), color, status: "planned", repositoryIds: repos.map((repo) => repo.id), ...(selectedGroup ? { environmentId, expectedStorageProviderPluginId: selectedGroup.storageProviderPluginId } : {}) }),
    onSuccess: (project) => {
      trackRecentProject(project.id, companyId);
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      onClose();
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open && !create.isPending) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 shadow-sm sm:max-w-lg"
      onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}>
      {connecting ? <div className="min-h-0 overflow-y-auto p-5">
        <DialogTitle className="sr-only">Connect GitHub</DialogTitle>
        <ConnectionSetupFlow host="dialog" serviceSlug="github" forceNewConnection onCancel={() => setConnecting(false)} onComplete={() => {
          void client.invalidateQueries({ queryKey: repositoryOptionsKey(companyId) });
          setConnecting(false);
        }} />
      </div> : <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={(event) => { event.preventDefault(); if (name.trim() && environmentReady && !create.isPending) create.mutate(); }}>
        <div className="flex shrink-0 flex-col gap-4 px-5 pb-4 pt-5">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-lg font-semibold">Create project</DialogTitle>
            <Button type="button" variant="ghost" size="icon-sm" disabled={create.isPending} aria-label="Close new project" onClick={onClose}><X className="size-4" /></Button>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-input px-3 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <ProjectTile color={color} size="sm" />
            <input ref={input} aria-label="Project name" value={name} disabled={create.isPending} onChange={(event) => setName(event.target.value)} placeholder="Project name" required
              className="h-10 w-full min-w-0 border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm" />
          </div>
        </div>
        <div role="region" aria-label="Source repositories" tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
          {options && (options.groups.length > 1 || (options.error && options.groups.length > 0)) && <div className="mb-4 space-y-2">
            <label htmlFor="project-environment" className="text-sm font-medium">Available in</label>
            <NativeSelect id="project-environment" value={selectedGroup?.environments[0].id ?? ""} disabled={create.isPending}
              onChange={event => setSelectedEnvironmentId(event.target.value)}>
              {!selectedGroup && <option value="" disabled>Select environments</option>}
              {options.groups.map(group => <option key={group.environments[0].id} value={group.environments[0].id}>
                {group.environments.map(environment => environment.name).join(", ")}
              </option>)}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">These environments can share this project's working files. The storage choice stays with the project.</p>
          </div>}
          {(environmentView.kind === "loading" || environmentView.kind === "reconnecting") && <p role="status" className="mb-3 text-sm text-muted-foreground">Loading environments…</p>}
          {environmentView.kind === "error" && <QueryErrorState error={environmentView.error} size="inline" action="load project environments"
            className="mb-3" onRetry={environmentView.retry} retrying={environmentView.isFetching} />}
          {options?.error && !selectedGroup && <p role="alert" className="mb-3 text-sm text-destructive">{options.error}</p>}
          <ProjectRepositoryInput companyId={companyId} selected={repos} onChange={setRepos} onConnect={() => setConnecting(true)} disabled={create.isPending} />
        </div>
        {create.status === "error" && <p role="alert" className="px-5 pt-3 text-sm text-destructive">{describeError(create.error).body}</p>}
        <div className="flex shrink-0 justify-between gap-2 px-5 py-5">
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name.trim() || !environmentReady || create.isPending}>{create.isPending ? "Creating…" : "Create project"}</Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}
