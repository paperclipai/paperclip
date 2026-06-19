import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { workspaceDiffQuerySchema } from "./contracts.js";
import { workspaceDiffService } from "./workspace-diff.js";

const PLUGIN_NAME = "workspace-diff";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | null {
  const trimmed = readString(value);
  return trimmed || null;
}

export function resolveDefaultBaseRef(input: {
  workspaceBaseRef?: unknown;
  projectWorkspaceDefaultRef?: unknown;
  projectWorkspaceRepoRef?: unknown;
}): string | null {
  return readOptionalString(input.workspaceBaseRef)
    ?? readOptionalString(input.projectWorkspaceDefaultRef)
    ?? readOptionalString(input.projectWorkspaceRepoRef);
}

async function resolveProjectWorkspaceDefaultBaseRef(input: {
  ctx: PluginContext;
  projectId: string;
  companyId: string;
  projectWorkspaceId?: string | null;
}): Promise<string | null> {
  if (!input.projectId) return null;
  const workspaces = await input.ctx.projects.listWorkspaces(input.projectId, input.companyId);
  const projectWorkspace = input.projectWorkspaceId
    ? workspaces.find((candidate) => candidate.id === input.projectWorkspaceId)
    : workspaces.find((candidate) => candidate.isPrimary) ?? workspaces[0] ?? null;
  return projectWorkspace
    ? resolveDefaultBaseRef({
      projectWorkspaceDefaultRef: projectWorkspace.defaultRef,
      projectWorkspaceRepoRef: projectWorkspace.repoRef,
    })
    : null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);
    const workspaceDiff = workspaceDiffService();

    ctx.data.register("workspace-diff", async (params: Record<string, unknown>) => {
      const workspaceId = readString(params.workspaceId);
      const companyId = readString(params.companyId);
      if (!workspaceId || !companyId) {
        throw new Error("workspaceId and companyId are required");
      }

      if (params.entityType === "project_workspace") {
        const projectId = readString(params.projectId);
        if (!projectId) {
          throw new Error("projectId is required for project workspace diffs");
        }
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
        if (!workspace) {
          throw new Error("Workspace not found");
        }
        return workspaceDiff.getDiff({
          id: workspace.id,
          companyId,
          cwd: workspace.path,
          baseRef: resolveDefaultBaseRef({
            projectWorkspaceDefaultRef: workspace.defaultRef,
            projectWorkspaceRepoRef: workspace.repoRef,
          }),
        }, workspaceDiffQuerySchema.parse(params));
      }

      const workspace = await ctx.executionWorkspaces.get(workspaceId, companyId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      let projectWorkspaceDefaultBaseRef: string | null = null;
      if (!readOptionalString(workspace.baseRef)) {
        projectWorkspaceDefaultBaseRef = await resolveProjectWorkspaceDefaultBaseRef({
          ctx,
          projectId: workspace.projectId || readString(params.projectId),
          companyId,
          projectWorkspaceId: workspace.projectWorkspaceId,
        });
      }

      return workspaceDiff.getDiff({
        ...workspace,
        baseRef: resolveDefaultBaseRef({
          workspaceBaseRef: workspace.baseRef,
          projectWorkspaceDefaultRef: projectWorkspaceDefaultBaseRef,
        }),
      }, workspaceDiffQuerySchema.parse(params));
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
