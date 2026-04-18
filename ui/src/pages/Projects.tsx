import { useEffect, useMemo, useCallback, useState } from "react";
import { useSearchParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { departmentsApi } from "../api/departments";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Hexagon, Plus } from "lucide-react";

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const [departmentId, setDepartmentId] = useState<string | undefined>(searchParams.get("departmentId") ?? undefined);

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const handleDepartmentChange = useCallback((nextDepartmentId: string) => {
    setDepartmentId(nextDepartmentId === "__all__" ? undefined : nextDepartmentId);
    const url = new URL(window.location.href);
    if (nextDepartmentId === "__all__") {
      url.searchParams.delete("departmentId");
    } else {
      url.searchParams.set("departmentId", nextDepartmentId);
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  useEffect(() => {
    setDepartmentId(searchParams.get("departmentId") ?? undefined);
  }, [searchParams]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.list(selectedCompanyId!), "department", departmentId ?? "__all__"],
    queryFn: () => projectsApi.list(selectedCompanyId!, { departmentId }),
    enabled: !!selectedCompanyId,
  });
  const { data: departments = [] } = useQuery({
    queryKey: queryKeys.departments.list(selectedCompanyId!),
    queryFn: () => departmentsApi.list(selectedCompanyId!),
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
      <div className="flex items-center justify-end">
        <Select value={departmentId ?? "__all__"} onValueChange={handleDepartmentChange}>
          <SelectTrigger className="mr-2 w-full max-w-xs">
            <SelectValue placeholder="All accessible departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All accessible departments</SelectItem>
            {departments.map((department) => (
              <SelectItem key={department.id} value={department.id}>
                {department.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => openNewProject({ departmentId })}>
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
          onAction={() => openNewProject({ departmentId })}
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
