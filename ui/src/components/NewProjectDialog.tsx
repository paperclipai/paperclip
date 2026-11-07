import { t, useTranslation } from "@/i18n";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Button } from "./ui/button";
import { ProjectRepositoryInput, repositoryOptionsKey } from "./ProjectRepositoryInput";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";

export function NewProjectDialog() {
  useTranslation("task-components");
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId && newProjectOpen
    ? <NewProjectForm key={selectedCompanyId} companyId={selectedCompanyId} onClose={closeNewProject} /> : null;
}

export function NewProjectForm({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  useTranslation("task-components");
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [color] = useState(() => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!);
  const [repos, setRepos] = useState<ProjectRepository[]>([]);
  const [connecting, setConnecting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: () => projectsApi.create(companyId, { name: name.trim(), color, status: "planned", repositoryIds: repos.map((repo) => repo.id) }),
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
        <DialogTitle className="sr-only">{t("task-components:connectGithub_4027e5b2")}</DialogTitle>
        <ConnectionSetupFlow host="dialog" serviceSlug="github" forceNewConnection onCancel={() => setConnecting(false)} onComplete={() => {
          void client.invalidateQueries({ queryKey: repositoryOptionsKey(companyId) });
          setConnecting(false);
        }} />
      </div> : <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !create.isPending) create.mutate(); }}>
        <div className="flex shrink-0 flex-col gap-4 px-5 pb-4 pt-5">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-lg font-semibold">{t("task-components:createProject_fa67e4d0")}</DialogTitle>
            <Button type="button" variant="ghost" size="icon-sm" disabled={create.isPending} aria-label={t("task-components:closeNewProject_7c518fef")} onClick={onClose}><X className="size-4" /></Button>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-input px-3 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <ProjectTile color={color} size="sm" />
            <input ref={input} aria-label={t("task-components:projectName_25498193")} value={name} disabled={create.isPending} onChange={(event) => setName(event.target.value)} placeholder={t("task-components:projectName_25498193")} required
              className="h-10 w-full min-w-0 border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm" />
          </div>
        </div>
        <div role="region" aria-label={t("task-components:sourceRepositories_b7936ec4")} tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
          <ProjectRepositoryInput companyId={companyId} selected={repos} onChange={setRepos} onConnect={() => setConnecting(true)} disabled={create.isPending} />
        </div>
        {create.status === "error" && <p role="alert" className="px-5 pt-3 text-sm text-destructive">{describeError(create.error).body}</p>}
        <div className="flex shrink-0 justify-end gap-2 px-5 py-5">
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>{t("task-components:cancel_19766ed6")}</Button>
          <Button type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? t("task-components:creating_c79ed949") : t("task-components:createProject_fa67e4d0")}</Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}
