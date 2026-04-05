import { useEffect, useMemo } from "react";
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
import { Button, Card } from "@heroui/react";
import { Hexagon, Plus } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-start">
        <Button size="sm" variant="primary" onPress={openNewProject}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <Card className="border-default-200/60">
          <Card.Content className="p-0">
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
          </Card.Content>
        </Card>
      )}
    </div>
  );
}
