import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import type { ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";
import { ProjectWorkspaceSummaryCard } from "./ProjectWorkspaceSummaryCard";

export function ProjectWorkspacesContent({
  companyId,
  projectId,
  projectRef,
  summaries,
}: {
  companyId: string;
  projectId: string;
  projectRef: string;
  summaries: ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [runtimeActionKey, setRuntimeActionKey] = useState<string | null>(null);
  const [closingWorkspace, setClosingWorkspace] = useState<{
    id: string;
    name: string;
    status: ExecutionWorkspace["status"];
  } | null>(null);
  const controlWorkspaceRuntime = useMutation({
    mutationFn: async (input: {
      key: string;
      kind: "project_workspace" | "execution_workspace";
      workspaceId: string;
      action: "start" | "stop" | "restart";
    }) => {
      setRuntimeActionKey(`${input.key}:${input.action}`);
      if (input.kind === "project_workspace") {
        return await projectsApi.controlWorkspaceRuntimeServices(projectId, input.workspaceId, input.action, companyId);
      }
      return await executionWorkspacesApi.controlRuntimeServices(input.workspaceId, input.action);
    },
    onSettled: () => {
      setRuntimeActionKey(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId, { projectId }) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
    },
  });

  if (summaries.length === 0) {
    return <p className="text-sm text-muted-foreground">No non-default workspace activity yet.</p>;
  }

  const activeSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus !== "cleanup_failed");
  const cleanupFailedSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus === "cleanup_failed");

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-3">
          {activeSummaries.map((summary) => (
            <ProjectWorkspaceSummaryCard
              key={summary.key}
              projectRef={projectRef}
              summary={summary}
              runtimeActionKey={runtimeActionKey}
              runtimeActionPending={controlWorkspaceRuntime.isPending}
              onRuntimeAction={(input) => controlWorkspaceRuntime.mutate(input)}
              onCloseWorkspace={(input) => setClosingWorkspace(input)}
            />
          ))}
        </div>
        {cleanupFailedSummaries.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Cleanup attention needed
            </div>
            <div className="space-y-3">
              {cleanupFailedSummaries.map((summary) => (
                <ProjectWorkspaceSummaryCard
                  key={summary.key}
                  projectRef={projectRef}
                  summary={summary}
                  runtimeActionKey={runtimeActionKey}
                  runtimeActionPending={controlWorkspaceRuntime.isPending}
                  onRuntimeAction={(input) => controlWorkspaceRuntime.mutate(input)}
                  onCloseWorkspace={(input) => setClosingWorkspace(input)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {closingWorkspace ? (
        <ExecutionWorkspaceCloseDialog
          workspaceId={closingWorkspace.id}
          workspaceName={closingWorkspace.name}
          currentStatus={closingWorkspace.status}
          open
          onOpenChange={(open) => {
            if (!open) setClosingWorkspace(null);
          }}
          onClosed={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId, { projectId }) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
            setClosingWorkspace(null);
          }}
        />
      ) : null}
    </>
  );
}
