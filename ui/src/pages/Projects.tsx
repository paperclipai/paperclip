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
import { formatDate, projectUrl } from "../lib/utils";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus } from "lucide-react";
import type { ProjectStatus } from "@paperclipai/shared";

type ProjectFilter = "all" | ProjectStatus;

const FILTER_OPTIONS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
];

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [statusFilter, setStatusFilter] = useState<ProjectFilter>(() => {
    try {
      const saved = localStorage.getItem("projects:statusFilter");
      return (saved === "all" || saved === "backlog" || saved === "planned" || saved === "in_progress" || saved === "completed" || saved === "cancelled")
        ? (saved as ProjectFilter)
        : "all";
    } catch {
      return "all";
    }
  });

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

  const statusCounts = useMemo(() => {
    return {
      all: projects.length,
      backlog: projects.filter((p) => p.status === "backlog").length,
      planned: projects.filter((p) => p.status === "planned").length,
      in_progress: projects.filter((p) => p.status === "in_progress").length,
      completed: projects.filter((p) => p.status === "completed").length,
    };
  }, [projects]);

  const filteredProjects = useMemo(() => {
    if (statusFilter === "all") return projects;
    return projects.filter((p) => p.status === statusFilter);
  }, [projects, statusFilter]);

  const handleFilter = (filter: ProjectFilter) => {
    setStatusFilter(filter);
    try {
      localStorage.setItem("projects:statusFilter", filter);
    } catch {
      // ignore
    }
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {projects.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {FILTER_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => handleFilter(value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  statusFilter === value
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
                {label}
                <span className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  statusFilter === value ? "bg-background/20 text-background" : "bg-muted-foreground/20 text-muted-foreground",
                )}>
                  {statusCounts[value as keyof typeof statusCounts] ?? 0}
                </span>
              </button>
            ))}
          </div>
        ) : <div />}
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
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

      {projects.length > 0 && filteredProjects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={`No ${statusFilter === "all" ? "" : statusFilter.replace("_", " ")} projects.`}
        />
      )}

      {filteredProjects.length > 0 && (
        <div className="border border-border">
          {filteredProjects.map((project) => (
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
