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
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-5">
      <section className="paperclip-work-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <p className="paperclip-work-kicker">Execution Map</p>
            <div className="space-y-2">
              <h1 className="paperclip-work-title">Projects</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Track the delivery lanes carrying roadmap work from planning into execution.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Total</p>
              <p className="mt-2 text-2xl font-semibold">{projects?.length ?? 0}</p>
            </div>
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Active</p>
              <p className="mt-2 text-2xl font-semibold">
                {projects?.filter((project) => project.status === "in_progress").length ?? 0}
              </p>
            </div>
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Planned</p>
              <p className="mt-2 text-2xl font-semibold">
                {projects?.filter((project) => project.status === "planned" || project.status === "backlog").length ?? 0}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="mr-1 h-4 w-4" />
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
        <div className="paperclip-work-list">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
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
