import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Hexagon, Plus, Archive, ArchiveRestore } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: projects, isLoading, error } = useQuery({
    queryKey: showArchived
      ? queryKeys.projects.listWithArchived(selectedCompanyId!)
      : queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!, showArchived ? { includeArchived: true } : undefined),
    enabled: !!selectedCompanyId,
  });

  const archiveProject = useMutation({
    mutationFn: (projectId: string) => projectsApi.archive(projectId),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.listWithArchived(selectedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Failed to archive project",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const unarchiveProject = useMutation({
    mutationFn: (projectId: string) => projectsApi.unarchive(projectId),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.listWithArchived(selectedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Failed to unarchive project",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const handleArchive = (projectId: string, projectName: string) => {
    const confirmed = window.confirm(`Archive project "${projectName}"? It will be hidden from the default list.`);
    if (!confirmed) return;
    archiveProject.mutate(projectId);
  };

  const handleUnarchive = (projectId: string) => {
    unarchiveProject.mutate(projectId);
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
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(checked) => setShowArchived(checked === true)}
          />
          <span className="text-xs text-muted-foreground">Show archived</span>
        </label>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {projects && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={showArchived ? "No projects yet." : "No active projects."}
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects && projects.length > 0 && (
        <div className="border border-border">
          {projects.map((project) => {
            const isArchived = Boolean(project.archivedAt);
            return (
              <EntityRow
                key={project.id}
                title={project.name}
                subtitle={project.description ?? undefined}
                to={projectUrl(project)}
                className={isArchived ? "opacity-50" : undefined}
                trailing={
                  <div className="flex items-center gap-3">
                    {isArchived ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleUnarchive(project.id);
                        }}
                        title="Unarchive project"
                        disabled={unarchiveProject.isPending}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleArchive(project.id, project.name);
                        }}
                        title="Archive project"
                        disabled={archiveProject.isPending}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {project.targetDate && (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(project.targetDate)}
                      </span>
                    )}
                    {isArchived ? (
                      <StatusBadge status="archived" />
                    ) : (
                      <StatusBadge status={project.status} />
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
