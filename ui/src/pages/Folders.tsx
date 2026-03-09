import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { FolderOpen, Github, HardDrive, Star } from "lucide-react";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectUrl } from "../lib/utils";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

function deriveFolderName(folder: ProjectWorkspace): string {
  if (folder.name.trim().length > 0) return folder.name;

  if (folder.cwd && folder.cwd !== REPO_ONLY_CWD_SENTINEL) {
    const normalized = folder.cwd.replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "Folder";
  }

  if (folder.repoUrl) {
    try {
      const parsed = new URL(folder.repoUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "");
      return repo || "Repo";
    } catch {
      return "Repo";
    }
  }

  return "Folder";
}

function formatRepoLabel(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return repoUrl;
    return `${segments[0]}/${segments[1]!.replace(/\.git$/i, "")}`;
  } catch {
    return repoUrl;
  }
}

type FolderRecord = {
  project: Project;
  folder: ProjectWorkspace;
};

export function Folders() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Folders" }]);
  }, [setBreadcrumbs]);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const folders = useMemo<FolderRecord[]>(() => {
    return (projects ?? [])
      .flatMap((project) => (project.workspaces ?? []).map((folder) => ({ project, folder })))
      .sort((a, b) => {
        const projectCompare = a.project.name.localeCompare(b.project.name);
        if (projectCompare !== 0) return projectCompare;
        return deriveFolderName(a.folder).localeCompare(deriveFolderName(b.folder));
      });
  }, [projects]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FolderOpen} message="Select a system to view folders." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <section className="command-card rounded-[1.6rem] px-5 py-5 sm:px-6">
        <p className="section-kicker">Folder map</p>
        <h2 className="editorial-title mt-3 text-[2.3rem] leading-none text-foreground">Folders, local paths, and repo links</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          This is the cleanest place to see where projects actually live: local folders, GitHub repos, and which path is primary.
        </p>
      </section>

      {folders.length > 0 && (
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          {folders.length} folder{folders.length !== 1 ? "s" : ""} linked across {projects?.length ?? 0} project{projects?.length === 1 ? "" : "s"}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {projects && folders.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          message="No folders linked yet."
        />
      )}

      {folders.length > 0 && (
        <div className="page-frame overflow-hidden rounded-[1.3rem]">
          {folders.map(({ project, folder }) => {
            const hasLocalPath = Boolean(folder.cwd && folder.cwd !== REPO_ONLY_CWD_SENTINEL);
            const localPath = hasLocalPath ? folder.cwd : null;
            const repoLabel = folder.repoUrl ? formatRepoLabel(folder.repoUrl) : null;
            const subtitle = [project.name, localPath ?? repoLabel].filter(Boolean).join(" · ");

            return (
              <EntityRow
                key={folder.id}
                title={deriveFolderName(folder)}
                subtitle={subtitle}
                to={`${projectUrl(project)}/overview`}
                leading={<FolderOpen className="h-4 w-4 text-muted-foreground" />}
                trailing={
                  <div className="flex items-center gap-2">
                    {folder.isPrimary && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        <Star className="h-3 w-3" />
                        Primary
                      </span>
                    )}
                    {hasLocalPath && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        <HardDrive className="h-3 w-3" />
                        Local
                      </span>
                    )}
                    {repoLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        <Github className="h-3 w-3" />
                        Repo
                      </span>
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
