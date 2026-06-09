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

/**
 * Regex that matches file-path-like tokens in comment text.
 * Captures tokens that either start with `.` `/` `~` or contain a `/`
 * (directory separator), plus bare words that could be filenames with
 * extensions (e.g. `README.md`).  The file-extension check in
 * `extractFilePaths` filters out non-file matches.
 */
const FILE_PATH_REGEX = /(?:^|[\s(`"'])([^\s,;)}`"'>\]]*\/[^\s,;)}`"'>\]]+|[.\/~][^\s,;)}`"'>\]]+|[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,10}(?:\/[^\s,;)}`"'>\]]+)?)/g;

/** Common file extensions to recognise path-like tokens as actual file references. */
const FILE_EXTENSION_REGEX = /\.[a-zA-Z0-9]{1,10}$/;

/**
 * Tokens that look like paths but are almost certainly URL route segments
 * (e.g. `/projects/abc`, `/settings`, `/dashboard`).
 */
const URL_ROUTE_PATTERN = /^\/(?:projects|issues|agents|settings|dashboard|plugins|api|auth|admin)\b/i;

function extractFilePaths(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(FILE_PATH_REGEX)) {
    const raw = match[1];
    // Strip trailing punctuation that isn't part of a path
    const cleaned = raw.replace(/[.:,;!?)]+$/, "");
    if (cleaned.length <= 1) continue;
    // Must have a file extension (e.g. .ts, .json, .md)
    if (!FILE_EXTENSION_REGEX.test(cleaned)) continue;
    // Skip things that look like URL routes
    if (URL_ROUTE_PATTERN.test(cleaned)) continue;
    paths.add(cleaned);
  }
  return [...paths];
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // Expose the current plugin config so UI components can read operator
    // settings from the canonical instance config store.
    ctx.data.register("plugin-config", async () => {
      const config = await ctx.config.get();
      return {
        showFilesInSidebar: config?.showFilesInSidebar === true,
        commentAnnotationMode: config?.commentAnnotationMode ?? "both",
      };
    });

    // Fetch a comment by ID and extract file-path-like tokens from its body.
    ctx.data.register("comment-file-links", async (params: Record<string, unknown>) => {
      const commentId = typeof params.commentId === "string" ? params.commentId : "";
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!commentId || !issueId || !companyId) return { links: [] };
      try {
        const comments = await ctx.issues.listComments(issueId, companyId);
        const comment = comments.find((c) => c.id === commentId);
        if (!comment?.body) return { links: [] };
        return { links: extractFilePaths(comment.body) };
      } catch (err) {
        ctx.logger.warn("Failed to fetch comment for file link extraction", { commentId, error: String(err) });
        return { links: [] };
      }
    });

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

    async function readFileList(params: Record<string, unknown>) {
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
    }

    ctx.data.register("fileList", readFileList);

    // Mirror `fileList` as an action so the UI can lazily fetch directory
    // children on tree expand without spawning a usePluginData hook per dir.
    ctx.actions.register("loadFileList", readFileList);

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
        const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
        if (!filePath) {
          throw new Error("filePath must be a non-empty string");
        }
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
