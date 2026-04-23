import path from "node:path";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, ORG_DIRS, PLUGIN_ID, STATE_KEYS, TOOL_NAMES } from "./constants.js";
import {
  createStorageBackend,
  type S3BackendConfig,
  type StorageBackend,
} from "./storage-backend.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginConfig = {
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3Prefix?: string;
  s3ForcePathStyle?: boolean;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  maxFileSizeMb?: number;
  maxTreeDepth?: number;
};

type FileMeta = {
  path: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  size: number;
  tags: string[];
  description: string;
  isDirectory: boolean;
};

type FileIndex = Record<string, FileMeta>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;
let currentBackend: StorageBackend | null = null;

function resolveConfig(raw: Record<string, unknown>): {
  pluginConfig: Required<PluginConfig>;
  s3Config: S3BackendConfig;
} {
  const c = raw as PluginConfig;

  const pluginConfig: Required<PluginConfig> = {
    s3Bucket: c.s3Bucket || DEFAULT_CONFIG.s3Bucket,
    s3Region: c.s3Region || DEFAULT_CONFIG.s3Region,
    s3Endpoint: c.s3Endpoint || DEFAULT_CONFIG.s3Endpoint,
    s3Prefix: c.s3Prefix ?? DEFAULT_CONFIG.s3Prefix,
    s3ForcePathStyle: c.s3ForcePathStyle ?? DEFAULT_CONFIG.s3ForcePathStyle,
    s3AccessKeyId: c.s3AccessKeyId ?? "",
    s3SecretAccessKey: c.s3SecretAccessKey ?? "",
    maxFileSizeMb: c.maxFileSizeMb ?? DEFAULT_CONFIG.maxFileSizeMb,
    maxTreeDepth: c.maxTreeDepth ?? DEFAULT_CONFIG.maxTreeDepth,
  };

  const s3Config: S3BackendConfig = {
    bucket: pluginConfig.s3Bucket,
    region: pluginConfig.s3Region,
    endpoint: pluginConfig.s3Endpoint || undefined,
    prefix: pluginConfig.s3Prefix,
    forcePathStyle: pluginConfig.s3ForcePathStyle,
    accessKeyId: pluginConfig.s3AccessKeyId || undefined,
    secretAccessKey: pluginConfig.s3SecretAccessKey || undefined,
  };

  return { pluginConfig, s3Config };
}

async function getConfigAndBackend(ctx: PluginContext): Promise<{
  config: Required<PluginConfig>;
  backend: StorageBackend;
}> {
  const raw = await ctx.config.get();
  const { pluginConfig, s3Config } = resolveConfig(raw);

  if (!currentBackend) {
    currentBackend = createStorageBackend(s3Config);
  }

  return { config: pluginConfig, backend: currentBackend };
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".xml",
  ".csv", ".tsv", ".html", ".htm", ".css", ".js", ".ts", ".jsx",
  ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".toml", ".ini", ".cfg",
  ".conf", ".log", ".gitignore", ".dockerfile", ".makefile",
  ".rst", ".tex", ".bib", ".r", ".m", ".swift", ".kt", ".scala",
  ".lua", ".pl", ".pm", ".php", ".vue", ".svelte",
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === "" || TEXT_EXTENSIONS.has(ext);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function actorLabel(runCtx: ToolRunContext): string {
  return `agent:${runCtx.agentId}`;
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i").test(name);
}

// ---------------------------------------------------------------------------
// File index (metadata stored in plugin state)
// ---------------------------------------------------------------------------

async function loadIndex(ctx: PluginContext): Promise<FileIndex> {
  const data = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.fileIndex,
  });
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as FileIndex;
  }
  return {};
}

async function saveIndex(ctx: PluginContext, index: FileIndex): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.fileIndex },
    index,
  );
}

// ---------------------------------------------------------------------------
// Tree rendering
// ---------------------------------------------------------------------------

async function buildTree(
  backend: StorageBackend,
  dirPath: string,
  prefix: string,
  depth: number,
  maxDepth: number,
): Promise<string> {
  if (depth > maxDepth) return `${prefix}...\n`;

  let entries: Array<{ name: string; isDir: boolean; size: number }>;
  try {
    entries = await backend.listDir(dirPath);
  } catch {
    return "";
  }

  entries.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  let result = "";
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (entry.isDir) {
      result += `${prefix}${connector}${entry.name}/\n`;
      const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      result += await buildTree(backend, childPath, prefix + childPrefix, depth + 1, maxDepth);
    } else {
      const sizeStr = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
      result += `${prefix}${connector}${entry.name}${sizeStr}\n`;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function registerToolHandlers(ctx: PluginContext): Promise<void> {

  // ---- fs-write ----
  ctx.tools.register(
    TOOL_NAMES.writeFile,
    {
      displayName: "Write File to Shared Store",
      description: "Writes content to a file in the shared S3 store.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf-8", "base64"] },
          tags: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as {
        path?: string;
        content?: string;
        encoding?: "utf-8" | "base64";
        tags?: string[];
        description?: string;
        overwrite?: boolean;
      };

      if (!input.path) return { error: "path is required" };
      if (input.content === undefined) return { error: "content is required" };

      const { config, backend } = await getConfigAndBackend(ctx);

      const encoding = input.encoding ?? "utf-8";
      const buf = encoding === "base64"
        ? Buffer.from(input.content, "base64")
        : Buffer.from(input.content, "utf-8");

      const maxBytes = config.maxFileSizeMb * 1024 * 1024;
      if (buf.length > maxBytes) {
        return { error: `File exceeds maximum size of ${config.maxFileSizeMb} MB` };
      }

      const overwrite = input.overwrite !== false;
      if (!overwrite) {
        const fileExists = await backend.exists(input.path);
        if (fileExists) {
          return { error: `File already exists: ${input.path}. Set overwrite=true to replace.` };
        }
      }

      try {
        await backend.writeFile(input.path, buf);
      } catch (err) {
        return { error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const index = await loadIndex(ctx);
      const now = new Date().toISOString();
      const existing = index[input.path];

      index[input.path] = {
        path: input.path,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        createdBy: existing?.createdBy ?? actorLabel(runCtx),
        updatedBy: actorLabel(runCtx),
        size: buf.length,
        tags: input.tags ?? existing?.tags ?? [],
        description: input.description ?? existing?.description ?? "",
        isDirectory: false,
      };
      await saveIndex(ctx, index);

      await ctx.metrics.write("filestore.write", 1, { ext: path.extname(input.path) || "none" });
      ctx.logger.info("File written", { path: input.path, size: buf.length });

      return {
        content:
          `File written successfully.\n` +
          `- **Path:** ${input.path}\n` +
          `- **Size:** ${formatBytes(buf.length)}\n` +
          `- **Backend:** S3`,
        data: { path: input.path, size: buf.length },
      };
    },
  );

  // ---- fs-read ----
  ctx.tools.register(
    TOOL_NAMES.readFile,
    {
      displayName: "Read File from Shared Store",
      description: "Reads a file from the shared store.",
      parametersSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as { path?: string };
      if (!input.path) return { error: "path is required" };

      const { backend } = await getConfigAndBackend(ctx);

      let buf: Buffer;
      try {
        buf = await backend.readFile(input.path);
      } catch (err) {
        return { error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
      }

      await ctx.metrics.write("filestore.read", 1, {});

      if (isTextFile(input.path)) {
        return {
          content: buf.toString("utf-8"),
          data: { path: input.path, size: buf.length, encoding: "utf-8" },
        };
      }

      return {
        content: `Binary file (${formatBytes(buf.length)}). Content returned as base64 in data.content.`,
        data: {
          path: input.path,
          size: buf.length,
          encoding: "base64",
          content: buf.toString("base64"),
        },
      };
    },
  );

  // ---- fs-list ----
  ctx.tools.register(
    TOOL_NAMES.listDir,
    {
      displayName: "List Directory Contents",
      description: "Lists files and subdirectories at a given path.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as { path?: string; recursive?: boolean };
      const dirPath = (input.path || "").replace(/^\/+/, "");

      const { backend } = await getConfigAndBackend(ctx);

      if (input.recursive) {
        try {
          const all = await backend.listRecursive(dirPath);
          const lines = all.map((f) => `${f.isDir ? "📁" : "📄"} ${f.relative}`);
          return {
            content: lines.length > 0
              ? lines.join("\n")
              : `Directory is empty: ${dirPath || "/"}`,
            data: { count: all.length, entries: all },
          };
        } catch (err) {
          return { error: `Cannot list: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      let entries: Array<{ name: string; isDir: boolean; size: number }>;
      try {
        entries = await backend.listDir(dirPath);
      } catch (err) {
        return { error: `Cannot list directory: ${err instanceof Error ? err.message : String(err)}` };
      }

      entries.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });

      const index = await loadIndex(ctx);
      const lines: string[] = [];
      const items: Array<{ name: string; type: string; size?: number; tags?: string[] }> = [];

      for (const entry of entries) {
        const rel = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        const meta = index[rel];

        if (entry.isDir) {
          lines.push(`📁 ${entry.name}/`);
          items.push({ name: entry.name, type: "directory" });
        } else {
          const tagsStr = meta?.tags?.length ? ` [${meta.tags.join(", ")}]` : "";
          lines.push(`📄 ${entry.name} (${formatBytes(entry.size)})${tagsStr}`);
          items.push({ name: entry.name, type: "file", size: entry.size, tags: meta?.tags });
        }
      }

      return {
        content: lines.length > 0
          ? `Contents of **${dirPath || "/"}**:\n\n${lines.join("\n")}`
          : `Directory is empty: ${dirPath || "/"}`,
        data: { path: dirPath || "/", count: items.length, entries: items },
      };
    },
  );

  // ---- fs-tree ----
  ctx.tools.register(
    TOOL_NAMES.treeDir,
    {
      displayName: "Show Directory Tree",
      description: "Displays a visual tree of the store hierarchy.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxDepth: { type: "number" },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as { path?: string; maxDepth?: number };
      const dirPath = (input.path || "").replace(/^\/+/, "");

      const { config, backend } = await getConfigAndBackend(ctx);
      const maxDepth = input.maxDepth ?? config.maxTreeDepth;

      const tree = await buildTree(backend, dirPath, "", 0, maxDepth);
      const label = dirPath || ".";

      if (!tree) {
        return { content: `${label}/ (empty)` };
      }

      return {
        content: `${label}/\n${tree}`,
        data: { path: dirPath || "/" },
      };
    },
  );

  // ---- fs-mkdir ----
  ctx.tools.register(
    TOOL_NAMES.mkdir,
    {
      displayName: "Create Directory",
      description: "Creates a directory (and any missing parents) in the shared store.",
      parametersSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { path?: string };
      if (!input.path) return { error: "path is required" };

      const { backend } = await getConfigAndBackend(ctx);

      try {
        await backend.mkdir(input.path);
      } catch (err) {
        return { error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const index = await loadIndex(ctx);
      const now = new Date().toISOString();

      if (!index[input.path]) {
        index[input.path] = {
          path: input.path,
          createdAt: now,
          updatedAt: now,
          createdBy: actorLabel(runCtx),
          updatedBy: actorLabel(runCtx),
          size: 0,
          tags: [],
          description: "",
          isDirectory: true,
        };
        await saveIndex(ctx, index);
      }

      ctx.logger.info("Directory created", { path: input.path });
      return { content: `Directory created: **${input.path}**`, data: { path: input.path } };
    },
  );

  // ---- fs-move ----
  ctx.tools.register(
    TOOL_NAMES.move,
    {
      displayName: "Move / Rename",
      description: "Moves or renames a file or directory within the shared store.",
      parametersSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { from?: string; to?: string };
      if (!input.from || !input.to) return { error: "from and to are required" };

      const { backend } = await getConfigAndBackend(ctx);

      try {
        await backend.move(input.from, input.to);
      } catch (err) {
        return { error: `Move failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const index = await loadIndex(ctx);
      const now = new Date().toISOString();

      const keysToMove = Object.keys(index).filter(
        (k) => k === input.from || k.startsWith(input.from + "/"),
      );

      for (const oldKey of keysToMove) {
        const newKey = input.to + oldKey.slice(input.from!.length);
        const meta = index[oldKey];
        delete index[oldKey];
        index[newKey] = {
          ...meta,
          path: newKey,
          updatedAt: now,
          updatedBy: actorLabel(runCtx),
        };
      }

      await saveIndex(ctx, index);
      ctx.logger.info("Moved", { from: input.from, to: input.to });

      return {
        content: `Moved **${input.from}** → **${input.to}**`,
        data: { from: input.from, to: input.to },
      };
    },
  );

  // ---- fs-remove ----
  ctx.tools.register(
    TOOL_NAMES.remove,
    {
      displayName: "Remove File or Directory",
      description: "Removes a file or directory from the shared store.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const input = params as { path?: string; recursive?: boolean };
      if (!input.path) return { error: "path is required" };

      const { backend } = await getConfigAndBackend(ctx);

      try {
        await backend.remove(input.path, !!input.recursive);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      const index = await loadIndex(ctx);
      const keysToRemove = Object.keys(index).filter(
        (k) => k === input.path || k.startsWith(input.path + "/"),
      );
      for (const key of keysToRemove) {
        delete index[key];
      }
      await saveIndex(ctx, index);

      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "file-store",
        message: `Removed "${input.path}" from shared file store`,
        metadata: { plugin: PLUGIN_ID, actor: actorLabel(runCtx) },
      });

      ctx.logger.info("Removed", { path: input.path });
      return { content: `Removed: **${input.path}**`, data: { path: input.path, removed: keysToRemove.length } };
    },
  );

  // ---- fs-stat ----
  ctx.tools.register(
    TOOL_NAMES.stat,
    {
      displayName: "Get File / Directory Info",
      description: "Returns metadata about a file or directory.",
      parametersSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as { path?: string };
      if (!input.path) return { error: "path is required" };

      const { backend } = await getConfigAndBackend(ctx);

      const fsStat = await backend.stat(input.path);
      if (!fsStat) return { error: `Not found: ${input.path}` };

      const index = await loadIndex(ctx);
      const meta = index[input.path];

      const info = {
        path: input.path,
        type: fsStat.isDir ? "directory" : "file",
        size: fsStat.size,
        sizeHuman: formatBytes(fsStat.size),
        createdAt: meta?.createdAt ?? fsStat.mtime.toISOString(),
        updatedAt: meta?.updatedAt ?? fsStat.mtime.toISOString(),
        createdBy: meta?.createdBy ?? "unknown",
        updatedBy: meta?.updatedBy ?? "unknown",
        tags: meta?.tags ?? [],
        description: meta?.description ?? "",
      };

      const lines = [
        `**Path:** ${info.path}`,
        `**Type:** ${info.type}`,
        `**Size:** ${info.sizeHuman}`,
        `**Created:** ${info.createdAt} by ${info.createdBy}`,
        `**Updated:** ${info.updatedAt} by ${info.updatedBy}`,
      ];
      if (info.tags.length > 0) lines.push(`**Tags:** ${info.tags.join(", ")}`);
      if (info.description) lines.push(`**Description:** ${info.description}`);

      return { content: lines.join("\n"), data: info };
    },
  );

  // ---- fs-search ----
  ctx.tools.register(
    TOOL_NAMES.search,
    {
      displayName: "Search Files in Store",
      description: "Searches for files by name pattern, tags, or query.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          namePattern: { type: "string" },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const input = params as {
        query?: string;
        tags?: string[];
        path?: string;
        namePattern?: string;
      };

      const index = await loadIndex(ctx);
      let results = Object.values(index);

      if (input.path) {
        const prefix = input.path.replace(/^\/+/, "").replace(/\/+$/, "");
        results = results.filter((m) => m.path.startsWith(prefix + "/") || m.path === prefix);
      }

      if (input.tags && input.tags.length > 0) {
        const requiredTags = input.tags.map((t) => t.toLowerCase());
        results = results.filter((m) =>
          requiredTags.every((t) => m.tags.some((mt) => mt.toLowerCase() === t)),
        );
      }

      if (input.namePattern) {
        results = results.filter((m) => matchGlob(path.basename(m.path), input.namePattern!));
      }

      if (input.query) {
        const q = input.query.toLowerCase();
        results = results.filter(
          (m) =>
            m.path.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.tags.some((t) => t.toLowerCase().includes(q)),
        );
      }

      results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const limited = results.slice(0, 50);

      if (limited.length === 0) {
        return { content: "No files found matching the search criteria.", data: { count: 0, results: [] } };
      }

      const lines = limited.map((m) => {
        const tagsStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        const icon = m.isDirectory ? "📁" : "📄";
        return `${icon} **${m.path}** (${formatBytes(m.size)})${tagsStr}`;
      });

      return {
        content:
          `Found **${results.length}** result(s)` +
          (results.length > 50 ? " (showing first 50)" : "") +
          `:\n\n${lines.join("\n")}`,
        data: { count: results.length, results: limited },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("Shared File Store plugin initializing (S3-only mode)");

    const raw = await ctx.config.get();
    const { pluginConfig, s3Config } = resolveConfig(raw);

    currentBackend = createStorageBackend(s3Config);

    ctx.logger.info("S3 backend configured", {
      bucket: pluginConfig.s3Bucket,
      endpoint: pluginConfig.s3Endpoint,
      prefix: pluginConfig.s3Prefix,
    });

    await registerToolHandlers(ctx);
    ctx.logger.info("Shared File Store plugin ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "degraded", message: "Plugin context not initialized" };
    }

    const raw = await ctx.config.get();
    const { pluginConfig } = resolveConfig(raw);
    const backend = currentBackend;

    if (!backend) {
      return { status: "degraded", message: "Storage backend not initialized" };
    }

    const healthy = await backend.healthy();
    const index = await loadIndex(ctx);
    const fileCount = Object.values(index).filter((m) => !m.isDirectory).length;
    const dirCount = Object.values(index).filter((m) => m.isDirectory).length;

    return {
      status: healthy ? "ok" : "degraded",
      message: healthy
        ? `S3 store active: ${fileCount} file(s), ${dirCount} folder(s)`
        : `S3 backend not accessible (bucket: ${pluginConfig.s3Bucket})`,
      details: {
        bucket: pluginConfig.s3Bucket,
        endpoint: pluginConfig.s3Endpoint,
        prefix: pluginConfig.s3Prefix,
        fileCount,
        dirCount,
        healthy,
      },
    };
  },

  async onConfigChanged(newConfig) {
    const ctx = currentContext;
    if (!ctx) return;

    const { pluginConfig, s3Config } = resolveConfig(newConfig as Record<string, unknown>);
    currentBackend = createStorageBackend(s3Config);

    ctx.logger.info("File Store config updated — S3 backend recreated", {
      bucket: pluginConfig.s3Bucket,
      endpoint: pluginConfig.s3Endpoint,
    });
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const typed = config as PluginConfig;

    if (!typed.s3Bucket) {
      errors.push("s3Bucket is required");
    }
    if (!typed.s3Region) {
      warnings.push("s3Region not set — defaulting to us-east-1");
    }

    if (typed.maxFileSizeMb !== undefined) {
      if (typeof typed.maxFileSizeMb !== "number" || typed.maxFileSizeMb < 1) {
        errors.push("maxFileSizeMb must be a positive number");
      }
      if (typed.maxFileSizeMb > 500) {
        warnings.push("maxFileSizeMb > 500 allows very large files");
      }
    }

    if (typed.maxTreeDepth !== undefined) {
      if (typeof typed.maxTreeDepth !== "number" || typed.maxTreeDepth < 1) {
        errors.push("maxTreeDepth must be a positive number");
      }
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onShutdown() {
    const ctx = currentContext;
    if (ctx) {
      ctx.logger.info("Shared File Store plugin shutting down");
    }
    currentBackend = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
