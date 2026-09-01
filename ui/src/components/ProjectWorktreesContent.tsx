import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorktree } from "@paperclipai/shared";
import { executionWorktreesApi } from "../api/execution-worktrees";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import type { ProjectWorktreeSummary } from "../lib/project-worktrees-tab";
import { ExecutionWorktreeCloseDialog } from "./ExecutionWorktreeCloseDialog";
import { ProjectWorktreeSummaryCard } from "./ProjectWorktreeSummaryCard";

export function ProjectWorktreesContent({
  companyId,
  projectId,
  projectRef,
  summaries,
}: {
  companyId: string;
  projectId: string;
  projectRef: string;
  summaries: ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const [runtimeActionKey, setRuntimeActionKey] = useState<string | null>(null);
  const [closingWorktree, setClosingWorktree] = useState<{
    id: string;
    name: string;
    status: ExecutionWorktree["status"];
  } | null>(null);
  const controlWorktreeRuntime = useMutation({
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
      return await executionWorktreesApi.controlRuntimeServices(input.workspaceId, input.action);
    },
    onSettled: () => {
      setRuntimeActionKey(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.overview(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.list(companyId, { projectId }) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
    },
  });

  if (summaries.length === 0) {
    return <p className="text-sm text-muted-foreground">No non-default worktree activity yet.</p>;
  }

  const activeSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus !== "cleanup_failed");
  const cleanupFailedSummaries = summaries.filter((summary) => summary.executionWorkspaceStatus === "cleanup_failed");

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-3">
          {activeSummaries.map((summary) => (
            <ProjectWorktreeSummaryCard
              key={summary.key}
              projectRef={projectRef}
              summary={summary}
              runtimeActionKey={runtimeActionKey}
              runtimeActionPending={controlWorktreeRuntime.isPending}
              onRuntimeAction={(input) => controlWorktreeRuntime.mutate(input)}
              onCloseWorkspace={(input) => setClosingWorktree(input)}
            />
          ))}
        </div>
        {cleanupFailedSummaries.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
              Cleanup attention needed
            </div>
            <div className="space-y-3">
              {cleanupFailedSummaries.map((summary) => (
                <ProjectWorktreeSummaryCard
                  key={summary.key}
                  projectRef={projectRef}
                  summary={summary}
                  runtimeActionKey={runtimeActionKey}
                  runtimeActionPending={controlWorktreeRuntime.isPending}
                  onRuntimeAction={(input) => controlWorktreeRuntime.mutate(input)}
                  onCloseWorkspace={(input) => setClosingWorktree(input)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {closingWorktree ? (
        <ExecutionWorktreeCloseDialog
          workspaceId={closingWorktree.id}
          workspaceName={closingWorktree.name}
          currentStatus={closingWorktree.status}
          open
          onOpenChange={(open) => {
            if (!open) setClosingWorktree(null);
          }}
          onClosed={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.overview(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorktrees.list(companyId, { projectId }) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
            setClosingWorktree(null);
          }}
        />
      ) : null}
    </>
  );
}
