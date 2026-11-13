import { AsyncLocalStorage } from "node:async_hooks";

type WorkspaceReplay = {
  pluginId: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string;
  executionWorkspaceId: string;
};

const replayContext = new AsyncLocalStorage<WorkspaceReplay>();

export function withPluginWorkspaceReplay<T>(scope: WorkspaceReplay, work: () => T): T {
  return replayContext.run(scope, work);
}

export function isPluginWorkspaceReplay(scope: WorkspaceReplay): boolean {
  const replay = replayContext.getStore();
  return !!replay && replay.pluginId === scope.pluginId && replay.companyId === scope.companyId &&
    replay.projectId === scope.projectId && replay.projectWorkspaceId === scope.projectWorkspaceId &&
    replay.executionWorkspaceId === scope.executionWorkspaceId;
}
