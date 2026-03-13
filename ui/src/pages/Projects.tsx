import { useEffect, useMemo, useState } from "react";
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
import { formatDate, projectUrl, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus, SlidersHorizontal } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const [showArchived, setShowArchived] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((p) => showArchived || !p.archivedAt),
    [projects, showArchived],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <div className="relative">
          <button
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
              filtersOpen || showArchived ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal className="h-3 w-3" />
            Filters
            {showArchived && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
          </button>
          {filtersOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                onClick={() => setShowArchived(!showArchived)}
              >
                <span className={cn(
                  "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                  showArchived && "bg-foreground"
                )}>
                  {showArchived && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                </span>
                Show archived
              </button>
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject}>
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

      {visibleProjects.length > 0 && (
        <div className="border border-border">
          {visibleProjects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {project.archivedAt && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Archived</span>
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

      {projects && projects.length > 0 && visibleProjects.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No projects match the selected filter.
        </p>
      )}
    </div>
  );
}
