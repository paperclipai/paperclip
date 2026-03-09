import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a system to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <section className="command-card rounded-[1.6rem] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="section-kicker">Project ledger</p>
            <h2 className="editorial-title mt-3 text-[2.3rem] leading-none text-foreground">Projects and execution tracks</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Each project can carry multiple folders and linked repos. Keep the working surface compact and operational.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openNewProject} className="rounded-full">
            <Plus className="mr-1 h-4 w-4" />
            Add Project
          </Button>
        </div>
      </section>

      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          {projects?.length ?? 0} projects
        </p>
        <Button size="sm" variant="outline" onClick={openNewProject} className="rounded-full sm:hidden">
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {projects && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects && projects.length > 0 && (
        <div className="page-frame overflow-hidden rounded-[1.3rem]">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {(project.workspaces?.length ?? 0) > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {project.workspaces.length} folder{project.workspaces.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(project.targetDate)}
                    </span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
