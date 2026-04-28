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
import { Hexagon, Plus } from "lucide-react";

const PROJECT_STATUSES = [
  { key: "active", label: "Active" },
  { key: "in_progress", label: "In Progress" },
  { key: "backlog", label: "Backlog" },
  { key: "planned", label: "Planned" },
  { key: "paused", label: "Paused" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Canceled" },
] as const;

const HIDDEN_BY_DEFAULT = new Set(["completed", "cancelled"]);

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [visibleStatuses, setVisibleStatuses] = useState<Set<string>>(
    () => new Set(PROJECT_STATUSES.filter(({ key }) => !HIDDEN_BY_DEFAULT.has(key)).map(({ key }) => key))
  );

  const toggleStatus = (status: string) => {
    setVisibleStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of allProjects ?? []) {
      if (!p.archivedAt) {
        counts[p.status] = (counts[p.status] ?? 0) + 1;
      }
    }
    return counts;
  }, [allProjects]);

  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt && visibleStatuses.has(p.status)),
    [allProjects, visibleStatuses],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {PROJECT_STATUSES.map(({ key, label }) => {
            const count = statusCounts[key] ?? 0;
            const isActive = visibleStatuses.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleStatus(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {count > 0 && (
                  <span className={cn(
                    "text-[10px] tabular-nums",
                    isActive ? "text-accent-foreground/70" : "text-muted-foreground/60",
                  )}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={
            (allProjects ?? []).length > 0
              ? "No projects match the selected filters."
              : "No projects yet."
          }
          action={(allProjects ?? []).length === 0 ? "Add Project" : undefined}
          onAction={(allProjects ?? []).length === 0 ? openNewProject : undefined}
        />
      )}

      {projects.length > 0 && (
        <div className="border border-border">
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
