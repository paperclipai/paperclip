import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorPlay } from "lucide-react";
import { Link } from "@/lib/router";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  buildWorkspaceRuntimeControlSections,
  getRunningRuntimeServiceUrl,
  WorkspaceRuntimeControls,
  type WorkspaceRuntimeControlRequest,
} from "../components/WorkspaceRuntimeControls";
import { RuntimePreviewFrame } from "../components/RuntimePreviewFrame";

/**
 * On-demand gallery of every project workspace that declares a runtime service.
 * Reuses the projects list (workspaces already carry runtimeServices), the shared
 * start/stop control bar, and the preview iframe. Nothing runs until Start is
 * pressed; each card shows its live app inline once the service is up.
 */
export function Previews() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Previews" }]);
  }, [setBreadcrumbs]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const control = useMutation({
    mutationFn: (vars: { projectId: string; workspaceId: string; request: WorkspaceRuntimeControlRequest }) =>
      projectsApi.controlWorkspaceCommands(
        vars.projectId,
        vars.workspaceId,
        vars.request.action,
        selectedCompanyId ?? undefined,
        vars.request,
      ),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      }
    },
  });

  const targets = useMemo(() => {
    const out: Array<{
      projectId: string;
      projectName: string;
      workspaceId: string;
      cwd: string | null;
      sections: ReturnType<typeof buildWorkspaceRuntimeControlSections>;
    }> = [];
    for (const project of projectsQuery.data ?? []) {
      for (const workspace of project.workspaces ?? []) {
        const sections = buildWorkspaceRuntimeControlSections({
          runtimeConfig: workspace.runtimeConfig?.workspaceRuntime ?? null,
          runtimeServices: workspace.runtimeServices ?? [],
          canStartServices: Boolean(workspace.runtimeConfig?.workspaceRuntime) && Boolean(workspace.cwd),
        });
        if (sections.services.length === 0 && sections.otherServices.length === 0) continue;
        out.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          cwd: workspace.cwd ?? null,
          sections,
        });
      }
    }
    return out;
  }, [projectsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={MonitorPlay} message="Select a company to view app previews." />;
  }
  if (projectsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }
  if (projectsQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {projectsQuery.error instanceof Error ? projectsQuery.error.message : "Failed to load previews"}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">App previews</h1>
        <p className="text-sm text-muted-foreground">
          Start a project's dev server on demand and watch it render live. Nothing runs until you press Start; stopping a
          service frees its port.
        </p>
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon={MonitorPlay}
          message="No project workspace declares a preview service yet."
          description="Declare a service under a workspace's runtime config to see it here."
        />
      ) : (
        <div className="grid gap-4">
          {targets.map((target) => {
            const url = getRunningRuntimeServiceUrl(target.sections);
            const pending = control.isPending && control.variables?.workspaceId === target.workspaceId;
            return (
              <Card key={target.workspaceId} className="block p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold">{target.projectName}</h2>
                    {target.cwd ? <p className="text-xs text-muted-foreground">{target.cwd}</p> : null}
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/projects/${target.projectId}/workspaces/${target.workspaceId}`}>Manage</Link>
                  </Button>
                </div>
                <WorkspaceRuntimeControls
                  className="mt-4"
                  sections={target.sections}
                  isPending={pending}
                  pendingRequest={pending ? control.variables?.request ?? null : null}
                  serviceEmptyMessage="No services have been started for this workspace yet."
                  jobEmptyMessage="No one-shot jobs are configured for this workspace yet."
                  onAction={(request) =>
                    control.mutate({ projectId: target.projectId, workspaceId: target.workspaceId, request })
                  }
                />
                {url ? <RuntimePreviewFrame className="mt-4" url={url} title={target.projectName} /> : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
