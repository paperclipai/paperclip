import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_NAME = "file-browser-example";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (PATH_LIKE_PATTERN.test(normalized) || WINDOWS_DRIVE_PATH_PATTERN.test(normalized))
    && !UUID_PATTERN.test(normalized);
}

function sanitizeWorkspacePath(pathValue: string): string {
  return looksLikePath(pathValue) ? pathValue.trim() : "";
}

function resolveWorkspace(workspacePath: string, requestedPath?: string): string | null {
  const root = path.resolve(workspacePath);
  const resolved = requestedPath ? path.resolve(root, requestedPath) : root;
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    ctx.data.register("workspaces", async (params: Record<string, unknown>) => {
      const projectId = params.projectId as string;
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!projectId || !companyId) return [];
      const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
      return workspaces.map((w) => ({
        id: w.id,
        projectId: w.projectId,
        name: w.name,
        path: sanitizeWorkspacePath(w.path),
        isPrimary: w.isPrimary,
      }));
    });

    ctx.data.register(
      "fileList",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const directoryPath = typeof params.directoryPath === "string" ? params.directoryPath : "";
        if (!projectId || !companyId || !workspaceId) return { entries: [] };
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return { entries: [] };
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) return { entries: [] };
        const dirPath = resolveWorkspace(workspacePath, directoryPath);
        if (!dirPath) {
          return { entries: [] };
        }
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { entries: [] };
        }
        const names = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
        const entries = names.map((name) => {
          const full = path.join(dirPath, name);
          const stat = fs.lstatSync(full);
          const relativePath = path.relative(workspacePath, full);
          return {
            name,
            path: relativePath,
            isDirectory: stat.isDirectory(),
          };
        }).sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { entries };
      },
    );

    ctx.data.register(
      "fileContent",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = params.filePath as string;
        if (!projectId || !companyId || !workspaceId || !filePath) {
          return { content: null, error: "Missing file context" };
        }
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return { content: null, error: "Workspace not found" };
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) return { content: null, error: "Workspace has no path" };
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) {
          return { content: null, error: "Path outside workspace" };
        }
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          return { content };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: null, error: message };
        }
      },
    );

    ctx.actions.register(
      "writeFile",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = params.filePath as string;
        const content = typeof params.content === "string" ? params.content : null;
        if (!projectId || !companyId || !workspaceId) {
          throw new Error("Missing workspace context");
        }
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) {
          throw new Error("Workspace not found");
        }
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) {
          throw new Error("Workspace has no path");
        }
        if (content === null) {
          throw new Error("Missing file content");
        }
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) {
          throw new Error("Path outside workspace");
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
          throw new Error("Selected path is not a file");
        }
        fs.writeFileSync(fullPath, content, "utf-8");
        return {
          ok: true,
          path: filePath,
          bytes: Buffer.byteLength(content, "utf-8"),
        };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
