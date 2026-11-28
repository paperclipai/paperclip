import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  plugins,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import type { WorkspaceWorkers } from "../../services/plugin-workspaces.js";

export async function createPluginWorkspaceFixture(
  db: ReturnType<typeof createDb>,
  existingCompanyId?: string,
) {
  const companyId = existingCompanyId ?? randomUUID(),
    agentId = randomUUID(),
    projectId = randomUUID(),
    sourceId = randomUUID(),
    pluginId = randomUUID(),
    issueId = randomUUID(),
    runId = randomUUID();
  if (!existingCompanyId)
    await db.insert(companies).values({
      id: companyId,
      name: "Storage fixture",
      issuePrefix: companyId.slice(0, 8).toUpperCase(),
    });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Worker",
    role: "engineer",
    status: "idle",
    adapterType: "paperclip_runner",
  });
  await db.insert(plugins).values({
    id: pluginId,
    pluginKey: `test.${pluginId}`,
    packageName: "test-storage",
    version: "1.0.0",
    apiVersion: 1,
    status: "ready",
    categories: ["workspace"],
    manifestJson: {
      id: `test.${pluginId}`,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Storage",
      description: "Storage",
      author: "Test",
      categories: ["workspace"],
      capabilities: ["workspaces.manage", "events.subscribe"],
      resourceLifecycle: ["project"],
      workspaceProvider: {
        modes: ["isolated_workspace", "operator_branch"],
        strategies: ["git_worktree"],
      },
      entrypoints: { worker: "./worker.js" },
    },
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Project",
    status: "in_progress",
    executionWorkspacePolicy: {
      enabled: true,
      storageProviderPluginId: pluginId,
    },
  });
  await db.insert(projectWorkspaces).values({
    id: sourceId,
    companyId,
    projectId,
    name: "Repository",
    sourceType: "remote_managed",
    repoUrl: "https://github.com/example/repo.git",
    cwd: null,
    isPrimary: true,
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId: sourceId,
    title: "Task",
    status: "in_progress",
    assigneeAgentId: agentId,
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    issueId,
    invocationSource: "manual",
    status: "running",
  });
  const calls: any[] = [];
  const preparedBranches = new Map<string, string | null>();
  let loseResponse = false,
    dirty = false,
    removed = false,
    loseRemovalResponse = false,
    workspaceRefSuffix = "";
  const workers = {
    getWorker: (id: string) =>
      id === pluginId
        ? { supportedMethods: ["workspaceOperation"] }
        : undefined,
    call: async (_id: string, method: string, params: any) => {
      expect(method).toBe("workspaceOperation");
      expect(params).not.toHaveProperty("lease");
      calls.push(params);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost result");
      }
      if (params.operation.kind === "prepare") {
        removed = false;
        preparedBranches.set(params.executionWorkspaceId, params.operation.branchName ?? null);
        return {
          kind: "prepared",
          binding: {
            pluginId,
            projectId,
            executionWorkspaceId: params.executionWorkspaceId,
            projectWorkspaceId: sourceId,
            sourceRevision: params.operation.source.revision,
            workspaceRef: `checkout:${params.executionWorkspaceId}${workspaceRefSuffix}`,
          },
          branchName: params.operation.branchName,
          baseSha: "a".repeat(40),
          created: true,
          branchCreatedByRuntime: true,
        };
      }
      if (params.operation.kind === "inspect") {
        if (removed) throw new Error("checkout missing");
        return {
          kind: "inspection",
          headSha: "a".repeat(40),
          branchName: preparedBranches.get(params.executionWorkspaceId) ?? "work",
          hasDirtyTrackedFiles: dirty,
          hasUntrackedFiles: false,
          hasLocalOnlyData: false,
          isMergedIntoBase: true,
          remotelyRecoverable: true,
        };
      }
      removed = true;
      if (loseRemovalResponse) {
        loseRemovalResponse = false;
        throw new Error("lost removal response");
      }
      return { kind: "removed" };
    },
  } as unknown as WorkspaceWorkers;
  const input = {
    companyId,
    projectId,
    projectWorkspaceId: sourceId,
    issueId,
    runId,
    agentId,
    responsibleUserId: null,
    existingWorkspaceId: null as string | null,
    mode: "isolated_workspace",
    strategy: "git_worktree",
    branchName: "work",
  };
  return {
    companyId,
    pluginId,
    issueId,
    runId,
    input,
    calls,
    workers,
    relocate: () => {
      workspaceRefSuffix = ":restored";
    },
    loseRemoval: () => {
      loseRemovalResponse = true;
    },
    lose: () => {
      loseResponse = true;
    },
    dirty: () => {
      dirty = true;
    },
  };
}
